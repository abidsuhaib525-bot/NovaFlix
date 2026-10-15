//! Upstream fetching for the playback proxy.
//!
//! The chunked range logic is ported from the TUI sidecar and is load-bearing:
//! MovieBox's CDN caps how much of a `.m4s` it will serve in one request, so a
//! single large GET silently returns a truncated segment and playback stalls
//! with a decode error. Splitting into 95 KB parallel ranges and reassembling
//! is what makes it work.

use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Client, StatusCode};

use crate::proxy::cache::{DASH_RANGE_CHUNK_BYTES, FetchClaim, InFlightGuard, MAX_SEGMENT_BYTES};
use crate::proxy::session::PlaybackSession;

/// How long to wait for a peer to finish the same segment before giving up and
/// fetching it ourselves.
const IN_FLIGHT_WAIT: Duration = Duration::from_secs(15);
/// Max bytes we will buffer for a manifest.
pub const MAX_MANIFEST_BYTES: usize = 10 * 1024 * 1024;
/// How many upcoming segments to warm.
const PREFETCH_LOOKAHEAD: u32 = 4;

/// Build the shared upstream client.
///
/// `http1_only` is deliberate: the existing prefetch/segment logic assumes
/// HTTP/1.1 semantics and multiplexed H2 streams change how a truncated body
/// surfaces.
pub fn build_client() -> Client {
    crate::net::http_client_builder_base()
        .http1_only()
        .pool_max_idle_per_host(32)
        .connect_timeout(Duration::from_secs(15))
        .build()
        .unwrap_or_default()
}

/// Apply the session's auth headers to a request, honouring host scope.
///
/// Cross-host requests (the subtitle CDN) get UA + Referer only, so a signed
/// token is never leaked to an unrelated host.
pub fn apply_headers(
    builder: reqwest::RequestBuilder,
    session: &PlaybackSession,
    url: &str,
) -> reqwest::RequestBuilder {
    let forward_all = session.forwards_all_headers(url);
    let mut builder = builder;
    for (name, value) in &session.auth_headers {
        if crate::util::url::should_forward_header(forward_all, name) {
            builder = builder.header(name.as_str(), value.as_str());
        }
    }
    builder
}

/// Fetch a DASH media segment, de-duplicating concurrent requests.
///
/// Returns `(status, content_type, bytes)`.
pub async fn fetch_segment(
    session: &PlaybackSession,
    client: &Client,
    url: &str,
) -> Result<(StatusCode, String, Arc<[u8]>), reqwest::Error> {
    let cache = Arc::clone(&session.segment_cache);

    if let Some((ct, data)) = cache.get(url) {
        return Ok((StatusCode::OK, ct, data));
    }

    let notify = match cache.begin_fetch(url) {
        Some(FetchClaim::Owner(notify)) => {
            let _guard = InFlightGuard::new(Arc::clone(&cache), url.to_string(), Arc::clone(&notify));
            return fetch_chunked(client, session, url).await.map(|(status, ct, data)| {
                if status.is_success() && !data.is_empty() && data.len() <= MAX_SEGMENT_BYTES {
                    cache.insert(url.to_string(), ct.clone(), Arc::clone(&data));
                }
                (status, ct, data)
            });
        }
        Some(FetchClaim::Waiter(notify)) => notify,
        None => return fetch_chunked(client, session, url).await,
    };

    // Someone else is fetching this segment; wait for them rather than
    // duplicating the upstream request.
    let _ = tokio::time::timeout(IN_FLIGHT_WAIT, notify.notified()).await;
    if let Some((ct, data)) = cache.get(url) {
        return Ok((StatusCode::OK, ct, data));
    }
    fetch_chunked(client, session, url).await
}

