//! Live TV and addon management routes.
//!
//! Both features are read-mostly and small enough to share a module; they are
//! grouped because they are both "extra content sources" rather than part of the
//! movie catalogue path.

use axum::extract::{Path, Query, State};
use axum::routing::{delete, get, post};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::api::error::{ApiError, ApiResult};
use crate::api::response::Ack;
use crate::api::state::AppState;
use crate::providers::addons::models::InstalledAddon;
use crate::providers::addons::AddonClient;
use crate::providers::models::CatalogItem;
use crate::providers::tv::models::Channel;
use crate::providers::tv::parser::M3UParser;
use crate::store::Store as _;

/// Route table for this module.
///
/// Paths here are dictated by `web/src/lib/api.ts` — that file is the
/// contract, and `tests/api_contract.rs` fails the build if the two drift.
pub fn router() -> axum::Router<AppState> {
    axum::Router::new()
        // Playlists are CRUD'd before any channel can exist.
        .route("/tv/playlists", get(list_playlists).post(add_playlist))
        .route("/tv/playlists/{index}", delete(remove_playlist))
        .route("/tv/channels", get(get_channels))
        .route("/tv/refresh", post(refresh_channels))
        .route("/addons", get(list_addons).post(install_addon))
        .route("/addons/catalog", get(addon_catalog))
        .route("/addons/{index}", delete(remove_addon))
        .route("/addons/{index}/toggle", post(toggle_addon))
}

/// Persisted TV settings.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TvSettings {
    /// One or more M3U playlist URLs, in the order the user added them. The
    /// index in the URL is the position in this vector, which is why removing
    /// one has to renumber rather than leave a hole.
    #[serde(default)]
    pub playlists: Vec<String>,
    /// Whether the UI should render channel logos. Stored so the setting
    /// survives a restart; the data itself comes from the `tvg-logo` attribute.
    #[serde(default)]
    pub show_logos: bool,
}

pub const DEFAULT_IPTV_PLAYLISTS: &[&str] = &[
    "https://iptv-org.github.io/iptv/languages/eng.m3u",
    "https://iptv-org.github.io/iptv/categories/news.m3u",
    "https://iptv-org.github.io/iptv/categories/movies.m3u",
    "https://iptv-org.github.io/iptv/categories/animation.m3u",
];

/// Load the playlist configuration, tolerating an unreadable file.
async fn load_tv_settings(state: &AppState) -> TvSettings {
    // A missing or unreadable document is not an error: TV is an optional
    // feature and a first run has nothing configured yet.
    state
        .store
        .load_doc::<TvSettings>("tv")
        .await
        .unwrap_or_default()
}

/// Every configured playlist URL.
async fn list_playlists(State(state): State<AppState>) -> Json<Vec<String>> {
    let settings = load_tv_settings(&state).await;
    if settings.playlists.is_empty() {
        Json(DEFAULT_IPTV_PLAYLISTS.iter().map(|s| s.to_string()).collect())
    } else {
        Json(settings.playlists)
    }
}

/// Body of `POST /api/tv/playlists`.
#[derive(Debug, Deserialize)]
pub struct AddPlaylist {
    /// The M3U URL. `source` rather than `url` to match the frontend, and to
    /// leave room for a future paste-a-local-file option under the same key.
    source: String,
}

/// Add a playlist, rejecting duplicates.
///
/// Duplicates are rejected rather than silently ignored because the frontend
/// shows the count it just received; appending a second copy would make the
/// number jump by one and the channel list double with no explanation.
async fn add_playlist(
    State(state): State<AppState>,
    Json(payload): Json<AddPlaylist>,
) -> ApiResult<Json<Vec<String>>> {
    let source = payload.source.trim();
    if source.is_empty() {
        return Err(ApiError::BadRequest("Playlist URL is empty".into()));
    }
    if !crate::net::is_http_url(source) {
        return Err(ApiError::BadRequest(
            "Playlist URL must be an absolute http(s) URL".into(),
        ));
    }

    let mut settings = load_tv_settings(&state).await;
    if settings.playlists.iter().any(|existing| existing == source) {
        return Err(ApiError::BadRequest("That playlist is already added".into()));
    }
    settings.playlists.push(source.to_string());

    state
        .store
        .save_doc("tv", &settings)
        .await
        .map_err(ApiError::internal)?;

    // The on-disk cache is keyed by URL, so a newly-added playlist has nothing
    // stale to clear — it will be fetched on the first channel request.
    Ok(Json(settings.playlists))
}

