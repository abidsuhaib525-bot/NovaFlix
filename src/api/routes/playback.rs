//! Playback session and proxy routes.

use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::api::error::{ApiError, ApiResult};
use crate::api::state::AppState;
use crate::providers::models::PlaybackSource;
use crate::proxy::{PlaybackSession, PlaybackSubtitle};

/// Route table for this module.
pub fn router() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/playback/session", post(create_session))
        // Everything under `/{sid}/...` is raw proxied bytes. It must be a
        // wildcard so multi-segment CDN paths survive untouched.
        .route("/playback/{sid}/{*path}", get(proxy))
}

/// Body of `POST /api/playback/session`.
#[derive(Debug, Deserialize)]
pub struct CreateSessionRequest {
    provider: crate::providers::models::ProviderKind,
    url: String,
    /// Headers the upstream CDN requires, forwarded verbatim.
    #[serde(default)]
    headers: Vec<(String, String)>,
    #[serde(default)]
    subtitle: Option<String>,
    /// External subtitle tracks the browser will register with the player.
    ///
    /// Carried on the session purely so the proxy's host whitelist accepts
    /// their hosts; see [`PlaybackSubtitle`]. `subtitle` above is the legacy
    /// single-track field the DASH injector consumed.
    #[serde(default)]
    subtitles: Vec<PlaybackSubtitle>,
    #[serde(default)]
    source_label: Option<String>,
    /// Cap rendition selection. `0` and `null` both mean "no cap".
    #[serde(default)]
    max_height: Option<u64>,
}

/// What the browser needs to start playing.
#[derive(Debug, Serialize)]
pub struct SessionResponse {
    session_id: String,
    /// Proxied manifest URL. Hand this straight to Shaka Player.
    manifest_url: String,
    /// Prefix every proxied request goes through.
    proxy_base: String,
    source: PlaybackSource,
}

/// Register a playback session and hand back its proxied manifest URL.
///
/// The browser never sees the upstream URL in a playable position — the
/// manifest it loads points at this server, which attaches the auth headers on
/// the way out.
async fn create_session(
    State(state): State<AppState>,
    Json(request): Json<CreateSessionRequest>,
) -> ApiResult<Json<SessionResponse>> {
    let source = PlaybackSource {
        provider: request.provider,
        url: request.url,
        headers: request.headers,
        subtitle: request.subtitle,
        source_label: request.source_label.unwrap_or_else(|| request.provider.label().to_string()),
        max_height: request.max_height.filter(|&h| h > 0),
    };

    if !crate::util::url::is_http_url(&source.url) {
        return Err(ApiError::BadRequest(
            "Playback URL must be an absolute http(s) URL".into(),
        ));
    }

    let session = PlaybackSession::from_source(&source).map_err(ApiError::from)?;
    let proxy_base = session.proxy_base();
    let manifest_url = proxied_manifest_url(&session, &source.url);
    let id = session.id.clone();

    // Attach the subtitle tracks after construction: `from_source` mirrors the
    // provider model, which has no notion of a list.
    let mut session = session;
    session.subtitles = request.subtitles;

    let session = state.sessions.insert(session);

    // Warm the manifest and the first couple of segments while the browser
    // boots Shaka. Without this, first paint is delayed by two sequential
    // round-trips to the CDN.
    tokio::spawn(crate::proxy::fetch::warmup(
        std::sync::Arc::clone(&session),
        state.http.clone(),
        source.url.clone(),
    ));

    log::info!(
        "playback session {id} opened for {} ({})",
        session.source_label,
        crate::logging::sanitize_url(&source.url)
    );

    Ok(Json(SessionResponse {
        session_id: id,
        manifest_url,
        proxy_base,
        source,
    }))
}

/// Build the URL the browser should load for this source.
///
/// Preserving the upstream path structure is what makes relative segment
/// references inside the manifest resolve correctly: the manifest is served
/// from `<base>/<host>/<path>`, so a sibling `seg_$Number$.m4s` lands on
/// `<base>/<host>/seg_$Number$.m4s` and still passes the host check.
fn proxied_manifest_url(session: &PlaybackSession, target_url: &str) -> String {
    let scheme = if target_url.starts_with("https://") {
        "https"
    } else {
        "http"
    };
    let host = crate::util::url::extract_host_authority(target_url)
        .unwrap_or_else(|| "invalid".to_string());
    let path = target_url
        .split_once("://")
        .and_then(|(_, rest)| rest.split_once('/').map(|(_, path)| path))
        .unwrap_or("");

    if path.is_empty() {
        format!("{}/{scheme}/{host}/", session.proxy_base())
    } else {
        format!("{}/{scheme}/{host}/{path}", session.proxy_base())
    }
}

