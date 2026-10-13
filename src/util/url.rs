//! Stream-URL classification and host extraction.
//!
//! `is_dash_url` is ported verbatim from the TUI's `player.rs` — the DASH
//! detection rule drives manifest rewriting in the proxy, so it must stay
//! byte-identical to the original or playback silently breaks.

/// Strip `?query` and `#fragment` from a URL, keeping only scheme+host+path.
fn clean_path(url: &str) -> &str {
    url.split(['?', '#']).next().unwrap_or(url)
}

/// True when the URL points at a DASH manifest.
///
/// MovieBox serves DASH from paths that do not always end in `.mpd`, hence
/// the `/dash/` check in addition to the extension check.
pub fn is_dash_url(url: &str) -> bool {
    let clean = clean_path(url);
    clean.ends_with(".mpd") || clean.contains("/dash/")
}

/// True when the URL points at an HLS playlist (master or media).
pub fn is_hls_url(url: &str) -> bool {
    let clean = clean_path(url).to_ascii_lowercase();
    clean.ends_with(".m3u8") || clean.ends_with(".m3u")
}

/// True when the URL points at a fMP4 DASH media segment.
///
/// These need the chunked range-fetch path in the proxy: providers cap segment
/// downloads, so a single large GET gets truncated.
pub fn is_m4s_segment(url: &str) -> bool {
    clean_path(url).to_ascii_lowercase().ends_with(".m4s")
}

/// True when the URL points at a subtitle file in a browser-usable format.
pub fn is_subtitle_url(url: &str) -> bool {
    let clean = clean_path(url).to_ascii_lowercase();
    clean.ends_with(".vtt") || clean.ends_with(".srt") || clean.ends_with(".ass") || clean.ends_with(".ssa")
}

/// Extract the `host[:port]` authority from a URL.
///
/// This is the backbone of the proxy's SSRF guard: a request is only allowed
/// through when its host matches the playback session's pinned target host.
pub fn extract_host_authority(url: &str) -> Option<String> {
    let after_scheme = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .or_else(|| url.strip_prefix("//"))?;
    let authority = after_scheme.split(['/', '?', '#']).next()?;
    if authority.is_empty() {
        None
    } else {
        Some(authority.to_string())
    }
}

/// Check if a host authority represents a local, loopback, or private network address.
pub fn is_private_or_local_host(authority: &str) -> bool {
    let host = authority.split(':').next().unwrap_or(authority).trim().to_ascii_lowercase();
    if host.is_empty()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host == "0.0.0.0"
        || host == "127.0.0.1"
        || host == "::1"
        || host == "[::1]"
    {
        return true;
    }

    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        match ip {
            std::net::IpAddr::V4(v4) => {
                v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_broadcast() || v4.is_unspecified()
            }
            std::net::IpAddr::V6(v6) => {
                v6.is_loopback() || v6.is_unspecified()
            }
        }
    } else {
        false
    }
}

/// Decide whether an auth header should be forwarded upstream.
///
/// Full headers only go to the pinned target host. Cross-host requests
/// (typically the subtitle CDN) get UA + Referer only, because forwarding a
/// signed token to an unrelated host would leak the session signature.
pub fn should_forward_header(forward_all: bool, name: &str) -> bool {
    forward_all
        || name.eq_ignore_ascii_case("user-agent")
        || name.eq_ignore_ascii_case("referer")
}

/// Parse a `Range: bytes=a-b` header against a known total size.
pub fn parse_byte_range_request(header_val: &str, total: usize) -> Option<(usize, usize)> {
    if total == 0 {
        return None;
    }
    let spec = header_val.trim().strip_prefix("bytes=")?;
    let (start_str, end_str) = spec.split_once('-')?;
    let start = start_str.trim().parse::<usize>().ok()?;
    if start >= total {
        return None;
    }
    let end = if end_str.trim().is_empty() {
        total - 1
    } else {
        end_str.trim().parse::<usize>().ok()?.min(total - 1)
    };
    if start <= end { Some((start, end)) } else { None }
}