/// Remove a playlist by index.
async fn remove_playlist(
    State(state): State<AppState>,
    Path(index): Path<usize>,
) -> ApiResult<Json<Vec<String>>> {
    let mut settings = load_tv_settings(&state).await;
    if index >= settings.playlists.len() {
        return Err(ApiError::NotFound(format!("No playlist at index {index}")));
    }
    settings.playlists.remove(index);

    state
        .store
        .save_doc("tv", &settings)
        .await
        .map_err(ApiError::internal)?;

    Ok(Json(settings.playlists))
}

/// Query parameters for `GET /api/tv/channels`.
#[derive(Debug, Default, Deserialize)]
pub struct ChannelQuery {
    /// Restrict to one playlist URL. Omit for "every configured playlist",
    /// which is what the frontend asks for by default.
    #[serde(default)]
    playlist: Option<String>,
}

/// Every channel across every configured playlist.
///
/// Accepts an optional `?playlist=` to scope the request to one source, which
/// the frontend uses for a per-playlist refresh in the UI.
async fn get_channels(
    State(state): State<AppState>,
    Query(query): Query<ChannelQuery>,
) -> ApiResult<Json<Vec<Channel>>> {
    let config = crate::config::load();
    if !config.tv_enabled {
        // An empty list rather than a 503: the UI hides the TV tab off
        // `tv_enabled`, so this only shows up if state drifted.
        return Ok(Json(Vec::new()));
    }

    let settings = load_tv_settings(&state).await;

    let default_sources: Vec<&str> = DEFAULT_IPTV_PLAYLISTS.to_vec();
    let effective_playlists: Vec<&str> = if settings.playlists.is_empty() {
        default_sources
    } else {
        settings.playlists.iter().map(String::as_str).collect()
    };

    let sources: Vec<&str> = match query.playlist.as_deref().map(str::trim) {
        // An empty `?playlist=` means "no filter", not "the playlist named ''".
        Some(wanted) if !wanted.is_empty() => {
            if !effective_playlists.iter().any(|&url| url == wanted) {
                return Err(ApiError::NotFound("Unknown playlist".into()));
            }
            vec![wanted]
        }
        _ => effective_playlists,
    };

    if sources.is_empty() {
        return Ok(Json(Vec::new()));
    }

    let parser = M3UParser::new();
    let mut channels = Vec::new();
    for url in sources {
        match parser.fetch_playlist(url).await {
            Ok(mut batch) => channels.append(&mut batch),
            Err(err) => {
                // One dead playlist must not hide the working ones.
                log::warn!(
                    "playlist {} failed: {err}",
                    crate::logging::sanitize_url(url)
                );
            }
        }
    }

    Ok(Json(channels))
}

/// Fetch the playlists again, discarding the on-disk cache.
async fn refresh_channels(State(state): State<AppState>) -> ApiResult<Json<RefreshSummary>> {
    let settings = load_tv_settings(&state).await;
    if settings.playlists.is_empty() {
        return Err(ApiError::BadRequest(
            "No TV playlists are configured".into(),
        ));
    }

    let parser = M3UParser::new();
    let mut total = 0usize;
    let mut failed = 0usize;
    for url in &settings.playlists {
        match parser.fetch_playlist(url).await {
            Ok(batch) => total += batch.len(),
            Err(err) => {
                failed += 1;
                log::warn!(
                    "refresh of {} failed: {err}",
                    crate::logging::sanitize_url(url)
                );
            }
        }
    }

    Ok(Json(RefreshSummary {
        ok: true,
        channels: total,
        failed_playlists: failed,
    }))
}

