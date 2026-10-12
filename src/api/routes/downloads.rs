//! Download routes and the SSE progress stream.

use axum::extract::{Path, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::{delete, get, post};
use axum::Json;
use futures::stream::Stream;
use serde::{Deserialize, Serialize};use std::time::Duration;
use tokio::sync::broadcast;

use crate::api::error::{ApiError, ApiResult};
use crate::api::response::{Ack, StartedDownload};
use crate::api::state::AppState;
use crate::providers::models::ProviderKind;

/// Route table for this module.
pub fn router() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/downloads", get(snapshot).post(start_download).delete(clear_finished))
        .route("/downloads/stream", get(progress_stream))
        .route("/downloads/{id}/pause", post(pause))
        .route("/downloads/{id}/resume", post(resume))
        .route("/downloads/{id}/cancel", post(cancel))
        .route("/downloads/{id}", delete(remove))
}

/// Whether a release mirror is a single file the HTTP engine can save.
///
/// The engine streams bytes from one URL into one file. Direct-file mirrors
/// Files that can be downloaded by either the HTTP engine (direct files) or
/// the adaptive downloader (MovieBox DASH manifests, HLS playlists).
pub fn engine_downloadable(release: &crate::providers::models::Release) -> bool {
    release.mirrors.first().is_some_and(|mirror| {
        mirror.direct_file || is_adaptive_source_url(&mirror.resolver_url)
    })
}

/// Manifest markers that identify adaptive streams (DASH or HLS).
pub fn is_adaptive_source_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.ends_with(".mpd")
        || lower.contains("/index.mpd")
        || lower.ends_with(".m3u8")
        || lower.contains("/hls/")
        || lower.contains("/dash/")
}

/// Body of POST /api/downloads.
#[derive(Debug, Deserialize)]
pub struct StartDownload {
    provider: String,
    subject_id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    season: usize,
    #[serde(default)]
    episode: usize,
    #[serde(default)]
    max_height: Option<u64>,
    #[serde(default)]
    resource_id: Option<String>,
    #[serde(default)]
    filename: Option<String>,
    #[serde(default)]
    format: Option<String>,
}

/// `GET /api/downloads` response.
#[derive(Debug, Serialize)]
pub struct SnapshotResponse {
    tasks: Vec<crate::api::downloads::DownloadTask>,
    active: usize,
}

/// Every download the server knows about.
async fn snapshot(
    State(state): State<AppState>,
) -> Json<SnapshotResponse> {
    Json(SnapshotResponse {
        active: state.downloads.active_count(),
        tasks: state.downloads.snapshot(),
    })
}

