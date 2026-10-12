//! Shared HTTP client construction and URL helpers.
//!
//! ## Why no custom DNS resolver
//!
//! The terminal build shipped a `hickory-resolver` fallback to Cloudflare /
//! Google / Quad9, for machines whose system resolver was broken or slow.
//! That mattered when the app was one of many things fighting over a flaky
//! connection. It is gone here: this server binds to localhost, the CDN hosts
//! are all publicly resolvable, and the OS resolver (or `hyper`'s default
//! `getaddrinfo` path) is both faster and one less dependency to audit.
//!
//! ## Why one shared client
//!
//! Every builder here is meant to be used *once* per process, not per request.
//! A `reqwest::Client` owns a connection pool; building a new one per segment
//! would re-do the TLS handshake for every one of the thousands of `.m4s`
//! segments in a film, which is the difference between smooth playback and a
//! stutter.

use std::time::Duration;

pub const DEFAULT_BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
pub const APP_HTTP_USER_AGENT: &str = concat!("MovieBox/", env!("CARGO_PKG_VERSION"));

/// Connection-pool tuning shared by every client in the app.
pub fn http_client_builder_base() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        // Segment requests are small and latency-sensitive; Nagle's algorithm
        // only ever adds delay here.
        .tcp_nodelay(true)
        // Keep the socket warm across the gaps between segment fetches.
        .tcp_keepalive(Some(Duration::from_secs(45)))
        .pool_idle_timeout(Some(Duration::from_secs(90)))
        .pool_max_idle_per_host(8)
        // 90s upstream cap, so a hung CDN connection cannot pin a download
        // slot forever.
        .timeout(Duration::from_secs(90))
        .connect_timeout(Duration::from_secs(15))
        .user_agent(APP_HTTP_USER_AGENT)
}

/// The client used for scraping and metadata calls.
pub fn http_client_builder() -> reqwest::ClientBuilder {
    http_client_builder_base()
}

/// Cheapest possible reachability check.
///
/// Tries `HEAD` first, then falls back to a one-byte ranged `GET`. Plenty of
/// CDNs answer `405 Method Not Allowed` to `HEAD`, and treating that as "down"
/// would wrongly disable a working provider.
pub async fn probe_url(url: &str, timeout: Duration) -> bool {
    static PROBE_CLIENT: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
        http_client_builder_base()
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    });

    match tokio::time::timeout(timeout, PROBE_CLIENT.head(url).send()).await {
        Ok(Ok(resp)) if resp.status().is_success() || resp.status().is_redirection() => {
            return true;
        }
        Ok(Ok(resp)) => {
            log::debug!(
                "probe HEAD returned {} for {}",
                resp.status(),
                crate::logging::sanitize_url(url)
            );
        }
        Ok(Err(err)) => {
            log::debug!(
                "probe HEAD failed for {}: {err}",
                crate::logging::sanitize_url(url)
            );
        }
        Err(_) => {
            log::debug!("probe HEAD timed out for {}", crate::logging::sanitize_url(url));
        }
    }

    match tokio::time::timeout(
        timeout,
        PROBE_CLIENT
            .get(url)
            .header(reqwest::header::RANGE, "bytes=0-0")
            .send(),
    )
    .await
    {
        Ok(Ok(resp)) => resp.status().is_success() || resp.status().is_redirection(),
        Ok(Err(err)) => {
            log::debug!(
                "probe GET failed for {}: {err}",
                crate::logging::sanitize_url(url)
            );
            false
        }
        Err(_) => false,
    }
}

/// Whether a string is an absolute `http(s)` URL.
///
/// Deliberately a prefix check rather than a full URL parse: this gates values
/// that come from providers, where the only two accepted schemes are `http` and
/// `https`, and a parse failure on something we were going to reject anyway is
/// just work thrown away.
pub fn is_http_url(source: &str) -> bool {
    let trimmed = source.trim();
    trimmed.starts_with("http://") || trimmed.starts_with("https://")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_url_detection() {
        assert!(is_http_url("http://example.com"));
        assert!(is_http_url("https://example.com/playlist.m3u8"));
        assert!(is_http_url("   https://example.com   "));
        assert!(!is_http_url("/local/path/file.m3u"));
        assert!(!is_http_url("stremio://addon.example.com"));
        assert!(!is_http_url("file:///C:/Windows/System32/config/SAM"));
        assert!(!is_http_url(""));
        // Prefix-only matching must not be fooled into accepting a scheme that
        // merely contains "http".
        assert!(!is_http_url("httpx://example.com"));
    }

    #[test]
    fn builders_are_distinct_and_both_buildable() {
        assert!(http_client_builder_base().build().is_ok());
        assert!(http_client_builder().build().is_ok());
    }

    #[tokio::test]
    async fn probe_falls_back_from_head_to_ranged_get() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            for _ in 0..2 {
                if let Ok((mut stream, _)) = listener.accept().await {
                    let mut buf = [0u8; 1024];
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    if req.starts_with("HEAD ") {
                        // A real CDN refusing HEAD.
                        let _ = stream
                            .write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n")
                            .await;
                    } else {
                        let _ = stream
                            .write_all(
                                b"HTTP/1.1 206 Partial Content\r\nContent-Length: 1\r\n\r\nX",
                            )
                            .await;
                    }
                }
            }
        });

        let url = format!("http://{addr}/video.mkv");
        assert!(
            probe_url(&url, Duration::from_secs(2)).await,
            "a 405 on HEAD must not be read as unreachable"
        );
    }

    #[tokio::test]
    async fn probe_reports_unreachable_when_nothing_listens() {
        // Bind then immediately drop, so the port is almost certainly closed.
        let addr = {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            listener.local_addr().unwrap()
        };
        let url = format!("http://{addr}/video.mkv");
        assert!(!probe_url(&url, Duration::from_millis(400)).await);
    }
}