/// Body of `POST /api/tv/refresh`.
///
/// Carries per-playlist success counts rather than a bare [`Ack`] because
/// partial failure is the normal case: a playlist host that is down should not
/// hide the channels that did load, and the UI needs the split to say so.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct RefreshSummary {
    pub ok: bool,
    /// Channels found across every playlist that responded.
    pub channels: usize,
    /// How many configured playlists could not be fetched.
    pub failed_playlists: usize,
}

/// Body of `GET /api/addons/catalog`.
#[derive(Debug, Deserialize)]
pub struct AddonCatalogQuery {
    /// Manifest URL of the addon to query. Required: a catalog id means
    /// nothing without knowing which addon serves it.
    manifest: String,
    /// Stremio resource type: `movie` or `series`.
    r#type: String,
    /// The catalog's own id, e.g. `top`.
    id: String,
}

/// Proxy one addon's catalog endpoint.
///
/// Exists because addons have no CORS headers. The browser cannot call
/// `https://addon.example.com/catalog/movie/top.json` directly, so the fetch
/// has to happen here — the same reason playback goes through the proxy.
///
/// Deliberately takes no `State`: installed addons live in `addons.json` under
/// the config directory, which is the same source `Provider for AddonClient`
/// reads. Routing through the store here would let the two disagree.
async fn addon_catalog(Query(query): Query<AddonCatalogQuery>) -> ApiResult<Json<Vec<CatalogItem>>> {
    let manifest = AddonClient::normalize_manifest_url(query.manifest.trim());
    if !crate::net::is_http_url(&manifest) {
        return Err(ApiError::BadRequest(
            "Addon manifest URL must be an absolute http(s) URL".into(),
        ));
    }

    let config = crate::config::load();
    if !config.addons_enabled {
        return Err(ApiError::Unavailable(
            "Addons are disabled in settings".into(),
        ));
    }

    let kind = query.r#type.trim();
    if !matches!(kind, "movie" | "series") {
        return Err(ApiError::BadRequest(
            "`type` must be `movie` or `series`".into(),
        ));
    }

    let catalog_id = query.id.trim();
    if catalog_id.is_empty() {
        return Err(ApiError::BadRequest("`id` must not be empty".into()));
    }

    // Only installed addons are queryable. Without this the proxy would be an
    // open relay: anyone who can reach localhost could make the server issue
    // requests to an arbitrary host and read the response.
    let addons = tokio::task::spawn_blocking(crate::config::load_addons)
        .await
        .unwrap_or_default();
    if !addons
        .iter()
        .any(|addon| addon.enabled && addon.manifest_url == manifest)
    {
        return Err(ApiError::NotFound(
            "That addon is not installed, or is disabled".into(),
        ));
    }

    let client = AddonClient::new();
    let base = AddonClient::base_addon_url(&manifest);
    let metas = client
        .fetch_catalog(&base, kind, catalog_id, None)
        .await
        .map_err(ApiError::Upstream)?;

    // `meta_to_catalog_item` borrows, so the metas are collected by reference
    // rather than consumed — the mapping is a pure read of each item.
    let items: Vec<CatalogItem> = metas
        .iter()
        .map(crate::providers::addons::adapter::meta_to_catalog_item)
        .collect();

    Ok(Json(items))
}

/// Installed addons.
async fn list_addons() -> Json<Vec<InstalledAddon>> {
    // Reading the file does blocking IO; keep it off the reactor.
    let addons = tokio::task::spawn_blocking(crate::config::load_addons)
        .await
        .unwrap_or_default();
    Json(addons)
}

/// Body of `POST /api/addons`.
#[derive(Debug, Deserialize)]
pub struct InstallRequest {
    manifest_url: String,
}

