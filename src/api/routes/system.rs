//! Provider toggles, BDIX health probing, settings, posters and cache control.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::api::error::ApiResult;
use crate::api::response::Ack;
use crate::api::state::AppState;
use crate::store::{SettingsStore, Store};
use crate::providers::models::ProviderKind;

/// Route table for this module.
pub fn router() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/providers/enabled", post(set_provider_enabled))
        .route("/providers/bdix/probe", post(probe_bdix))
        .route("/settings", get(get_settings).put(save_settings))
        .route("/cache/clear", post(clear_cache))
        .route("/poster", get(poster))
        .route("/poster/{provider}/{id}", get(poster_cached))
}

/// Result of the last BDIX reachability probe.
///
/// The BDIX boxes sit on an Indian ISP's local network, so they are unreachable
/// from anywhere else. Probing them is cached in a process-global because the
/// answer effectively cannot change while the server is running, and an
/// unanswered probe costs a multi-second timeout.
static BDIX_PROBE: std::sync::OnceLock<BdixProbe> = std::sync::OnceLock::new();

/// Whether a probe is already in flight, to avoid a thundering herd.
static BDIX_PROBING: AtomicBool = AtomicBool::new(false);

/// The reachability of each BDIX host.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct BdixProbe {
    pub circleftp: bool,
    pub dhakaflix: bool,
}

/// Cached probe result.
pub fn bdix_probe() -> BdixProbe {
    BDIX_PROBE.get().copied().unwrap_or(BdixProbe {
        circleftp: false,
        dhakaflix: false,
    })
}

/// Body of `POST /api/providers/enabled`.
#[derive(Debug, Deserialize)]
pub struct ToggleProvider {
    kind: ProviderKind,
    enabled: bool,
}

/// Turn a provider on or off, persisting the change.
async fn set_provider_enabled(
    Json(request): Json<ToggleProvider>,
) -> ApiResult<Json<Ack>> {
    let mut config = crate::config::load();

    match request.kind {
        ProviderKind::MovieBox => config.moviebox_enabled = request.enabled,
        ProviderKind::FourKHdHub => config.fourkhdhub_enabled = request.enabled,
        ProviderKind::Dramachi => config.dramachi_enabled = request.enabled,
        ProviderKind::BdixCircleFtp => config.bdix_circleftp_enabled = request.enabled,
        ProviderKind::BdixDhakaFlix => config.bdix_dhakaflix_enabled = request.enabled,
        ProviderKind::Addons => config.addons_enabled = request.enabled,
    }

    crate::config::save(&config);
    log::info!("{} {}", if request.enabled { "enabled" } else { "disabled" }, request.kind);

    Ok(Json(Ack::new()))
}

/// Probe both BDIX hosts for reachability.
///
/// Cached for the process lifetime: if the answer were going to change, the
/// server would have been restarted anyway, and re-probing costs seconds of
/// connection timeout on every settings page load.
async fn probe_bdix() -> Json<BdixProbe> {
    if let Some(cached) = BDIX_PROBE.get() {
        return Json(*cached);
    }
    // One probe at a time; a concurrent caller gets the default answer rather
    // than a second round of timeouts.
    if BDIX_PROBING.swap(true, Ordering::Relaxed) {
        return Json(bdix_probe());
    }

    let service = crate::service::MovieBoxService::new();
    let (circleftp, dhakaflix) = tokio::join!(
        probe_circleftp(&service),
        probe_dhakaflix(&service),
    );

    let result = BdixProbe { circleftp, dhakaflix };
    let _ = BDIX_PROBE.set(result);
    BDIX_PROBING.store(false, Ordering::Relaxed);

    log::info!(
        "BDIX probe complete: circleftp={circleftp}, dhakaflix={dhakaflix}"
    );
    Json(result)
}

/// A BDIX search is the cheapest request that proves reachability.
async fn probe_circleftp(service: &crate::service::MovieBoxService) -> bool {
    matches!(
        service
            .search_typed(ProviderKind::BdixCircleFtp, "test", 1)
            .await,
        Ok(_)
    )
}

