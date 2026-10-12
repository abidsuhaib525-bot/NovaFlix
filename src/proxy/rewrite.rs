//! Manifest rewriting.
//!
//! The browser can neither set the auth headers the CDNs require nor reach the
//! signed upstream URLs directly, so the proxy hands the player a manifest
//! whose every URL points back at the proxy. This module produces those
//! manifests.
//!
//! `filter_dash_representations` and the subtitle `AdaptationSet` injection are
//! ported verbatim from the TUI's `proxy.rs` — they are battle-tested against
//! real MovieBox manifests and changing them risks silent playback breakage.

use crate::service::subtitle_extension_from_url;

/// Build the proxy prefix that replaces the upstream host inside manifests.
///
/// e.g. `/api/playback/<sid>/https/cdn.example.com/`
fn proxy_prefix(proxy_base: &str, host: &str, https: bool) -> String {
    format!("{proxy_base}/{}/{host}/", if https { "https" } else { "http" })
}

/// Remove `<Representation>` blocks whose height exceeds `max_height`.
///
/// Auto-scaling ("Auto" quality in the TUI) maps to a height cap. Representations
/// without a `height` attribute (typically audio-only) are always kept.
///
/// Note this is a textual splice, not an XML parse: it is deliberately cheap
/// and preserves the rest of the document byte-for-byte, including the XML
/// namespace declarations that a round-trip through an XML writer would mangle.
pub fn filter_dash_representations(manifest: &str, max_height: u64) -> String {
    let mut reps: Vec<(usize, usize)> = Vec::new();
    let mut cursor = 0;

    while let Some(start_rel) = manifest[cursor..].find("<Representation") {
        let start = cursor + start_rel;
        let rest = &manifest[start..];
        let Some(tag_end_rel) = rest.find('>') else { break };
        let tag_content = &rest[..=tag_end_rel];

        if tag_content.ends_with("/>") {
            // Self-closing: `<Representation ... />`
            let end = start + tag_end_rel + 1;
            reps.push((start, end));
            cursor = end;
        } else if let Some(close_rel) = rest.find("</Representation>") {
            let end = start + close_rel + "</Representation>".len();
            reps.push((start, end));
            cursor = end;
        } else {
            cursor = start + tag_end_rel + 1;
        }
    }

    if reps.is_empty() {
        return manifest.to_string();
    }

    // Pull `height="..."` out of each representation block.
    let parse_height = |block: &str| -> Option<u64> {
        let mut search = block;
        while let Some(pos) = search.find("height=") {
            let after = &search[pos + "height=".len()..];
            let quote = after.chars().next()?;
            if quote == '"' || quote == '\'' {
                let digits: String = after[1..]
                    .chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect();
                if let Ok(h) = digits.parse::<u64>() {
                    return Some(h);
                }
            }
            search = after;
        }
        None
    };

    let heights: Vec<Option<u64>> = reps
        .iter()
        .map(|&(s, e)| parse_height(&manifest[s..e]))
        .collect();

    let video_heights: Vec<u64> = heights.iter().filter_map(|&h| h).collect();
    if video_heights.is_empty() {
        return manifest.to_string();
    }

    // If the requested cap is below everything on offer, keep the smallest
    // rendition rather than stripping the manifest bare.
    let ceiling = if video_heights.iter().any(|&h| h <= max_height) {
        max_height
    } else {
        *video_heights.iter().min().unwrap_or(&max_height)
    };

    let mut out = String::with_capacity(manifest.len());
    let mut last = 0;
    for (&(s, e), h_opt) in reps.iter().zip(heights.iter()) {
        if let Some(h) = h_opt
            && *h > ceiling
        {
            out.push_str(&manifest[last..s]);
            last = e;
        }
    }
    out.push_str(&manifest[last..]);
    out
}

/// Build the DASH `AdaptationSet` that exposes the external subtitle track.
fn subtitle_adaptation_set(sub_url: &str, proxy_base: &str) -> String {
    let encoded = percent_encoding::utf8_percent_encode(sub_url, percent_encoding::NON_ALPHANUMERIC);
    let sub_proxy_url = format!("{proxy_base}/sub/{encoded}");

    let mime = match subtitle_extension_from_url(sub_url) {
        "vtt" => "text/vtt",
        "ass" | "ssa" => "text/x-ssa",
        _ => "application/x-subrip",
    };

    format!(
        r#"<AdaptationSet contentType="text" mimeType="{mime}" lang="en">
    <Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"/>
    <Representation id="sub_en" bandwidth="1000">
      <BaseURL>{sub_proxy_url}</BaseURL>
    </Representation>
  </AdaptationSet>
</Period>"#
    )
}