/// Read the total size out of a `Content-Range: bytes a-b/total` header.
pub fn parse_content_range_total(header_val: &str) -> Option<usize> {
    let (_, total_str) = header_val.trim().split_once('/')?;
    total_str.trim().parse::<usize>().ok()
}

/// Reject anything that isn't an absolute `http(s)` URL.
///
/// Used on every user-supplied URL (posters, addons, M3U playlists) before we
/// hand it to the HTTP client.
pub fn is_http_url(value: &str) -> bool {
    let trimmed = value.trim();
    (trimmed.starts_with("http://") || trimmed.starts_with("https://"))
        && trimmed.len() > "https://".len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dash_detection_matches_original_rules() {
        assert!(is_dash_url("https://cdn.example.com/dash/index.mpd"));
        assert!(is_dash_url("https://cdn.example.com/dash/index.mpd?Policy=abc#sig"));
        assert!(is_dash_url("https://cdn.example.com/dash/123/index"));
        assert!(!is_dash_url("https://cdn.example.com/video.mp4"));
        assert!(!is_dash_url("not-a-url"));
    }

    #[test]
    fn hls_detection() {
        assert!(is_hls_url("https://cdn.example.com/master.m3u8?token=1"));
        assert!(is_hls_url("https://cdn.example.com/list.M3U8"));
        assert!(!is_hls_url("https://cdn.example.com/index.mpd"));
    }

    #[test]
    fn host_authority_preserves_explicit_port() {
        assert_eq!(
            extract_host_authority("https://cdn.example.com/dash/index.mpd").as_deref(),
            Some("cdn.example.com")
        );
        assert_eq!(
            extract_host_authority("http://cdn.example.com:8080/a.mp4").as_deref(),
            Some("cdn.example.com:8080")
        );
        assert_eq!(
            extract_host_authority("https://cdn.example.com?query=val").as_deref(),
            Some("cdn.example.com")
        );
        assert_eq!(
            extract_host_authority("//cdn.example.com/stream.m3u8").as_deref(),
            Some("cdn.example.com")
        );
        assert_eq!(extract_host_authority("not-a-url"), None);
        assert_eq!(extract_host_authority("https://"), None);
        assert_eq!(extract_host_authority("//"), None);
    }

    #[test]
    fn header_forwarding_respects_host_scope() {
        // Cross-host: only UA and Referer.
        assert!(should_forward_header(false, "User-Agent"));
        assert!(should_forward_header(false, "referer"));
        assert!(!should_forward_header(false, "x-client-token"));
        // Same host: everything.
        assert!(should_forward_header(true, "x-client-token"));
    }

    #[test]
    fn byte_ranges_clamp_to_total() {
        assert_eq!(parse_byte_range_request("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_byte_range_request("bytes=500-", 1000), Some((500, 999)));
        // End beyond total is clamped, not rejected.
        assert_eq!(parse_byte_range_request("bytes=900-5000", 1000), Some((900, 999)));
        assert_eq!(parse_byte_range_request("bytes=1000-", 1000), None);
        assert_eq!(parse_byte_range_request("garbage", 1000), None);
    }

    #[test]
    fn content_range_total_extracted() {
        assert_eq!(parse_content_range_total("bytes 0-95195/204800"), Some(204800));
        assert_eq!(parse_content_range_total("bytes */204800"), Some(204800));
    }

    #[test]
    fn http_url_validation_rejects_junk() {
        assert!(is_http_url("https://example.com/a"));
        assert!(is_http_url("http://example.com"));
        assert!(!is_http_url("file:///etc/passwd"));
        assert!(!is_http_url("javascript:alert(1)"));
        assert!(!is_http_url("https://"));
        assert!(!is_http_url("data:text/html,<h1>x</h1>"));
    }
}