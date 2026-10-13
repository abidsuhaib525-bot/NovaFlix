//! Web playback proxy.
//!
//! ## Why this exists
//!
//! A browser cannot play these streams directly:
//!
//! 1. **Custom headers.** MovieBox CDNs require `x-client-token`,
//!    `x-tr-signature`, a spoofed `x-forwarded-for` and a `Referer`. A `<video>`
//!    element cannot set request headers at all.
//! 2. **CORS.** Even header-free playback fails because the CDN sends no
//!    `Access-Control-Allow-Origin`.
//! 3. **Opaque signed URLs.** Segments are `.m4s` files behind
//!    CloudFront-signed query strings that expire.
//!
//! So every byte goes through the server. The browser asks for
//! `/api/playback/{sid}/https/host/path`, and this module resolves `{sid}` to a
//! [`PlaybackSession`] holding the credentials, then fetches upstream with
//! them attached.
//!
//! ## Layout
//!
//! - [`session`] — session registry and the host whitelist (SSRF guard)
//! - [`cache`] — DASH segment cache with in-flight de-duplication
//! - [`rewrite`] — DASH manifest / HLS playlist rewriting
//! - [`fetch`] — upstream fetching, chunked ranges, prefetch

pub mod cache;
pub mod fetch;
pub mod rewrite;
pub mod session;

use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;

pub use cache::SegmentCache;
pub use session::{PlaybackSession, PlaybackSubtitle, SessionRegistry};

use fetch::apply_range_to_buffer;

/// Build a JSON error response with the given status.
fn error_response(status: StatusCode, message: &str) -> Response {
    let body = serde_json::json!({ "error": message }).to_string();
    let mut res = Response::new(Body::from(body));
    *res.status_mut() = status;
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    res
}

/// Strip the `/api/playback/{sid}` prefix and recover the upstream URL.
///
/// Accepts three shapes:
/// - `/https/host/path`  → `https://host/path`
/// - `/http/host/path`   → `http://host/path`
/// - `/sub/<encoded>`    → handled separately by the caller
pub fn extract_target_url(path_and_query: &str) -> Option<String> {
    let raw = path_and_query.strip_prefix('/')?;

    if let Some(rest) = raw.strip_prefix("https/") {
        Some(format!("https://{rest}"))
    } else if let Some(rest) = raw.strip_prefix("http/") {
        Some(format!("http://{rest}"))
    } else if let Some(rest) = raw.strip_prefix("sub/") {
        let decoded = percent_encoding::percent_decode_str(rest).decode_utf8().ok()?;
        if decoded.starts_with("http://") || decoded.starts_with("https://") {
            Some(decoded.into_owned())
        } else {
            None
        }
    } else {
        None
    }
}

/// Handle one proxied request.
///
/// `path_and_query` is the portion of the URL after `/api/playback/{sid}`.
/// `client` is reused across the session so connections stay pooled.
pub async fn handle_request(
    session: Arc<PlaybackSession>,
    client: reqwest::Client,
    path_and_query: &str,
    range_header: Option<&str>,
) -> Response {
    // Subtitles take a dedicated route because they need a forced MIME type.
    if let Some(rest) = path_and_query.strip_prefix("/sub/") {
        let sub_url = if rest.starts_with("http://") || rest.starts_with("https://") {
            rest.to_string()
        } else {
            percent_encoding::percent_decode_str(rest)
                .decode_utf8_lossy()
                .to_string()
        };
        if !sub_url.starts_with("http://") && !sub_url.starts_with("https://") {
            return error_response(StatusCode::BAD_REQUEST, "Subtitle URL must be http(s)");
        }
        let Some(auth) = crate::util::url::extract_host_authority(&sub_url) else {
            return error_response(StatusCode::BAD_REQUEST, "Invalid subtitle URL host");
        };
        if crate::util::url::is_private_or_local_host(&auth) {
            return error_response(StatusCode::FORBIDDEN, "Private or local host not allowed for subtitles");
        }
        return proxy_subtitle(session, client, &sub_url).await;
    }

    let Some(target_url) = extract_target_url(path_and_query) else {
        return error_response(
            StatusCode::BAD_REQUEST,
            "Expected /https/host/... , /http/host/... or /sub/<url>",
        );
    };

    // SSRF guard: the session is pinned to one host (+ its subtitle host).
    if !session.is_host_allowed(&target_url) {
        log::warn!(
            "proxy blocked cross-host request: session host {:?}, requested {}",
            session.target_host,
            crate::logging::sanitize_url(&target_url)
        );
        return error_response(StatusCode::FORBIDDEN, "Host not allowed for this session");
    }

    let is_dash = crate::util::url::is_dash_url(&target_url);
    let is_hls = crate::util::url::is_hls_url(&target_url);
    let is_segment = crate::util::url::is_m4s_segment(&target_url);

    // Serve the rewritten manifest straight from cache when possible.
    if (is_dash || is_hls) && range_header.is_none() {
        if let Some(bytes) = cached_manifest(&session, &target_url) {
            let content_type = if is_hls {
                "application/vnd.apple.mpegurl"
            } else {
                "application/dash+xml"
            };
            return buffered_response(StatusCode::OK, content_type, bytes, None);
        }
    }

    if is_segment {
        return proxy_segment(session, client, target_url, range_header).await;
    }

    proxy_passthrough(session, client, target_url, range_header, is_dash || is_hls).await
}