/// Bare codec brands and the well-formed RFC 6381 strings they expand to.
///
/// MovieBox writes `codecs="hev1"` -- a bare brand, not a codec string.
/// Chromium refuses bare brands (it rejects `codecs="avc1"` for the same
/// reason), so `MediaSource.isTypeSupported` answers false, Shaka finds no
/// compatible variant and fails with `4032 CONTENT_UNSUPPORTED_BY_BROWSER`.
/// That happened on *every* machine, including ones that decode HEVC
/// perfectly well.
///
/// The expansion is deliberately a conservative Main-profile string: what
/// reaches the decoder is the `hvcC` / `avcC` box inside the init segment, so
/// this string only has to describe a capability the browser will accept.
/// Understating the level is safe for acceptance; naming a level the browser
/// does not claim support for would be rejected all over again.
const BARE_CODECS: [(&str, &str); 4] = [
    ("hev1", "hev1.1.6.L93.B0"),
    ("hvc1", "hvc1.1.6.L93.B0"),
    ("avc1", "avc1.64001F"),
    ("avc3", "avc3.64001F"),
];

/// Replace bare codec brands with strings a browser will parse.
///
/// Matching is on the whole quoted value, so an already-expanded
/// `codecs="hev1.2.4.L153.B0"` is left exactly as written.
fn expand_bare_codecs(manifest: &str) -> String {
    let mut out = manifest.to_string();
    for (bare, full) in BARE_CODECS {
        let from = format!("codecs=\"{bare}\"");
        if out.contains(&from) {
            out = out.replace(&from, &format!("codecs=\"{full}\""));
        }
    }
    out
}

/// Rewrite a DASH manifest so every URL routes back through the proxy.
///
/// Four transformations, in order:
/// 1. Drop representations above `max_height` (if a cap is set).
/// 2. Expand bare codec brands Chromium refuses to parse.
/// 3. Replace absolute `https://host/` / `http://host/` prefixes with the
///    proxy prefix, so segments and init chunks pick up the auth headers.
/// 4. Append an `AdaptationSet` exposing the external subtitle track.
///
/// Relative URLs (`media="seg_$Number$.m4s"`) are deliberately left alone:
/// they resolve against the manifest's own URL, which is itself served from the
/// proxy, so they end up on the proxy path anyway.
pub fn rewrite_dash_manifest(
    manifest: &str,
    proxy_base: &str,
    target_host: Option<&str>,
    subtitle_url: Option<&str>,
    max_height: Option<u64>,
) -> String {
    let Some(host) = target_host else {
        // Without a pinned host there is nothing safe to rewrite to.
        return manifest.to_string();
    };

    let filtered = match max_height.filter(|&h| h > 0) {
        Some(limit) => filter_dash_representations(manifest, limit),
        None => manifest.to_string(),
    };
    let expanded = expand_bare_codecs(&filtered);

    let mut rewritten = expanded
        .replace(
            &format!("https://{host}/"),
            &proxy_prefix(proxy_base, host, true),
        )
        .replace(
            &format!("http://{host}/"),
            &proxy_prefix(proxy_base, host, false),
        );

    if let Some(sub) = subtitle_url.filter(|s| !s.is_empty()) {
        let set = subtitle_adaptation_set(sub, proxy_base);
        if rewritten.contains("</Period>") {
            rewritten = rewritten.replacen("</Period>", &set, 1);
        }
    }

    rewritten
}