/// Queue a download.
///
/// The provider's own downloader is reused rather than reimplemented: it
/// already does multi-threaded ranges, retries and `.part` resume.
async fn start_download(
    State(state): State<AppState>,
    Json(request): Json<StartDownload>,
) -> ApiResult<Json<StartedDownload>> {
    let provider = ProviderKind::parse(&request.provider)
        .ok_or_else(|| ApiError::BadRequest(format!("unknown provider `{}`", request.provider)))?;
    if request.subject_id.trim().is_empty() {
        return Err(ApiError::BadRequest("`subject_id` is required".into()));
    }

    let releases = state
        .service
        .episode_streams(provider, &request.subject_id, request.season, request.episode)
        .await
        .map_err(ApiError::from)?;

    // Pick the release matching the requested cap, falling back to the best
    // available so "1080p" on a 4K-only title still downloads something.
    // Only mirrors that hand back a single file can be saved by the HTTP
    // engine: adaptive sources (MovieBox DASH, some HLS) are a manifest plus a
    // tree of segments, and grabbing the manifest alone makes a hollow file.
    let release = request
        .resource_id
        .as_deref()
        .and_then(|target_id| {
            releases
                .iter()
                .filter(|r| engine_downloadable(r))
                .find(|r| r.resource_id.as_deref() == Some(target_id))
        })
        .or_else(|| {
            releases
                .iter()
                .filter(|r| engine_downloadable(r))
                .min_by_key(|r| {
                    let height = r.resolution_u64();
                    match request.max_height.filter(|&h| h > 0) {
                        Some(cap) if height > cap => 1_000_000 + height,
                        _ => height.abs_diff(1080),
                    }
                })
        })
        .ok_or_else(|| {
            ApiError::BadRequest("No downloadable stream available for this title.".into())
        })?;

    let source = state
        .service
        .resolve_playback_source(release, request.max_height, None)
        .map_err(ApiError::from)?;

    let directory = crate::service::resolve_download_dir(
        crate::config::load()
            .download_dir
            .as_deref()
            .map(std::path::Path::new),
    );
    // The task opens files straight into this directory, so it has to exist
    // before the first chunk is written. create_dir_all is idempotent,
    // so changing the folder in settings later is safe.
    if let Err(error) = tokio::fs::create_dir_all(&directory).await {
        return Err(ApiError::internal(format!("Could not create the download directory {}: {error}", directory.display())));
    }
    let ext = match request.format.as_deref().map(|s| s.trim().to_ascii_lowercase()) {
        Some(ref f) if f == "mp4" => "mp4",
        _ => "mkv",
    };

    let filename = request
        .filename
        .filter(|f| !f.trim().is_empty())
        .map(|f| format!("{}.{ext}", crate::download::safe_file_stem(&f)))
        .unwrap_or_else(|| {
            format!(
                "{}.{ext}",
                crate::download::safe_file_stem(
                    request
                        .title
                        .as_deref()
                        .unwrap_or(&release.filename)
                )
            )
        });

    let id = state.downloads.enqueue(
        source.url,
        source.headers,
        directory.join(filename),
        request.title.unwrap_or_else(|| release.filename.clone()),
        release.size_bytes,
    );

    Ok(Json(StartedDownload::new(id)))
}