/// Return a cached rewritten manifest, if it matches this URL.
fn cached_manifest(session: &PlaybackSession, url: &str) -> Option<Arc<[u8]>> {
    let lock = session.manifest_cache.lock().ok()?;
    lock.as_ref()
        .filter(|(cached_url, _)| cached_url == url)
        .map(|(_, bytes)| Arc::clone(bytes))
}

/// Fetch a `.m4s` segment: cache first, then chunked upstream, with prefetch.
async fn proxy_segment(
    session: Arc<PlaybackSession>,
    client: reqwest::Client,
    target_url: String,
    range_header: Option<&str>,
) -> Response {
    // Warm the next few segments before serving this one.
    fetch::spawn_prefetch(Arc::clone(&session), client.clone(), target_url.clone());

    let (status, content_type, data) = match fetch::fetch_segment(&session, &client, &target_url).await
    {
        Ok(result) => result,
        Err(err) => {
            log::warn!(
                "segment fetch failed for {}: {err}",
                crate::logging::sanitize_url(&target_url)
            );
            return error_response(StatusCode::BAD_GATEWAY, &format!("Upstream fetch failed: {err}"));
        }
    };

    if !status.is_success() {
        return error_response(
            status,
            &format!("Upstream returned {}", status.as_u16()),
        );
    }

    // Honour Range so browser seeking works over the buffered segment.
    match apply_range_to_buffer(range_header, &data) {
        Some((range_status, content_range, slice)) => {
            let mut res = Response::new(Body::from(slice.to_vec()));
            *res.status_mut() = range_status;
            {
                let h = res.headers_mut();
                h.insert(
                    header::CONTENT_TYPE,
                    content_type
                        .parse()
                        .unwrap_or(HeaderValue::from_static("application/octet-stream")),
                );
                h.insert(
                    header::CONTENT_RANGE,
                    HeaderValue::from_str(&content_range)
                        .unwrap_or(HeaderValue::from_static("bytes 0-0/0")),
                );
                h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            }
            res
        }
        None => buffered_response(status, &content_type, data, None),
    }
}

/// Fetch a subtitle file with a corrected `Content-Type`.
async fn proxy_subtitle(
    session: Arc<PlaybackSession>,
    client: reqwest::Client,
    sub_url: &str,
) -> Response {
    let req = fetch::apply_headers(client.get(sub_url), &session, sub_url);
    let res = match req.send().await {
        Ok(res) => res,
        Err(err) => return error_response(StatusCode::BAD_GATEWAY, &format!("Subtitle fetch failed: {err}")),
    };

    if !res.status().is_success() {
        return error_response(res.status(), "Subtitle not available");
    }

    let bytes = match res.bytes().await {
        Ok(b) => b,
        Err(err) => return error_response(StatusCode::BAD_GATEWAY, &format!("Subtitle read failed: {err}")),
    };

    // The CDN's declared type is frequently wrong; ours is authoritative.
    buffered_response(
        StatusCode::OK,
        fetch::subtitle_content_type(sub_url),
        Arc::from(bytes.as_ref()),
        None,
    )
}

/// Stream everything else, rewriting manifests and playlists on the way through.
async fn proxy_passthrough(
    session: Arc<PlaybackSession>,
    client: reqwest::Client,
    target_url: String,
    range_header: Option<&str>,
    is_manifest: bool,
) -> Response {
    let mut req = fetch::apply_headers(client.get(&target_url), &session, &target_url);
    if let Some(range) = range_header {
        req = req.header("Range", range);
    }

    let res = match req.send().await {
        Ok(res) => res,
        Err(err) => {
            log::warn!(
                "proxy fetch failed for {}: {err}",
                crate::logging::sanitize_url(&target_url)
            );
            return error_response(StatusCode::BAD_GATEWAY, &format!("Upstream fetch failed: {err}"));
        }
    };

    let status = res.status();
    if !status.is_success() {
        return error_response(status, &format!("Upstream returned {}", status.as_u16()));
    }

    let upstream_headers = res.headers().clone();
    let content_length = upstream_headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok());

    // Manifests are small enough to rewrite in full.
    let rewrite_worthy = is_manifest
        && content_length.is_none_or(|len| len <= fetch::MAX_MANIFEST_BYTES);

    if rewrite_worthy {
        let Ok(bytes) = res.bytes().await else {
            return error_response(StatusCode::BAD_GATEWAY, "Manifest read failed");
        };
        if bytes.len() > fetch::MAX_MANIFEST_BYTES {
            return error_response(StatusCode::BAD_GATEWAY, "Manifest too large");
        }

        let text = String::from_utf8_lossy(&bytes);
        let rewritten = if crate::util::url::is_hls_url(&target_url) {
            rewrite::rewrite_hls_playlist(&text, &session.proxy_base(), &target_url)
        } else {
            rewrite::rewrite_dash_manifest(
                &text,
                &session.proxy_base(),
                session.target_host.as_deref(),
                session.subtitle_url.as_deref(),
                session.max_height,
            )
        };

        let out_bytes: Arc<[u8]> = Arc::from(rewritten.as_bytes());
        if let Ok(mut lock) = session.manifest_cache.lock() {
            *lock = Some((target_url.clone(), Arc::clone(&out_bytes)));
        }

        let ct = if crate::util::url::is_hls_url(&target_url) {
            "application/vnd.apple.mpegurl"
        } else {
            "application/dash+xml"
        };
        return buffered_response(StatusCode::OK, ct, out_bytes, None);
    }

    // Large media: stream it through untouched.
    let out_headers = fetch::build_response_headers(&upstream_headers, &target_url, None);
    let mut response = Response::new(Body::from_stream(res.bytes_stream()));
    *response.status_mut() = status;
    *response.headers_mut() = out_headers;
    response
}