/// Fetch a segment, splitting it into parallel ranges if the CDN truncates.
async fn fetch_chunked(
    client: &Client,
    session: &PlaybackSession,
    url: &str,
) -> Result<(StatusCode, String, Arc<[u8]>), reqwest::Error> {
    let first_end = DASH_RANGE_CHUNK_BYTES - 1;
    let req = apply_headers(
        client.get(url).header("Range", format!("bytes=0-{first_end}")),
        session,
        url,
    );

    let res = req.send().await?;
    let status = res.status();

    // Read through `choose_content_type` rather than taking the CDN's header at
    // face value. This CDN answers `application/octet-stream` for every `.m4s`,
    // and that header is what the media element derives its `SourceBuffer` MIME
    // types from -- so passing the lie through fails at the first
    // `appendBuffer`, not at load time, and blames the segments instead of the
    // header. See `choose_content_type`.
    let content_type = choose_content_type(
        url,
        None,
        res.headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
    )
    .and_then(|value| value.to_str().ok().map(str::to_string))
    .unwrap_or_else(|| "application/octet-stream".to_string());

    if !status.is_success() {
        let body = res.bytes().await.unwrap_or_default();
        return Ok((status, content_type, Arc::from(body.as_ref())));
    }

    // Server ignored our Range and sent the whole thing. Nothing to reassemble.
    if status != StatusCode::PARTIAL_CONTENT {
        let body = res.bytes().await?;
        return Ok((StatusCode::OK, content_type, Arc::from(body.as_ref())));
    }

    let total_opt = res
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(crate::util::url::parse_content_range_total);

    let first_chunk = res.bytes().await?;

    let Some(total) = total_opt.filter(|&t| t > first_chunk.len() && t <= MAX_SEGMENT_BYTES) else {
        return Ok((
            StatusCode::OK,
            content_type,
            Arc::from(first_chunk.as_ref()),
        ));
    };

    // Build the remaining ranges, then pull them 16 at a time.
    let mut ranges = Vec::new();
    let mut pos = first_chunk.len();
    while pos < total {
        let end = (pos + DASH_RANGE_CHUNK_BYTES - 1).min(total - 1);
        ranges.push((pos, end));
        pos = end + 1;
    }

    let mut assembled = Vec::with_capacity(total);
    assembled.extend_from_slice(&first_chunk);

    for batch in ranges.chunks(16) {
        let mut futures = Vec::with_capacity(batch.len());
        for &(start, end) in batch {
            futures.push(async move {
                let req = apply_headers(
                    client
                        .get(url)
                        .header("Range", format!("bytes={start}-{end}")),
                    session,
                    url,
                );
                let res = req.send().await?.error_for_status()?;
                res.bytes().await
            });
        }
        let chunks = futures::future::try_join_all(futures).await?;
        for chunk in chunks {
            assembled.extend_from_slice(&chunk);
        }
    }

    Ok((StatusCode::OK, content_type, Arc::from(assembled)))
}

/// Warm the next few segments in the background.
///
/// Fire-and-forget: a prefetch failure must never affect the segment the
/// player is actually waiting on.
pub fn spawn_prefetch(session: Arc<PlaybackSession>, client: Client, current_url: String) {
    let next_urls = crate::proxy::rewrite::next_dash_segment_urls(&current_url, PREFETCH_LOOKAHEAD);
    if next_urls.is_empty() {
        return;
    }

    tokio::spawn(async move {
        for url in next_urls {
            if session.segment_cache.contains_or_in_flight(&url) {
                continue;
            }
            // Only prefetch URLs on the pinned host.
            if !session.is_host_allowed(&url) {
                continue;
            }
            let session = Arc::clone(&session);
            let client = client.clone();
            let url = url.clone();
            tokio::spawn(async move {
                let _ = fetch_segment(&session, &client, &url).await;
            });
        }
    });
}