/// Rewrite an HLS playlist so variant/segment URLs route through the proxy.
///
/// New for the web build: the TUI handed HLS URLs straight to mpv, which can
/// send headers itself, so HLS never needed rewriting. A browser cannot, so
/// both the master playlist's variant URIs and each media playlist's segment
/// URIs are rewritten here.
pub fn rewrite_hls_playlist(playlist: &str, proxy_base: &str, base_url: &str) -> String {
    let base_dir = match base_url.rsplit_once('/') {
        Some((dir, _)) => format!("{dir}/"),
        None => base_url.to_string(),
    };

    let mut out = String::with_capacity(playlist.len());
    for line in playlist.lines() {
        let trimmed = line.trim();

        // Blank lines and comments pass through, except URI attributes.
        if trimmed.is_empty() {
            out.push('\n');
            continue;
        }

        if trimmed.starts_with('#') {
            out.push_str(&rewrite_hls_tag(trimmed, proxy_base, &base_dir));
            out.push('\n');
            continue;
        }

        // Bare URI line.
        out.push_str(&rewrite_uri(trimmed, proxy_base, &base_dir));
        out.push('\n');
    }
    out
}

/// Rewrite the URI inside a single HLS tag line (handles `#EXT-X-KEY`, `#EXT-X-MAP`).
fn rewrite_hls_tag(line: &str, proxy_base: &str, base_dir: &str) -> String {
    for attr in ["URI=\"", "uri=\""] {
        if let Some(pos) = line.find(attr) {
            let value_start = pos + attr.len();
            let Some(value_end) = line[value_start..].find('"') else {
                return line.to_string();
            };
            let value_end = value_start + value_end;
            let original = &line[value_start..value_end];
            let rewritten = rewrite_uri(original, proxy_base, base_dir);
            let mut result = String::with_capacity(line.len() + rewritten.len());
            result.push_str(&line[..value_start]);
            result.push_str(&rewritten);
            result.push_str(&line[value_end..]);
            return result;
        }
    }
    line.to_string()
}

/// Resolve `uri` against `base_dir` and map it onto the proxy prefix.
fn rewrite_uri(uri: &str, proxy_base: &str, base_dir: &str) -> String {
    if uri.is_empty() || uri.starts_with("data:") {
        return uri.to_string();
    }

    // Already absolute to some host -> route through the proxy so headers apply.
    if uri.starts_with("http://") || uri.starts_with("https://") {
        if let Some(host) = crate::util::url::extract_host_authority(uri) {
            return format!(
                "{proxy_base}/{scheme}/{host}/{path}",
                scheme = if uri.starts_with("https://") { "https" } else { "http" },
                host = host,
                path = uri.split_once("://").map(|(_, r)| r).unwrap_or("").split_once('/').map(|(_, p)| p).unwrap_or("")
            );
        }
        return uri.to_string();
    }

    // Protocol-relative.
    if let Some(rest) = uri.strip_prefix("//") {
        if let Some(host) = crate::util::url::extract_host_authority(rest) {
            let path = rest.split_once('/').map(|(_, p)| p).unwrap_or("");
            return format!("{proxy_base}/https/{host}/{path}");
        }
    }

    // Relative -> resolve against the playlist's directory, then proxy it.
    let resolved = format!("{base_dir}{uri}");
    match crate::util::url::extract_host_authority(&resolved) {
        Some(host) => {
            let path = resolved
                .split_once("://")
                .map(|(_, r)| r)
                .unwrap_or("")
                .split_once('/')
                .map(|(_, p)| p)
                .unwrap_or("");
            format!("{proxy_base}/https/{host}/{path}")
        }
        None => uri.to_string(),
    }
}