/// Build a buffered response with sensible defaults.
fn buffered_response(
    status: StatusCode,
    content_type: &str,
    body: Arc<[u8]>,
    extra: Option<(&str, &str)>,
) -> Response {
    let mut response = Response::new(Body::from(body.to_vec()));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(content_type)
            .unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=30"),
    );
    if let Some((name, value)) = extra
        && let (Ok(n), Ok(v)) = (
            axum::http::HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        )
    {
        headers.insert(n, v);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::models::{PlaybackSource, ProviderKind};

    fn session() -> Arc<PlaybackSession> {
        Arc::new(
            PlaybackSession::from_source(&PlaybackSource {
                provider: ProviderKind::MovieBox,
                url: "https://sacdn.example.com/dash/index.mpd".into(),
                headers: vec![("x-client-token".into(), "tok".into())],
                subtitle: None,
                source_label: "Direct".into(),
                max_height: None,
            })
            .unwrap(),
        )
    }

    #[test]
    fn extracts_upstream_url_from_path() {
        assert_eq!(
            extract_target_url("/https/sacdn.example.com/dash/index.mpd").as_deref(),
            Some("https://sacdn.example.com/dash/index.mpd")
        );
        assert_eq!(
            extract_target_url("/http/example.com/video.mp4").as_deref(),
            Some("http://example.com/video.mp4")
        );
        assert_eq!(
            extract_target_url("/https/example.com/seg.m4s?token=abc&exp=123").as_deref(),
            Some("https://example.com/seg.m4s?token=abc&exp=123")
        );
        assert_eq!(extract_target_url("/invalid/path"), None);
        assert_eq!(extract_target_url(""), None);
    }

    #[test]
    fn subtitle_path_is_decoded_but_must_be_http() {
        assert_eq!(
            extract_target_url("/sub/https%3A%2F%2Fcdn.example.com%2Fsub.vtt").as_deref(),
            Some("https://cdn.example.com/sub.vtt")
        );
        // Non-http schemes are rejected outright.
        assert_eq!(extract_target_url("/sub/file%3A%2F%2F%2Fetc%2Fpasswd"), None);
        assert_eq!(extract_target_url("/sub/data%3Atext%2Fhtml%2Chello"), None);
    }

    #[tokio::test]
    async fn blocks_cross_host_requests() {
        let session = session();
        let client = fetch::build_client();
        let res = handle_request(
            session,
            client,
            "/https/evil.example.com/steal.m4s",
            None,
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN, "SSRF guard must reject");
    }

    #[tokio::test]
    async fn rejects_malformed_paths() {
        let res = handle_request(session(), fetch::build_client(), "/nonsense", None).await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn rejects_non_http_subtitle_target() {
        let res = handle_request(
            session(),
            fetch::build_client(),
            "/sub/file%3A%2F%2F%2Fetc%2Fpasswd",
            None,
        )
        .await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn serves_cached_manifest_without_upstream() {
        let session = session();
        let url = "https://sacdn.example.com/dash/index.mpd".to_string();

        // Pre-populate the cache the way a first fetch would.
        let rewritten = "<MPD>cached</MPD>";
        if let Ok(mut lock) = session.manifest_cache.lock() {
            *lock = Some((url.clone(), Arc::from(rewritten.as_bytes())));
        }

        let res = handle_request(session, fetch::build_client(), "/https/sacdn.example.com/dash/index.mpd", None).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/dash+xml"
        );
    }

    #[test]
    fn buffered_response_sets_type_and_private_cache() {
        let res = buffered_response(StatusCode::OK, "text/vtt", Arc::from(b"WEBVTT".as_slice()), None);
        assert_eq!(res.headers().get(header::CONTENT_TYPE).unwrap(), "text/vtt");
        assert!(
            res.headers().get(header::CACHE_CONTROL).unwrap().to_str().unwrap().contains("private"),
            "playback responses must not be publicly cached"
        );
    }
}