/// Warm the manifest plus the init/first chunks of each track.
///
/// MovieBox players stall for a beat before first paint because the browser
/// discovers the init segment only after it has parsed the manifest. Doing
/// that discovery server-side while the page renders removes the delay.
pub async fn warmup(session: Arc<PlaybackSession>, client: Client, manifest_url: String) {
    if let Ok(res) = apply_headers(client.get(&manifest_url), &session, &manifest_url)
        .send()
        .await
    {
        if !res.status().is_success() {
            return;
        }
        let Ok(bytes) = res.bytes().await else { return };
        if bytes.len() > MAX_MANIFEST_BYTES {
            return;
        }

        let rewritten = crate::proxy::rewrite::rewrite_dash_manifest(
            &String::from_utf8_lossy(&bytes),
            &session.proxy_base(),
            session.target_host.as_deref(),
            session.subtitle_url.as_deref(),
            session.max_height,
        );
        if let Ok(mut lock) = session.manifest_cache.lock() {
            *lock = Some((manifest_url.clone(), Arc::from(rewritten.as_bytes())));
        }

        // Guess the track layout: MovieBox uses stream 3 for audio.
        let Some((base_dir, _)) = manifest_url.rsplit_once('/') else { return };
        let vid_id = if rewritten.contains("id=\"0\"") {
            "0"
        } else if rewritten.contains("id=\"1\"") {
            "1"
        } else {
            "2"
        };

        for rel in [
            format!("init-stream{vid_id}.m4s"),
            "init-stream2.m4s".to_string(),
            "init-stream3.m4s".to_string(),
            format!("chunk-stream{vid_id}-00001.m4s"),
            "chunk-stream2-00001.m4s".to_string(),
            "chunk-stream3-00001.m4s".to_string(),
        ] {
            let url = format!("{base_dir}/{rel}");
            if !session.is_host_allowed(&url)
                || session.segment_cache.contains_or_in_flight(&url)
            {
                continue;
            }
            let session = Arc::clone(&session);
            let client = client.clone();
            tokio::spawn(async move {
                let _ = fetch_segment(&session, &client, &url).await;
            });
        }
    }
}

/// The `Content-Type` to serve a proxied body with.
///
/// ## Why the path is consulted before the CDN
///
/// CDNs routinely answer `application/octet-stream` for every media file, and
/// MovieBox's CDN is one of them. A media element derives its `SourceBuffer`
/// MIME types from this header, so getting it wrong does not fail at load time --
/// it fails at the first `appendBuffer`, with a far less obvious message that
/// blames the segments rather than the response header.
///
/// ## Why this is one function
///
/// It was previously inlined in [`build_response_headers`], which meant only the
/// manifest and subtitle paths were corrected while the *segment* path
/// ([`fetch_chunked`] -> `proxy_segment`) passed the CDN's lie straight through.
/// Every `.m4s` therefore went out as `application/octet-stream` and playback
/// had a real chance of failing at the first `appendBuffer`. A correction that
/// only some callers apply is not a correction.
///
/// Three tiers, in order:
///
/// 1. An explicit type from the caller, which wins because the caller is the one
///    that knows where the CDN lies (subtitles are the common case).
/// 2. The path, which is reliable for manifests, playlists and containerised
///    segments.
/// 3. The CDN's own header, and nothing at all if it is unusable.
pub fn choose_content_type(
    target_url: &str,
    explicit: Option<&str>,
    upstream: Option<&str>,
) -> Option<HeaderValue> {
    // Query and fragment come off first: a signed CDN URL ends in `?Policy=…`,
    // and matching an extension against that finds nothing.
    let clean_path = target_url
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();

    let derived = match () {
        _ if clean_path.ends_with(".mpd") => Some("application/dash+xml"),
        _ if clean_path.ends_with(".m3u8") => Some("application/vnd.apple.mpegurl"),
        // The registered type for a CMAF/fMP4 media segment. Deliberately not
        // `video/mp4`, which is what the *initialisation* segment is: browsers
        // treat the two differently when validating what a `SourceBuffer` will
        // accept.
        _ if clean_path.ends_with(".m4s") => Some("video/iso.segment"),
        _ if clean_path.ends_with(".m4a") || clean_path.ends_with(".m4v") => Some("video/mp4"),
        _ if clean_path.ends_with(".mp4") => Some("video/mp4"),
        _ if clean_path.ends_with(".ts") => Some("video/mp2t"),
        _ if clean_path.ends_with(".webm") => Some("video/webm"),
        _ => None,
    };

    explicit
        .and_then(|value| HeaderValue::from_str(value).ok())
        .or_else(|| derived.map(HeaderValue::from_static))
        .or_else(|| {
            // A value that survives `to_str` can still fail `from_str`
            // (leading/trailing whitespace, for instance). Dropping it here
            // leaves the response without a type, which is a clean failure,
            // rather than an empty one.
            upstream.and_then(|value| HeaderValue::from_str(value).ok())
        })
}