/// Predict the next `.m4s` segments after `url` so they can be prefetched.
///
/// MovieBox numbers segments with zero-padded indices and pairs video
/// (`chunk-stream0/1/2`) with audio (`chunk-stream3`). Without prefetch, audio
/// arrives a buffer late and playback stutters. Zero padding is preserved,
/// otherwise the constructed URL 404s.
pub fn next_dash_segment_urls(url: &str, count: u32) -> Vec<String> {
    let (base, query_suffix) = match url.find('?') {
        Some(idx) => (&url[..idx], &url[idx..]),
        None => (url, ""),
    };
    if !base.to_ascii_lowercase().ends_with(".m4s") {
        return Vec::new();
    }

    let without_ext = &base[..base.len() - 4];
    let file_stem = without_ext.rsplit('/').next().unwrap_or(without_ext);

    // Init segments: fetch the matching audio init.
    if let Some(init_id) = file_stem.strip_prefix("init-stream") {
        let dir_prefix = &without_ext[..without_ext.len() - file_stem.len()];
        return if init_id == "3" {
            vec![format!("{dir_prefix}init-stream0.m4s{query_suffix}")]
        } else {
            vec![format!("{dir_prefix}init-stream3.m4s{query_suffix}")]
        };
    }
    // Non-standard init name we cannot reason about.
    if file_stem.to_ascii_lowercase().starts_with("init") {
        return Vec::new();
    }

    // Trailing digits are the segment index.
    let digit_count = without_ext
        .bytes()
        .rev()
        .take_while(|b| b.is_ascii_digit())
        .count();
    if digit_count == 0 || digit_count > 9 {
        return Vec::new();
    }
    let split_pos = without_ext.len() - digit_count;
    let prefix = &without_ext[..split_pos];
    if !prefix.ends_with(['-', '_', '/']) {
        return Vec::new();
    }
    let digits = &without_ext[split_pos..];
    let Ok(num) = digits.parse::<u64>() else {
        return Vec::new();
    };

    let mut out: Vec<String> = (1..=u64::from(count))
        .map(|step| {
            let next_num = num + step;
            format!("{prefix}{next_num:0digit_count$}.m4s{query_suffix}")
        })
        .collect();

    // Pair each video segment with the same-index audio segment.
    //
    // The next index is bound to a local first: `format!` cannot inline an
    // expression into a format specifier, so `{num + 1:0…}` would be parsed as
    // a malformed format string rather than as `num + 1`.
    let next_index = num + 1;
    for vid_tag in ["chunk-stream0-", "chunk-stream1-", "chunk-stream2-"] {
        if let Some(dir_prefix) = prefix.strip_suffix(vid_tag) {
            out.push(format!(
                "{dir_prefix}chunk-stream3-{num:0digit_count$}.m4s{query_suffix}"
            ));
            out.push(format!(
                "{dir_prefix}chunk-stream3-{next_index:0digit_count$}.m4s{query_suffix}"
            ));
            break;
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const MPX: &str = r#"<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xsi:schemaLocation="urn:mpeg:dash:schema:mpd:2011 https://standards.iso.org/schema.xsd">
<Period>
  <AdaptationSet>
    <Representation id="1080p">
      <BaseURL>https://sacdn.example.com/dash/123/1080.mp4</BaseURL>
      <SegmentTemplate initialization="https://sacdn.example.com/dash/123/init.m4s" media="seg_$Number$.m4s" />
    </Representation>
  </AdaptationSet>
</Period></MPD>"#;

    #[test]
    fn dash_rewrite_is_scoped_to_target_host() {
        let out = rewrite_dash_manifest(MPX, "/api/playback/SID", Some("sacdn.example.com"), None, None);

        // The XML namespace must survive — an XML round-trip would corrupt it.
        assert!(out.contains("https://standards.iso.org/schema.xsd"));

        // Target host URLs are rerouted.
        assert!(out.contains("/api/playback/SID/https/sacdn.example.com/dash/123/1080.mp4"));
        assert!(out.contains("/api/playback/SID/https/sacdn.example.com/dash/123/init.m4s"));

        // Relative templates must stay relative so they resolve against the
        // proxied manifest URL.
        assert!(out.contains(r#"media="seg_$Number$.m4s""#));
    }

    #[test]
    fn dash_rewrite_preserves_explicit_port() {
        let manifest = r#"<MPD><Period><BaseURL>https://cdn.example.com:8080/dash/seg.mp4</BaseURL></Period></MPD>"#;
        let out = rewrite_dash_manifest(
            manifest,
            "/api/playback/SID",
            Some("cdn.example.com:8080"),
            None,
            None,
        );
        assert!(out.contains("/api/playback/SID/https/cdn.example.com:8080/dash/seg.mp4"));
    }

    #[test]
    fn dash_rewrite_without_host_is_a_no_op() {
        let out = rewrite_dash_manifest(MPX, "/api/playback/SID", None, None, None);
        assert_eq!(out, MPX, "no pinned host -> refuse to rewrite");
    }

    /// The shape MovieBox actually ships: a bare brand, which Chromium will
    /// not parse, so Shaka rejects the whole manifest as unsupported.
    const BARE_BRAND: &str =
        r#"<MPD><Period><AdaptationSet mimeType="video/mp4" codecs="hev1">
    <Representation id="0" bandwidth="489486" width="2160" height="1080">
      <BaseURL>init-stream0.m4s</BaseURL>
    </Representation>
  </AdaptationSet></Period></MPD>"#;

    fn dash(manifest: &str) -> String {
        rewrite_dash_manifest(manifest, "/api/playback/SID", Some("sacdn.example.com"), None, None)
    }

    #[test]
    fn a_bare_hevc_brand_is_expanded_into_a_string_a_browser_will_parse() {
        let out = dash(BARE_BRAND);
        assert!(
            out.contains(r#"codecs="hev1.1.6.L93.B0""#),
            "bare hev1 must be expanded, got:\n{out}"
        );
        assert!(!out.contains(r#"codecs="hev1""#), "bare brand must be gone");
    }

    #[test]
    fn an_already_full_codec_string_is_left_alone() {
        let manifest = r#"<MPD><Period><AdaptationSet mimeType="video/mp4" codecs="hev1.1.60000000.L150.90">
  </AdaptationSet></Period></MPD>"#;
        let out = dash(manifest);
        assert!(
            out.contains(r#"codecs="hev1.1.60000000.L150.90""#),
            "an expanded string must survive untouched, got:\n{out}"
        );
        assert!(!out.contains("L93.B0"), "nothing to expand means no change");
    }

    #[test]
    fn a_bare_avc_brand_is_expanded_too() {
        // Chromium rejects `codecs="avc1"` for the same reason it rejects a
        // bare `hev1`; the next provider that serves H.264 hits this.
        for bare in ["avc1", "avc3"] {
            let manifest = format!(
                r#"<MPD><Period><AdaptationSet mimeType="video/mp4" codecs="{bare}"></AdaptationSet></Period></MPD>"#
            );
            let out = dash(&manifest);
            assert!(
                out.contains(&format!("codecs=\"{bare}.64001F\"")),
                "{bare} must be expanded, got:\n{out}"
            );
        }
    }

    #[test]
    fn expansion_only_touches_the_codecs_attribute() {
        // "hev1" appears in plenty of places that are not a codec declaration.
        let manifest = r#"<MPD><Period><BaseURL>https://sacdn.example.com/dash/hev1_archive.m4s</BaseURL>
    <Representation id="a" codecs="hev1">x</Representation>
  </Period></MPD>"#;
        let out = dash(manifest);
        assert!(
            out.contains("hev1_archive.m4s"),
            "a URL containing the brand must not be rewritten, got:\n{out}"
        );
    }

    #[test]
    fn subtitle_adaptation_set_is_injected() {
        let out = rewrite_dash_manifest(
            MPX,
            "/api/playback/SID",
            Some("sacdn.example.com"),
            Some("https://cdn.example.com/subs/en.vtt"),
            None,
        );
        assert!(out.contains(r#"contentType="text""#));
        assert!(out.contains(r#"mimeType="text/vtt""#));
        assert!(out.contains("/api/playback/SID/sub/"));
        // Injected before the closing Period tag.
        let sub_pos = out.find("contentType=\"text\"").unwrap();
        let period_end = out.find("</Period>").unwrap();
        assert!(sub_pos < period_end, "subtitle set must live inside <Period>");
    }

    #[test]
    fn subtitle_mime_follows_extension() {
        let srt = subtitle_adaptation_set("https://c.example.com/a.srt", "/api/p/S");
        assert!(srt.contains("application/x-subrip"));
        let ass = subtitle_adaptation_set("https://c.example.com/a.ass", "/api/p/S");
        assert!(ass.contains("text/x-ssa"));
    }

    #[test]
    fn representation_filter_caps_height() {
        let manifest = r#"<MPD><Period><AdaptationSet>
    <Representation id="1080" height="1080" bandwidth="800000"><BaseURL>1080.m4s</BaseURL></Representation>
    <Representation id="720" height="720" bandwidth="400000"><BaseURL>720.m4s</BaseURL></Representation>
    <Representation id="480" height="480" bandwidth="200000"><BaseURL>480.m4s</BaseURL></Representation>
  </AdaptationSet></Period></MPD>"#;

        let capped = filter_dash_representations(manifest, 720);
        assert!(!capped.contains(r#"height="1080""#));
        assert!(capped.contains(r#"height="720""#));
        assert!(capped.contains(r#"height="480""#));

        let tighter = filter_dash_representations(manifest, 480);
        assert!(!tighter.contains(r#"height="720""#));
        assert!(tighter.contains(r#"height="480""#));
    }

    #[test]
    fn filter_keeps_smallest_when_cap_below_all() {
        // Nothing is <= 240, so the smallest rendition must survive.
        let manifest = r#"<MPD><Period>
    <Representation id="1080" height="1080"><BaseURL>a</BaseURL></Representation>
    <Representation id="480" height="480"><BaseURL>b</BaseURL></Representation>
  </Period></MPD>"#;
        let out = filter_dash_representations(manifest, 240);
        assert!(!out.contains(r#"height="1080""#));
        assert!(out.contains(r#"height="480""#), "smallest must remain");
    }

    #[test]
    fn filter_ignores_manifest_without_heights() {
        let manifest = r#"<MPD><Period><AdaptationSet><Representation id="a"><BaseURL>x</BaseURL></Representation></AdaptationSet></Period></MPD>"#;
        assert_eq!(filter_dash_representations(manifest, 720), manifest);
    }

    #[test]
    fn prefetch_preserves_padding_and_pairs_audio() {
        let next = next_dash_segment_urls(
            "https://sbcdn3.example.com/dash/123/chunk-stream0-00721.m4s?token=abc",
            3,
        );
        assert_eq!(
            next,
            vec![
                "https://sbcdn3.example.com/dash/123/chunk-stream0-00722.m4s?token=abc",
                "https://sbcdn3.example.com/dash/123/chunk-stream0-00723.m4s?token=abc",
                "https://sbcdn3.example.com/dash/123/chunk-stream0-00724.m4s?token=abc",
                "https://sbcdn3.example.com/dash/123/chunk-stream3-00721.m4s?token=abc",
                "https://sbcdn3.example.com/dash/123/chunk-stream3-00722.m4s?token=abc",
            ],
            "zero padding must survive or the CDN returns 404"
        );
    }

    #[test]
    fn prefetch_pairs_init_segments() {
        assert_eq!(
            next_dash_segment_urls("https://h.example.com/dash/1/init-stream0.m4s", 3),
            vec!["https://h.example.com/dash/1/init-stream3.m4s"]
        );
        assert!(
            next_dash_segment_urls("https://h.example.com/dash/1/init.m4s", 3).is_empty(),
            "unknown init naming -> no guess"
        );
    }

    #[test]
    fn prefetch_ignores_non_segments() {
        assert!(next_dash_segment_urls("https://h.example.com/index.mpd", 3).is_empty());
    }

    #[test]
    fn hls_master_variants_are_rewritten() {
        let playlist = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nhigh/index.m3u8\n";
        let out = rewrite_hls_playlist(
            playlist,
            "/api/playback/SID",
            "https://cdn.example.com/hls/master.m3u8",
        );
        assert!(out.contains("#EXTM3U"));
        assert!(out.contains("#EXT-X-STREAM-INF:BANDWIDTH=800000"));
        assert!(out.contains("/api/playback/SID/https/cdn.example.com/hls/low/index.m3u8"));
        assert!(out.contains("/api/playback/SID/https/cdn.example.com/hls/high/index.m3u8"));
    }

    #[test]
    fn hls_segments_and_keys_are_rewritten() {
        let playlist = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"keys/key.bin\"\n#EXTINF:4.0,\nseg1.ts\n#EXTINF:4.0,\nhttps://other.example.com/seg2.ts\n";
        let out = rewrite_hls_playlist(
            playlist,
            "/api/playback/SID",
            "https://cdn.example.com/hls/index.m3u8",
        );
        assert!(out.contains("/api/playback/SID/https/cdn.example.com/hls/keys/key.bin"));
        assert!(out.contains("/api/playback/SID/https/cdn.example.com/hls/seg1.ts"));
        assert!(out.contains("/api/playback/SID/https/other.example.com/seg2.ts"));
        assert!(out.contains("#EXTINF:4.0,"), "segment markers survive");
    }

    #[test]
    fn hls_leaves_data_uris_alone() {
        let playlist = "#EXTM3U\n#EXT-X-MAP:URI=\"data:application/octet-stream;base64,AAAA\"\n";
        let out = rewrite_hls_playlist(playlist, "/api/playback/SID", "https://c.example.com/i.m3u8");
        assert!(out.contains("data:application/octet-stream"), "inline data must not be proxied");
    }
}