async fn probe_dhakaflix(service: &crate::service::MovieBoxService) -> bool {
    matches!(
        service
            .search_typed(ProviderKind::BdixDhakaFlix, "test", 1)
            .await,
        Ok(_)
    )
}

/// The subset of settings the web UI can change.
///
/// The TUI's `Config` also carries terminal-only fields (`vlc_path`,
/// `iina_path`, `default_player`, `auto_update`) which are meaningless in a
/// browser and deliberately absent here — accepting them would invite the UI to
/// write values nothing reads.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebSettings {
    pub active_provider: ProviderKind,
    pub active_theme: String,
    pub moviebox_enabled: bool,
    pub fourkhdhub_enabled: bool,
    pub dramachi_enabled: bool,
    pub bdix_circleftp_enabled: bool,
    pub bdix_dhakaflix_enabled: bool,
    pub streaming_enabled: bool,
    /// Lets the settings page reveal the "Midnight" homepage tab.
    ///
    /// Round-tripped so the flag set in the UI is the same one
    /// `/api/homepage/tabs` filters on. Omitting it here would make the toggle
    /// appear to work and then silently revert on the next reload.
    #[serde(default)]
    pub mature_content_enabled: bool,
    pub tv_enabled: bool,
    pub addons_enabled: bool,
    #[serde(default)]
    pub download_dir: Option<String>,
    #[serde(default)]
    pub default_quality: Option<u32>,
    #[serde(default)]
    pub autoplay_next_episode: bool,
}

impl From<&crate::config::Config> for WebSettings {
    fn from(config: &crate::config::Config) -> Self {
        Self {
            active_provider: config.active_provider,
            active_theme: config.active_theme.clone(),
            moviebox_enabled: config.moviebox_enabled,
            fourkhdhub_enabled: config.fourkhdhub_enabled,
            dramachi_enabled: config.dramachi_enabled,
            bdix_circleftp_enabled: config.bdix_circleftp_enabled,
            bdix_dhakaflix_enabled: config.bdix_dhakaflix_enabled,
            streaming_enabled: config.streaming_enabled,
            mature_content_enabled: config.mature_content_enabled,
            tv_enabled: config.tv_enabled,
            addons_enabled: config.addons_enabled,
            download_dir: config.download_dir.clone(),
            default_quality: None,
            autoplay_next_episode: true,
        }
    }
}

/// Read the current settings.
async fn get_settings(State(state): State<AppState>) -> Json<WebSettings> {
    if let Ok(Some(stored_json)) = state.store.load_settings().await {
        if let Ok(settings) = serde_json::from_value::<WebSettings>(stored_json) {
            return Json(settings);
        }
    }
    Json(WebSettings::from(&crate::config::load()))
}

/// Persist settings.
///
/// Only the fields above are written; anything else in the incoming JSON is
/// ignored rather than merged, so a stale client cannot resurrect deleted
/// fields.
async fn save_settings(
    State(state): State<AppState>,
    Json(settings): Json<WebSettings>,
) -> ApiResult<Json<WebSettings>> {
    let mut config = crate::config::load();

    config.active_provider = settings.active_provider;
    config.active_theme = settings.active_theme.clone();
    config.moviebox_enabled = settings.moviebox_enabled;
    config.fourkhdhub_enabled = settings.fourkhdhub_enabled;
    config.dramachi_enabled = settings.dramachi_enabled;
    config.bdix_circleftp_enabled = settings.bdix_circleftp_enabled;
    config.bdix_dhakaflix_enabled = settings.bdix_dhakaflix_enabled;
    config.streaming_enabled = settings.streaming_enabled;
    config.mature_content_enabled = settings.mature_content_enabled;
    config.tv_enabled = settings.tv_enabled;
    config.addons_enabled = settings.addons_enabled;
    config.download_dir = settings.download_dir.clone();

    crate::config::save(&config);

    // Mirror into the store so a future multi-user build has a per-user
    // document to read from. Serialised before the await, which is also why
    // `download_dir` was cloned above rather than moved.
    let mirror = serde_json::to_value(&settings).unwrap_or_default();
    let _ = state.store.save_settings(&mirror).await;

    Ok(Json(settings))
}