/// Fetch a manifest and add it to the installed set.
async fn install_addon(Json(request): Json<InstallRequest>) -> ApiResult<Json<InstalledAddon>> {
    let manifest_url = crate::providers::addons::client::AddonClient::normalize_manifest_url(
        request.manifest_url.trim(),
    );

    if !crate::net::is_http_url(&manifest_url) {
        return Err(ApiError::BadRequest(
            "Addon manifest URL must be an absolute http(s) URL".into(),
        ));
    }

    let client = crate::providers::addons::client::AddonClient::new();
    let manifest = client
        .fetch_manifest(&manifest_url)
        .await
        .map_err(ApiError::Upstream)?;

    let addon = InstalledAddon {
        manifest_url,
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        description: manifest.description.clone(),
        enabled: true,
        provides_catalog: manifest.provides_resource("catalog"),
        provides_meta: manifest.provides_resource("meta"),
        provides_stream: manifest.provides_resource("stream"),
        id_prefixes: manifest.id_prefixes.clone(),
        types: manifest.types.clone(),
    };

    let mut addons = tokio::task::spawn_blocking(crate::config::load_addons)
        .await
        .unwrap_or_default();

    // Re-installing the same manifest replaces the entry rather than
    // duplicating it, so a version bump is just another install.
    addons.retain(|existing| existing.manifest_url != addon.manifest_url);
    addons.push(addon.clone());

    let to_save = addons;
    tokio::task::spawn_blocking(move || crate::config::save_addons(&to_save))
        .await
        .map_err(ApiError::internal)?;

    log::info!("installed addon {} ({})", addon.name, addon.manifest_url);
    Ok(Json(addon))
}

/// Remove an addon by index.
///
/// Index-based rather than id-based because `InstalledAddon` has no stable id;
/// the frontend re-reads the list after every mutation, so the window where an
/// index could shift is one render frame.
async fn remove_addon(
    axum::extract::Path(index): axum::extract::Path<usize>,
) -> ApiResult<Json<Ack>> {
    let addons = tokio::task::spawn_blocking(crate::config::load_addons)
        .await
        .unwrap_or_default();

    if index >= addons.len() {
        return Err(ApiError::NotFound(format!("No addon at index {index}")));
    }

    let mut addons = addons;
    let removed = addons.remove(index);
    let to_save = addons;
    tokio::task::spawn_blocking(move || crate::config::save_addons(&to_save))
        .await
        .map_err(ApiError::internal)?;

    log::info!("removed addon {}", removed.name);
    Ok(Json(Ack::new()))
}

/// Body of `POST /api/addons/{index}/enabled`.
#[derive(Debug, Deserialize)]
pub struct ToggleAddon {
    enabled: bool,
}

/// Turn an addon on or off.
async fn toggle_addon(
    axum::extract::Path(index): axum::extract::Path<usize>,
    Json(request): Json<ToggleAddon>,
) -> ApiResult<Json<Ack>> {
    let addons = tokio::task::spawn_blocking(crate::config::load_addons)
        .await
        .unwrap_or_default();

    let Some(addon) = addons.get(index) else {
        return Err(ApiError::NotFound(format!("No addon at index {index}")));
    };
    let name = addon.name.clone();

    let mut addons = addons;
    addons[index].enabled = request.enabled;
    let to_save = addons;
    tokio::task::spawn_blocking(move || crate::config::save_addons(&to_save))
        .await
        .map_err(ApiError::internal)?;

    log::info!(
        "addon {name} {}",
        if request.enabled { "enabled" } else { "disabled" }
    );
    Ok(Json(Ack::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tv_settings_tolerate_a_missing_document() {
        // `Default` is what a first run gets: no playlists, no crash.
        let settings = TvSettings::default();
        assert!(settings.playlists.is_empty());
    }

    #[test]
    fn tv_settings_round_trip_through_json() {
        let settings = TvSettings {
            playlists: vec!["http://example.com/list.m3u".into()],
            show_logos: true,
        };
        let json = serde_json::to_string(&settings).unwrap();
        let parsed: TvSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.playlists, settings.playlists);
        assert!(parsed.show_logos);
    }

    #[test]
    fn tv_settings_accept_a_partial_document() {
        // Hand-edited or older files must not fail to parse.
        let parsed: TvSettings = serde_json::from_str("{}").unwrap();
        assert!(parsed.playlists.is_empty());
    }
}