/// Server-sent progress for every download.
///
/// SSE rather than WebSockets: the traffic is one-directional, SSE reconnects
/// on its own, and it works through the same origin and compression layer as
/// the rest of the API.
async fn progress_stream(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let mut receiver = state.downloads.subscribe();

    let stream = async_stream::stream! {
        loop {
            match receiver.recv().await {
                Ok(event) => {
                    // `unwrap_or_default` keeps a malformed frame from tearing
                    // down the stream.
                    let data = serde_json::to_string(&event).unwrap_or_default();
                    yield Ok(Event::default().event("progress").data(data));
                }
                // A lagged receiver missed frames; the next one will be
                // current, so stay connected rather than dropping the client.
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    };

    // Comment heartbeats stop idle proxies from closing the connection while a
    // user watches a long download with no progress events.
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    )
}

/// Pause a download, keeping its partial file so it can resume.
async fn pause(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Ack>> {
    if state.downloads.pause(&id) {
        Ok(Json(Ack::new()))
    } else {
        Err(ApiError::NotFound(
            "Download not found, already finished, or already paused".into(),
        ))
    }
}

/// Resume a paused download from its `.part` file.
async fn resume(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Ack>> {
    // The paused task holds the URL and headers needed to restart.
    let Some(task) = state.downloads.resume_target(&id) else {
        return Err(ApiError::NotFound("No paused download with that id".into()));
    };

    state.downloads.enqueue_resumed(&id, task);
    Ok(Json(Ack::new()))
}

/// Cancel a download and discard its partial file.
async fn cancel(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Ack>> {
    if state.downloads.cancel(&id) {
        Ok(Json(Ack::new()))
    } else {
        Err(ApiError::NotFound("Download not found or already finished".into()))
    }
}

/// Forget a download. A completed file on disk is left alone.
async fn remove(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Ack>> {
    if state.downloads.remove(&id).await {
        Ok(Json(Ack::new()))
    } else {
        Err(ApiError::NotFound("Download not found".into()))
    }
}

/// Drop finished and failed downloads from the list.
async fn clear_finished(State(state): State<AppState>) -> ApiResult<Json<Ack>> {
    state.downloads.clear_finished();
    Ok(Json(Ack::new()))
}

// The resume target lives in the manager, next to the fields it copies out of.
pub use crate::api::downloads::ResumeTarget;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn start_download_rejects_unknown_provider() {
        let app = axum::Router::new()
            .route("/downloads", post(start_download))
            .with_state(test_state().await);
        let status = post_json(
            &app,
            "/downloads",
            &serde_json::json!({ "provider": "not-a-provider", "subject_id": "x" }),
        )
        .await;
        assert_eq!(status, 400);
    }

    #[tokio::test]
    async fn start_download_requires_a_subject() {
        let app = axum::Router::new()
            .route("/downloads", post(start_download))
            .with_state(test_state().await);
        let status = post_json(
            &app,
            "/downloads",
            &serde_json::json!({ "provider": "moviebox", "subject_id": "  " }),
        )
        .await;
        assert_eq!(status, 400);
    }

    #[tokio::test]
    async fn control_endpoints_404_on_unknown_ids() {
        let app = axum::Router::new()
            .route("/downloads/{id}/pause", post(pause))
            .route("/downloads/{id}/resume", post(resume))
            .route("/downloads/{id}/cancel", post(cancel))
            .with_state(test_state().await);

        for path in ["/downloads/nope/pause", "/downloads/nope/resume", "/downloads/nope/cancel"] {
            let status = post_json(&app, path, &serde_json::json!({})).await;
            assert_eq!(status, 404, "{path} should 404");
        }
    }

    #[tokio::test]
    async fn snapshot_is_empty_on_a_fresh_server() {
        let state = test_state().await;
        let response = snapshot(State(state)).await;
        assert_eq!(response.0.active, 0);
        assert!(response.0.tasks.is_empty());
    }

    #[test]
    fn adaptive_urls_mark_dash_and_hls_as_non_direct() {
        assert!(is_adaptive_source_url("https://cdn.example/x/dash/590/32_1_1080/index.mpd"));
        assert!(is_adaptive_source_url("https://cdn.example/x/playlist.m3u8"));
        assert!(is_adaptive_source_url("https://cdn.example/x/master.m3u8"));
        assert!(!is_adaptive_source_url("https://cdn.example/x/movie.mkv"));
        assert!(!is_adaptive_source_url("https://cdn.example/x/file.mp4"));
    }

    #[test]
    fn engine_download_rejects_adaptive_and_page_mirrors() {
        use crate::providers::models::{ProviderKind, Release, SourceMirror};
        let direct = Release {
            provider: ProviderKind::MovieBox,
            filename: "s".into(),
            quality: None,
            codec: None,
            language: None,
            size_bytes: None,
            season: None,
            episode: None,
            mirrors: vec![SourceMirror {
                label: "mirror".into(),
                resolver_url: "https://cdn.example/x/movie.mkv".into(),
                headers: vec![],
                direct_file: true,
            }],
            resource_id: None,
        };
        assert!(engine_downloadable(&direct));

        let adaptive = Release {
            mirrors: vec![SourceMirror {
                label: "mirror".into(),
                resolver_url: "https://cdn.example/x/dash/590/index.mpd".into(),
                headers: vec![],
                direct_file: true,
            }],
            ..direct.clone()
        };
        assert!(engine_downloadable(&adaptive));

        let page = Release {
            mirrors: vec![SourceMirror {
                label: "mirror".into(),
                resolver_url: "https://cdn.example/x/file.mkv".into(),
                headers: vec![],
                direct_file: false,
            }],
            ..direct
        };
        assert!(!engine_downloadable(&page));
    }
    async fn test_state() -> crate::api::state::AppState {
        let store =
            crate::store::JsonFileStore::new(std::env::temp_dir().join("moviebox-web-tests"))
                .expect("store");
        crate::api::state::AppState::new(store)
    }

    async fn post_json(app: &axum::Router, path: &str, body: &impl serde::Serialize) -> u16 {
        use axum::body::Body;
        use axum::http::Request;
        use tower::ServiceExt;

        let req = Request::builder()
            .method("POST")
            .uri(path)
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(body).expect("serialize")))
            .expect("request");

        app.clone().oneshot(req).await.expect("response").status().as_u16()
    }
}