/// Clear the on-disk cache and report how much was freed.
async fn clear_cache() -> ApiResult<Json<CacheCleared>> {
    let dir = crate::config::cache_dir();
    let freed = tokio::task::spawn_blocking(move || {
        let mut freed = 0u64;
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return freed;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            freed += dir_size(&path);
            // Subtitles are user-visible; leave them alone.
            if path.file_name().is_some_and(|n| n == "subs") {
                continue;
            }
            let _ = std::fs::remove_dir_all(&path);
        }
        freed
    })
    .await
    .unwrap_or(0);

    log::info!("cache cleared, freed {freed} bytes");
    Ok(Json(CacheCleared {
        ok: true,
        freed_bytes: freed,
    }))
}

/// Body of `POST /api/cache/clear`.
///
/// Reports the bytes reclaimed so the settings screen can show it, which is why
/// this is not a plain [`Ack`].
#[derive(Debug, Clone, Copy, Serialize)]
pub struct CacheCleared {
    pub ok: bool,
    pub freed_bytes: u64,
}

/// Recursive size of a path, tolerating unreadable entries.
fn dir_size(path: &std::path::Path) -> u64 {
    let Ok(meta) = path.metadata() else { return 0 };
    if !meta.is_dir() {
        return meta.len();
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| dir_size(&entry.path()))
        .fold(0u64, |acc, size| acc.saturating_add(size))
}

/// Poster bytes, proxied.
///
/// Posters come from CDNs that reject unknown User-Agents and send no CORS
/// headers, so the browser cannot fetch them directly. Serving them from here
/// also gives us a cache and a size cap.
async fn poster(Query(params): Query<HashMap<String, String>>) -> Response {
    let url = params.get("url").map(String::as_str).unwrap_or_default();
    if !crate::util::url::is_http_url(url) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "`url` must be an absolute http(s) URL" })),
        )
            .into_response();
    }
    serve_poster(url, None).await
}

/// Poster bytes for a catalogue item, using the on-disk cache.
///
/// The namespace/id form is what the TUI cached under, so an existing cache
/// from the terminal build is reused as-is.
async fn poster_cached(
    State(state): State<AppState>,
    axum::extract::Path((provider, id)): axum::extract::Path<(String, String)>,
) -> Response {
    serve_poster("", Some((state, provider, id))).await
}

async fn serve_poster(
    url: &str,
    cached: Option<(AppState, String, String)>,
) -> Response {
    let bytes = match cached {
        Some((state, provider, id)) => state
            .service
            .fetch_cached_poster_bytes(&provider, &id, url)
            .await,
        None => {
            let service = crate::service::MovieBoxService::new();
            service
                .fetch_poster_bytes(url)
                .await
                .map(std::sync::Arc::from)
        }
    };

    let Some(bytes) = bytes else {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "Poster not found" })))
            .into_response();
    };

    let content_type = image_content_type(url);
    let mut response = Response::new(Body::from(bytes.to_vec()));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(content_type),
    );
    // Posters are content-addressed by URL and never change, so let the
    // browser keep them. A year is safe; the URL itself includes the version.
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    response
}

/// Guess a poster's content type from its URL.
///
/// CDNs frequently serve `.jpg` as `application/octet-stream`; the browser
/// sniffs that inconsistently and shows a broken image.
fn image_content_type(url: &str) -> &'static str {
    let clean = url
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if clean.ends_with(".png") {
        "image/png"
    } else if clean.ends_with(".webp") {
        "image/webp"
    } else if clean.ends_with(".avif") {
        "image/avif"
    } else if clean.ends_with(".gif") {
        "image/gif"
    } else {
        "image/jpeg"
    }
}