/// Build a response header map for proxied content.
///
/// Only pass through the headers that actually matter to a media element:
/// the CDN's `Content-Type` (which fixes subtitle MIME types), `Content-Length`,
/// `Content-Range` and `Accept-Ranges`. Everything else — `set-cookie`,
/// upstream CORS, transfer encodings — is dropped.
pub fn build_response_headers(
    upstream: &HeaderMap,
    target_url: &str,
    extra_content_type: Option<&str>,
) -> HeaderMap {
    let mut out = HeaderMap::new();

    for name in [
        "content-length",
        "content-range",
        "accept-ranges",
        "last-modified",
        "etag",
    ] {
        if let Some(value) = upstream.get(name)
            && let Ok(v) = value.to_str()
        {
            if let (Ok(n), Ok(val)) = (
                HeaderName::from_bytes(name.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                out.insert(n, val);
            }
        }
    }

    // Content-Type is decided in three tiers, by `choose_content_type`.
    let chosen = choose_content_type(
        target_url,
        extra_content_type,
        upstream
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
    );

    if let Some(value) = chosen {
        out.insert(reqwest::header::CONTENT_TYPE, value);
    }

    // Always ensure Accept-Ranges bytes is present so media players can seek
    out.insert(reqwest::header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    // Prevent upstream/tower compression from breaking media byte streams & ranges:
    out.insert(reqwest::header::CONTENT_ENCODING, HeaderValue::from_static("identity"));

    out
}

/// Pick the correct `Content-Type` for a subtitle file.
///
/// CDNs routinely serve `.srt` as `text/plain` and `.vtt` as
/// `application/octet-stream`, which makes the browser refuse the track.
pub fn subtitle_content_type(url: &str) -> &'static str {
    let clean = url
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if clean.ends_with(".vtt") {
        "text/vtt; charset=utf-8"
    } else if clean.ends_with(".ass") || clean.ends_with(".ssa") {
        "text/x-ssa; charset=utf-8"
    } else if clean.ends_with(".sub") {
        "application/x-sub"
    } else {
        "text/srt; charset=utf-8"
    }
}

/// Extract a `Content-Range` total from response headers.
pub fn content_range_total(headers: &HeaderMap) -> Option<usize> {
    headers
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(crate::util::url::parse_content_range_total)
}

/// Convert a request `Range` header into a 206 response over a buffered body.
///
/// Segments are already fully in memory, so honouring a byte range is just a
/// slice. Browsers rely on this: without proper 206s, seeking breaks.
pub fn apply_range_to_buffer<'a>(
    range_header: Option<&str>,
    body: &'a [u8],
) -> Option<(StatusCode, String, &'a [u8])> {
    let (start, end) = crate::util::url::parse_byte_range_request(range_header?, body.len())?;
    Some((
        StatusCode::PARTIAL_CONTENT,
        format!("bytes {start}-{end}/{}", body.len()),
        &body[start..=end],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::models::{PlaybackSource, ProviderKind};
    use crate::proxy::session::PlaybackSession;

    fn session(url: &str) -> PlaybackSession {
        PlaybackSession::from_source(&PlaybackSource {
            provider: ProviderKind::MovieBox,
            url: url.to_string(),
            headers: vec![
                ("x-client-token".into(), "secret".into()),
                ("referer".into(), "https://moviebox.example.com/".into()),
                ("user-agent".into(), "UA/1.0".into()),
            ],
            subtitle: Some("https://subs.example.com/en.vtt".into()),
            source_label: "Direct".into(),
            max_height: None,
        })
        .unwrap()
    }

    #[test]
    fn full_headers_only_go_to_target_host() {
        let s = session("https://video.example.com/dash/index.mpd");
        assert!(s.forwards_all_headers("https://video.example.com/a.m4s"));
        assert!(!s.forwards_all_headers("https://subs.example.com/en.vtt"));
    }

    /* ------------------------------------------------------------------ */
    /* Content-Type correction                                              */
    /* ------------------------------------------------------------------ */

    /// Shorthand: the type `choose_content_type` settles on.
    fn chosen(url: &str, explicit: Option<&str>, upstream: Option<&str>) -> String {
        choose_content_type(url, explicit, upstream)
            .expect("a type must always resolve")
            .to_str()
            .expect("types are ASCII")
            .to_string()
    }

    #[test]
    fn the_path_beats_a_cdn_that_calls_everything_octet_stream() {
        // MovieBox's CDN answers `application/octet-stream` for every media file.
        // A media element derives its `SourceBuffer` MIME types from this header,
        // so passing that through fails at the first `appendBuffer` rather than at
        // load time, and blames the segments instead of the response header.
        assert_eq!(
            chosen("https://c/dash/chunk-stream0-00001.m4s", None, Some("application/octet-stream")),
            "video/iso.segment"
        );
        assert_eq!(
            chosen("https://c/dash/init-stream0.m4s", None, None),
            "video/iso.segment"
        );
        assert_eq!(
            chosen("https://c/dash/index.mpd", None, Some("application/octet-stream")),
            "application/dash+xml"
        );
    }

    #[test]
    fn an_explicit_type_from_the_caller_wins_over_everything() {
        // The caller knows where the CDN lies; the path does not know what a
        // `.vtt` holding SubRip text is.
        assert_eq!(
            chosen("https://c/sub.srt", Some("text/vtt; charset=utf-8"), Some("text/plain")),
            "text/vtt; charset=utf-8"
        );
    }

    #[test]
    fn a_signed_query_string_does_not_hide_the_extension() {
        // CloudFront-signed URLs end in `?Policy=...&Signature=...`, so matching
        // the extension against the whole URL finds nothing and every segment
        // falls through to the CDN's own wrong answer.
        assert_eq!(
            chosen(
                "https://c/dash/chunk-stream0-00001.m4s?Policy=abc&Expires=1",
                None,
                Some("application/octet-stream")
            ),
            "video/iso.segment"
        );
    }

    #[test]
    fn matching_ignores_case() {
        assert_eq!(chosen("https://c/DASH/INDEX.MPD", None, None), "application/dash+xml");
        assert_eq!(
            chosen("https://c/dash/CHUNK-STREAM0-00001.M4S", None, None),
            "video/iso.segment"
        );
    }

    #[test]
    fn the_cdn_header_is_the_last_resort() {
        // Nothing recognisable in the path, so the CDN gets the final say.
        assert_eq!(
            chosen("https://c/stream/12345", None, Some("video/mp4")),
            "video/mp4"
        );
        // And an unusable value leaves no type rather than an empty one, which
        // is a clean failure. A NUL is not a legal header character, whereas
        // stray whitespace is: `HeaderValue::from_str` strips the optional
        // whitespace HTTP allows around a field value, so `" bad "` is a
        // perfectly good header and must not be treated as broken.
        assert!(
            choose_content_type("https://c/stream/12345", None, Some("video/mp4\0")).is_none()
        );
    }

    #[test]
    fn a_media_segment_is_not_typed_as_a_plain_mp4() {
        // `video/iso.segment` and `video/mp4` are both fMP4, but browsers
        // validate them differently when deciding what a `SourceBuffer` will
        // take. The initialisation segment is the `video/mp4` case; the media
        // segments that follow it are this one.
        assert_eq!(
            chosen("https://c/dash/seg-1.m4s", None, None),
            "video/iso.segment"
        );
        assert_eq!(chosen("https://c/dash/whole.mp4", None, None), "video/mp4");
    }

    #[tokio::test]
    async fn a_media_segment_from_a_lying_cdn_is_still_typed_correctly() {
        // The regression guard for the bug this function was extracted to fix.
        //
        // The correction used to live only inside `build_response_headers`, which
        // the *manifest* and subtitle paths call and the *segment* path does not
        // -- so every `.m4s` went out as `application/octet-stream` and this
        // assert would have failed against a real MovieBox CDN.
        //
        // Note that the mock upstream here has to *lie* for the test to mean
        // anything. The existing concurrency test's mock announces
        // `video/iso.segment`, so it passes either way, and a mock that behaves
        // well cannot catch a bug about a CDN that does not.
        use std::sync::Arc as StdArc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let payload: StdArc<Vec<u8>> = StdArc::new(vec![0u8; 2048]);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let url = format!("http://127.0.0.1:{port}/dash/chunk-stream0-00001.m4s");

        let srv_payload = StdArc::clone(&payload);
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let data = StdArc::clone(&srv_payload);
                tokio::spawn(async move {
                    let mut buf = [0u8; 2048];
                    // The request line is never inspected; reading some bytes is
                    // all that is needed to know a client arrived.
                    if socket.read(&mut buf).await.is_err() {
                        return;
                    }
                    let total = data.len();
                    let hdr = format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes 0-{}/{total}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        total - 1,
                        total
                    );
                    let _ = socket.write_all(hdr.as_bytes()).await;
                    let _ = socket.write_all(&data).await;
                });
            }
        });

        let client = build_client();
        let session = Arc::new(session(&url));
        let (_status, content_type, body) = fetch_chunked(&client, &session, &url).await.unwrap();

        assert_eq!(
            content_type, "video/iso.segment",
            "a .m4s must not be served as the CDN's octet-stream"
        );
        assert_eq!(body.len(), 2048, "the body must be reassembled intact");
    }

    #[test]
    fn range_over_buffered_body_yields_206() {
        let body: Vec<u8> = (0..1000u32).map(|i| i as u8).collect();
        let (status, range, slice) =
            apply_range_to_buffer(Some("bytes=100-199"), &body).expect("valid range");
        assert_eq!(status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(range, "bytes 100-199/1000");
        assert_eq!(slice.len(), 100);
        assert_eq!(slice[0], 100);
    }

    #[test]
    fn range_absent_or_invalid_falls_back_to_full_body() {
        let body: Vec<u8> = (0..100u32).map(|i| i as u8).collect();
        assert!(apply_range_to_buffer(None, &body).is_none());
        assert!(apply_range_to_buffer(Some("bytes=9999-"), &body).is_none());
    }

    #[test]
    fn subtitle_content_types_are_corrected() {
        assert_eq!(subtitle_content_type("https://c/a.vtt?x=1"), "text/vtt; charset=utf-8");
        assert_eq!(subtitle_content_type("https://c/a.SRT"), "text/srt; charset=utf-8");
        assert_eq!(subtitle_content_type("https://c/a.ass"), "text/x-ssa; charset=utf-8");
        assert_eq!(subtitle_content_type("https://c/unknown"), "text/srt; charset=utf-8");
    }

    #[test]
    fn response_headers_carry_only_media_fields() {
        let mut upstream = HeaderMap::new();
        upstream.insert("content-type", "text/plain".parse().unwrap());
        upstream.insert("content-length", "1234".parse().unwrap());
        upstream.insert("accept-ranges", "bytes".parse().unwrap());
        upstream.insert("set-cookie", "tracking=1".parse().unwrap());
        upstream.insert("x-secret-internal", "leak".parse().unwrap());

        let out = build_response_headers(&upstream, "https://c/subs.vtt", None);
        assert_eq!(out.get("content-length").unwrap(), "1234");
        assert_eq!(out.get("accept-ranges").unwrap(), "bytes");
        assert!(out.get("set-cookie").is_none(), "cookies must not leak");
        assert!(out.get("x-secret-internal").is_none());
    }

    #[test]
    fn explicit_content_type_overrides_upstream() {
        // CDN says text/plain; we know it is actually VTT.
        let mut upstream = HeaderMap::new();
        upstream.insert("content-type", "text/plain".parse().unwrap());
        let out = build_response_headers(&upstream, "https://c/s.vtt", Some("text/vtt; charset=utf-8"));
        assert_eq!(out.get("content-type").unwrap(), "text/vtt; charset=utf-8");
    }

    #[tokio::test]
    async fn concurrent_fetches_of_same_segment_hit_upstream_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc as StdArc;
        use tokio::net::TcpListener;

        let total_size = 240 * 1024usize;
        let payload: StdArc<Vec<u8>> = StdArc::new((0..total_size).map(|i| (i % 253) as u8).collect());
        let request_count = StdArc::new(AtomicUsize::new(0));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let url = format!("http://127.0.0.1:{port}/dash/chunk-stream0-00001.m4s");

        let srv_payload = StdArc::clone(&payload);
        let srv_reqs = StdArc::clone(&request_count);
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let data = StdArc::clone(&srv_payload);
                let reqs = StdArc::clone(&srv_reqs);
                tokio::spawn(async move {
                    let mut buf = [0u8; 2048];
                    let Ok(n) = socket.read(&mut buf).await else { return };
                    reqs.fetch_add(1, Ordering::Relaxed);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let range_val = req.lines().find_map(|l| {
                        l.strip_prefix("Range: bytes=")
                            .or_else(|| l.strip_prefix("range: bytes="))
                            .map(str::trim)
                    });
                    let total = data.len();
                    let (start, end) = range_val
                        .and_then(|r| {
                            let (s, e) = r.split_once('-')?;
                            Some((s.parse::<usize>().ok()?, e.parse::<usize>().ok()?.min(total - 1)))
                        })
                        .unwrap_or((0, total - 1));
                    let slice = &data[start..=end];
                    let hdr = format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Type: video/iso.segment\r\nContent-Range: bytes {start}-{end}/{total}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        slice.len()
                    );
                    let _ = socket.write_all(hdr.as_bytes()).await;
                    let _ = socket.write_all(slice).await;
                });
            }
        });

        let client = build_client();
        let session = Arc::new(session(&url));

        // Three concurrent requests for the identical segment.
        let handles: Vec<_> = (0..3)
            .map(|_| {
                let s = Arc::clone(&session);
                let c = client.clone();
                let u = url.clone();
                tokio::spawn(async move { fetch_segment(&s, &c, &u).await })
            })
            .collect();

        let mut results = Vec::new();
        for h in handles {
            let (status, ct, data) = h.await.unwrap().unwrap();
            assert_eq!(status, StatusCode::OK);
            assert_eq!(ct, "video/iso.segment");
            results.push(data);
        }

        // All three must receive the identical, correctly reassembled payload.
        for data in &results {
            assert_eq!(data.len(), total_size, "chunked ranges must reassemble fully");
            assert_eq!(data.as_ref(), payload.as_slice());
        }

        // 240KB in 95KB chunks = 3 range requests, and only one fetch won the race.
        assert_eq!(
            request_count.load(Ordering::Relaxed),
            3,
            "de-duplication must keep this to a single 3-range fetch"
        );
    }
}