/// Proxy one segment, manifest, playlist or subtitle.
async fn proxy(
    State(state): State<AppState>,
    Path((session_id, path)): Path<(String, String)>,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    method: axum::http::Method,
) -> Response {
    // The session id is the only credential this route has. An unknown id is
    // indistinguishable from an expired one, deliberately.
    let Some(session) = state.sessions.get(&session_id) else {
        return missing_session();
    };

    // Only GET/HEAD make sense here. Rejecting anything else stops a stray
    // form post from being forwarded upstream.
    if !(method == axum::http::Method::GET || method == axum::http::Method::HEAD) {
        return (
            axum::http::StatusCode::METHOD_NOT_ALLOWED,
            Json(serde_json::json!({ "error": "Only GET and HEAD are supported" })),
        )
            .into_response();
    }

    let range = headers
        .get(axum::http::header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    let query_suffix = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    let full_path_and_query = format!("/{path}{query_suffix}");

    crate::proxy::handle_request(session, state.http.clone(), &full_path_and_query, range.as_deref())
        .await
}

/// Uniform response for an unknown or expired session.
fn missing_session() -> Response {
    (
        axum::http::StatusCode::NOT_FOUND,
        Json(serde_json::json!({
            "error": "Playback session not found or expired",
            "kind": "bad_request",
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session_for(url: &str) -> PlaybackSession {
        PlaybackSession::from_source(&PlaybackSource {
            provider: crate::providers::models::ProviderKind::MovieBox,
            url: url.to_string(),
            headers: vec![],
            subtitle: None,
            source_label: "Direct".into(),
            max_height: None,
        })
        .unwrap()
    }

    #[test]
    fn manifest_url_preserves_the_upstream_path() {
        let session = session_for("https://sacdn.example.com/dash/123/index.mpd");
        let url = proxied_manifest_url(&session, "https://sacdn.example.com/dash/123/index.mpd");
        assert_eq!(
            url,
            format!("{}/https/sacdn.example.com/dash/123/index.mpd", session.proxy_base())
        );
    }

    #[test]
    fn manifest_url_keeps_the_query_string() {
        // CloudFront-signed manifests carry their signature in the query; losing
        // it turns every playback into a 403.
        let session = session_for("https://sacdn.example.com/dash/index.mpd?Policy=abc&Expires=1");
        let url = proxied_manifest_url(&session, "https://sacdn.example.com/dash/index.mpd?Policy=abc&Expires=1");
        assert!(url.ends_with("index.mpd?Policy=abc&Expires=1"), "got {url}");
    }

    #[test]
    fn manifest_url_handles_a_bare_host() {
        let session = session_for("https://sacdn.example.com");
        let url = proxied_manifest_url(&session, "https://sacdn.example.com");
        assert_eq!(
            url,
            format!("{}/https/sacdn.example.com/", session.proxy_base())
        );
    }

    #[test]
    fn relative_segments_resolve_against_the_proxied_manifest() {
        // The whole point of the proxy URL scheme: a manifest at
        // .../dash/123/index.mpd referencing `seg_1.m4s` must resolve to a URL
        // the browser will request *and* that `extract_target_url` maps back to
        // an upstream the session's host whitelist accepts. Both halves matter
        // — a mismatch here is a silent 404 on every segment.
        let manifest_url = "https://sacdn.example.com/dash/123/index.mpd";
        let session = session_for(manifest_url);
        let proxied = proxied_manifest_url(&session, manifest_url);

        // Resolve `seg_1.m4s` the way a browser resolves it: relative to the
        // manifest's directory, keeping the proxy base intact.
        let dir = proxied
            .rsplit_once('/')
            .map(|(dir, _)| format!("{dir}/"))
            .expect("proxied manifest must have a directory");
        let proxied_segment = format!("{dir}seg_1.m4s");
        assert!(
            proxied_segment.starts_with(&session.proxy_base()),
            "segment {proxied_segment} escaped the proxy base"
        );

        let path = proxied_segment
            .strip_prefix(&session.proxy_base())
            .expect("segment sits under the proxy base");
        let upstream = crate::proxy::extract_target_url(path)
            .expect("proxy path must decode back to an upstream URL");

        assert_eq!(upstream, "https://sacdn.example.com/dash/123/seg_1.m4s");
        assert!(
            session.is_host_allowed(&upstream),
            "resolved sibling {upstream} must be allowed"
        );
    }

    #[test]
    fn a_relative_segment_in_the_rewritten_manifest_keeps_the_session_id() {
        // `rewrite_dash_manifest` emits `media="seg_$Number$.m4s"` relative to
        // the manifest. If the manifest is served one directory deeper than the
        // proxy base, those segments would land outside the session and 401.
        let session = session_for("https://sacdn.example.com/dash/123/index.mpd");
        let proxied = proxied_manifest_url(&session, "https://sacdn.example.com/dash/123/index.mpd");

        // The path the browser sees for a sibling segment, verbatim.
        assert!(proxied.starts_with(&session.proxy_base()));
        assert!(proxied.ends_with("/dash/123/index.mpd"));
    }

    #[test]
    fn max_height_of_zero_is_treated_as_no_cap() {
        let source = PlaybackSource {
            provider: crate::providers::models::ProviderKind::MovieBox,
            url: "https://a.example.com/x.mpd".into(),
            headers: vec![],
            subtitle: None,
            source_label: "Direct".into(),
            max_height: Some(0),
        };
        let session = PlaybackSession::from_source(&source).unwrap();
        assert_eq!(session.max_height, None);
    }

    #[test]
    fn non_http_source_is_rejected_by_the_constructor() {
        let source = PlaybackSource {
            provider: crate::providers::models::ProviderKind::MovieBox,
            url: "file:///etc/passwd".into(),
            headers: vec![],
            subtitle: None,
            source_label: "Direct".into(),
            max_height: None,
        };
        assert!(PlaybackSession::from_source(&source).is_err());
    }
}