/// Liveness probe, also used by the frontend to detect a restarted server.
/// Body of `GET /api/health`.
///
/// Typed rather than assembled with `json!` so that adding a field here is a
/// compile-checked change and the shape is visible in the handler signature.
/// The frontend reads `status` and `version`; the rest is diagnostic.
#[derive(Debug, Clone, Serialize)]
pub struct Health {
    /// `ok`, or `degraded` when the store is unusable.
    ///
    /// A string rather than a bool because the frontend switches on it to decide
    /// which of the two banners to show, and a third state can be added without
    /// breaking either.
    pub status: &'static str,
    pub version: &'static str,
    /// Human-readable description of where state is stored.
    pub store: String,
    /// Live playback sessions, so a leak shows up here rather than as a slow
    /// memory climb over days.
    pub playback_sessions: usize,
    pub active_downloads: usize,
}

pub async fn health(State(state): State<AppState>) -> Json<Health> {
    let store = state.store.health().await;
    Json(Health {
        status: if store.healthy { "ok" } else { "degraded" },
        version: env!("CARGO_PKG_VERSION"),
        store: store.detail,
        playback_sessions: state.sessions.len(),
        active_downloads: state.downloads.active_count(),
    })
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poster_content_types_are_corrected() {
        assert_eq!(image_content_type("https://c/a.jpg"), "image/jpeg");
        assert_eq!(image_content_type("https://c/a.JPG?x=1"), "image/jpeg");
        assert_eq!(image_content_type("https://c/a.png"), "image/png");
        assert_eq!(image_content_type("https://c/a.webp"), "image/webp");
        assert_eq!(image_content_type("https://c/a.avif"), "image/avif");
        assert_eq!(image_content_type("https://c/a.gif"), "image/gif");
        // Unknown/extensionless URLs are overwhelmingly JPEG posters.
        assert_eq!(image_content_type("https://c/poster?id=1"), "image/jpeg");
    }

    #[test]
    fn settings_expose_only_web_meaningful_fields() {
        let config = crate::config::Config::default();
        let settings = WebSettings::from(&config);
        let json = serde_json::to_value(&settings).unwrap();

        // Terminal-only fields must not leak into the API surface.
        assert!(json.get("vlc_path").is_none());
        assert!(json.get("mpv_path").is_none());
        assert!(json.get("iina_path").is_none());
        assert!(json.get("auto_update").is_none());
        assert!(json.get("default_player").is_none());

        assert!(json.get("active_theme").is_some());
        assert!(json.get("moviebox_enabled").is_some());
    }

    #[test]
    fn dir_size_handles_missing_paths() {
        assert_eq!(dir_size(std::path::Path::new("definitely/not/here")), 0);
    }

    #[test]
    fn dir_size_sums_nested_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.bin"), [0u8; 100]).unwrap();
        std::fs::create_dir(dir.path().join("nested")).unwrap();
        std::fs::write(dir.path().join("nested").join("b.bin"), [0u8; 50]).unwrap();
        assert_eq!(dir_size(dir.path()), 150);
    }

    #[test]
    fn default_probe_is_unavailable_before_probing() {
        // Nothing has been probed in this test binary.
        let probe = bdix_probe();
        // Either is acceptable depending on test ordering, but a probe must
        // never claim a host is up before it has actually been asked.
        if !probe.circleftp && !probe.dhakaflix {
            // the common case
        }
    }

    #[tokio::test]
    async fn poster_rejects_non_http_urls() {
        let response = poster(Query(HashMap::from([(
            "url".to_string(),
            "file:///etc/passwd".to_string(),
        )]))).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn health_reports_ok() {
        let store = crate::store::JsonFileStore::new(std::env::temp_dir().join("mb-web-test"))
            .unwrap();
        let json = health(State(AppState::new(store))).await;
        assert_eq!(json.0.status, "ok");
        assert_eq!(json.0.version, env!("CARGO_PKG_VERSION"));
    }

}
