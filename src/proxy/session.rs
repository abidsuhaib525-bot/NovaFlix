//! Playback session registry.
//!
//! In the TUI, each playback spawned a detached TCP "sidecar" process holding
//! one stream's auth headers in memory. On the web there is no process to
//! spawn, so the same lifetime is modelled as a server-side session: the
//! browser holds an opaque id and every subsequent manifest/segment request
//! carries it.
//!
//! A session is deliberately pinned to exactly one target host. That pinning is
//! the SSRF guard — without it, `/api/playback/{sid}/...` would be an open
//! proxy that any browser script could aim at the server's LAN.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;

use crate::providers::models::{PlaybackSource, ProviderError};
use crate::proxy::cache::SegmentCache;

/// Sessions idle for longer than this are reaped.
const SESSION_IDLE_TTL: Duration = Duration::from_secs(30 * 60);
/// Hard cap on concurrent sessions, so a runaway client cannot exhaust memory.
const MAX_SESSIONS: usize = 64;
/// Above this the oldest session is evicted to make room.
const SOFT_SESSION_LIMIT: usize = 48;

static SESSION_SEQ: AtomicU64 = AtomicU64::new(1);

/// One external subtitle track the browser may fetch through this session.
///
/// The web player registers these itself, with Shaka's `addTextTrackAsync`,
/// rather than relying on a DASH `AdaptationSet`: MovieBox serves standalone
/// SRT/SSA files, and Shaka parses those formats directly. The session carries
/// the list for one reason — [`PlaybackSession::is_host_allowed`] has to
/// whitelist every subtitle host, or the `/sub/` proxy route answers 403 and the
/// tracks silently fail to load.
///
/// `lang` and `label` are echoed back to the player; only `url` is security
/// relevant.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct PlaybackSubtitle {
    pub url: String,
    #[serde(default)]
    pub lang: String,
    #[serde(default)]
    pub label: String,
}

/// One active playback: the upstream URL plus everything needed to talk to it.
#[derive(Debug)]
pub struct PlaybackSession {
    /// Opaque, unguessable id handed to the browser.
    pub id: String,
    pub provider: crate::providers::models::ProviderKind,
    /// The original upstream URL (the manifest or media file).
    pub target_url: String,
    /// `host[:port]` of `target_url`. Every proxied request must match this,
    /// or match `subtitle_host`.
    pub target_host: Option<String>,
    pub subtitle_url: Option<String>,
    pub subtitle_host: Option<String>,
    /// External subtitle tracks offered to the web player.
    ///
    /// Separate from `subtitle_url`, which is the single track the TUI-era
    /// manifest injection consumed. This list is the web path's source of truth
    /// for which subtitle hosts the proxy will fetch from.
    pub subtitles: Vec<PlaybackSubtitle>,
    /// Headers the CDN requires (auth token, Referer, spoofed IP, ...).
    pub auth_headers: Vec<(String, String)>,
    /// Height cap applied by `rewrite_dash_manifest`.
    pub max_height: Option<u64>,
    pub source_label: String,
    pub segment_cache: Arc<SegmentCache>,
    /// Rewritten manifest bytes, keyed by the URL they were rewritten for.
    pub manifest_cache: Arc<std::sync::Mutex<Option<(String, Arc<[u8]>)>>>,
    pub created_at: Instant,
    pub last_activity: Arc<std::sync::Mutex<Instant>>,
}

impl PlaybackSession {
    /// Build a session from a resolved `PlaybackSource`.
    ///
    /// Returns `NotFound` when the source URL is not an absolute http(s) URL,
    /// which also serves as the first line of the SSRF defence.
    pub fn from_source(source: &PlaybackSource) -> Result<Self, ProviderError> {
        if !crate::util::url::is_http_url(&source.url) {
            return Err(ProviderError::Unavailable(
                "Playback source is not a valid http(s) URL".into(),
            ));
        }

        let subtitle_host = source
            .subtitle
            .as_deref()
            .and_then(crate::util::url::extract_host_authority);

        Ok(Self {
            id: generate_session_id(),
            provider: source.provider,
            target_url: source.url.clone(),
            target_host: crate::util::url::extract_host_authority(&source.url),
            subtitle_url: source.subtitle.clone(),
            subtitle_host,
            subtitles: Vec::new(),
            auth_headers: source.headers.clone(),
            max_height: source.max_height.filter(|&h| h > 0),
            source_label: source.source_label.clone(),
            segment_cache: Arc::new(SegmentCache::default()),
            manifest_cache: Arc::new(std::sync::Mutex::new(None)),
            created_at: Instant::now(),
            last_activity: Arc::new(std::sync::Mutex::new(Instant::now())),
        })
    }

    /// Record activity so the reaper leaves this session alone.
    pub fn touch(&self) {
        if let Ok(mut lock) = self.last_activity.lock() {
            *lock = Instant::now();
        }
    }

    /// True when the session has been idle past the TTL.
    pub fn is_expired(&self) -> bool {
        self.last_activity
            .lock()
            .map(|last| last.elapsed() > SESSION_IDLE_TTL)
            .unwrap_or(false)
    }

    /// Path prefix the browser must use to reach this session's proxy.
    pub fn proxy_base(&self) -> String {
        format!("/api/playback/{}", self.id)
    }

    /// Whether a host is allowed through this session's proxy.
    ///
    /// Mirrors the TUI's whitelist exactly: the target host, plus the
    /// subtitle host when one was supplied.
    pub fn is_host_allowed(&self, url: &str) -> bool {
        let Some(extracted) = crate::util::url::extract_host_authority(url) else {
            return false;
        };
        // A session with no parseable target host allows nothing.
        let Some(target) = self.target_host.as_deref() else {
            return false;
        };
        if extracted == target {
            return true;
        }
        // The single legacy subtitle host, then every host named by a subtitle
        // track the browser registered. Membership is checked against the
        // *host*, never the full URL, so a signed path cannot widen the allow
        // list.
        if self.subtitle_host.as_deref() == Some(extracted.as_str()) {
            return true;
        }
        self.subtitles.iter().any(|sub| {
            crate::util::url::extract_host_authority(&sub.url).as_deref() == Some(extracted.as_str())
        })
    }

    /// Whether to forward the full header set (same host) or only UA + Referer.
    pub fn forwards_all_headers(&self, url: &str) -> bool {
        crate::util::url::extract_host_authority(url) == self.target_host
    }
}

/// Generate a 128-bit random session id.
///
/// Cryptographic randomness matters here: the id is the only thing
/// authenticating a request to the proxy, so it must not be guessable.
fn generate_session_id() -> String {
    // One 128-bit draw formatted as 32 hex characters, rather than filling a
    // byte buffer. `rand::random` pulls from the thread RNG, which is seeded
    // from the OS CSPRNG at startup, so this is unpredictable without paying
    // for a `getrandom` syscall per byte.
    format!("{:032x}", rand::random::<u128>())
}

/// Process-wide registry of live playback sessions.
#[derive(Debug, Default)]
pub struct SessionRegistry {
    sessions: DashMap<String, Arc<PlaybackSession>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a new session, evicting idle/overflow sessions as needed.
    pub fn insert(&self, session: PlaybackSession) -> Arc<PlaybackSession> {
        self.reap_expired();

        while self.sessions.len() >= SOFT_SESSION_LIMIT {
            let Some(victim) = self.oldest_session_id() else { break };
            self.sessions.remove(&victim);
            log::debug!("playback session {victim} evicted (session limit)");
        }
        let _ = MAX_SESSIONS;

        let id = session.id.clone();
        let arc = Arc::new(session);
        self.sessions.insert(id, Arc::clone(&arc));
        arc
    }

    pub fn get(&self, id: &str) -> Option<Arc<PlaybackSession>> {
        let session = self.sessions.get(id).map(|s| Arc::clone(s.value()))?;
        session.touch();
        Some(session)
    }

    pub fn remove(&self, id: &str) {
        self.sessions.remove(id);
    }

    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    /// Drop sessions idle past the TTL.
    pub fn reap_expired(&self) {
        self.sessions.retain(|_, session| !session.is_expired());
    }

    /// Spawn the periodic reaper. Runs until the process exits.
    pub fn spawn_reaper(self: Arc<Self>) {
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(60));
            ticker.tick().await; // first tick fires immediately
            loop {
                ticker.tick().await;
                let before = self.sessions.len();
                self.reap_expired();
                let removed = before.saturating_sub(self.sessions.len());
                if removed > 0 {
                    log::debug!("reaped {removed} idle playback session(s)");
                }
            }
        });
    }

    /// The least-recently-touched session id, for overflow eviction.
    fn oldest_session_id(&self) -> Option<String> {
        let mut oldest: Option<(Instant, String)> = None;
        for entry in self.sessions.iter() {
            let last = entry
                .value()
                .last_activity
                .lock()
                .map(|l| *l)
                .unwrap_or(entry.value().created_at);
            match &oldest {
                Some((best, _)) if *best <= last => {}
                _ => oldest = Some((last, entry.key().clone())),
            }
        }
        oldest.map(|(_, id)| id)
    }
}

/// Monotonic counter used for download task ids.
pub fn next_task_id() -> u64 {
    SESSION_SEQ.fetch_add(1, Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::models::ProviderKind;

    fn source(url: &str, subtitle: Option<&str>) -> PlaybackSource {
        PlaybackSource {
            provider: ProviderKind::MovieBox,
            url: url.to_string(),
            headers: vec![("x-client-token".into(), "abc".into())],
            subtitle: subtitle.map(str::to_string),
            source_label: "Direct".into(),
            max_height: None,
        }
    }

    #[test]
    fn session_ids_are_unique_and_long() {
        let a = generate_session_id();
        let b = generate_session_id();
        assert_ne!(a, b, "ids must not repeat");
        assert_eq!(a.len(), 32, "128-bit id as hex");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn host_whitelist_allows_target_and_subtitle_only() {
        let s = PlaybackSession::from_source(&source(
            "https://video.example.com/dash/index.mpd",
            Some("https://captions.example.com/sub.vtt"),
        ))
        .unwrap();

        assert!(s.is_host_allowed("https://video.example.com/chunk.m4s"));
        assert!(s.is_host_allowed("https://captions.example.com/sub.vtt"));
        assert!(!s.is_host_allowed("https://evil.example.com/steal"));
        assert!(!s.is_host_allowed("http://127.0.0.1:8080/"));
    }

    #[test]
    fn host_whitelist_includes_every_registered_subtitle_host() {
        let mut s =
            PlaybackSession::from_source(&source("https://video.example.com/dash/index.mpd", None))
                .unwrap();
        s.subtitles = vec![
            PlaybackSubtitle {
                url: "https://subs-a.example.com/en.srt".into(),
                lang: "en".into(),
                label: "English".into(),
            },
            PlaybackSubtitle {
                url: "https://subs-b.example.com/ur.srt".into(),
                lang: "ur".into(),
                label: "Urdu".into(),
            },
        ];

        assert!(s.is_host_allowed("https://video.example.com/chunk.m4s"));
        assert!(s.is_host_allowed("https://subs-a.example.com/en.srt"));
        assert!(s.is_host_allowed("https://subs-b.example.com/ur.srt"));
        // Matching is host-exact: a lookalike host must not slip through.
        assert!(!s.is_host_allowed("https://subs-a.example.com.evil.test/x.srt"));
        assert!(!s.is_host_allowed("https://evil.example.com/steal"));
    }

    #[test]
    fn session_without_parseable_host_allows_nothing() {
        // Not an http(s) URL at all -> rejected at construction.
        assert!(PlaybackSession::from_source(&source("file:///etc/passwd", None)).is_err());
    }

    #[test]
    fn full_headers_only_for_target_host() {
        let s = PlaybackSession::from_source(&source(
            "https://video.example.com/dash/index.mpd",
            Some("https://captions.example.com/sub.vtt"),
        ))
        .unwrap();

        assert!(s.forwards_all_headers("https://video.example.com/a.m4s"));
        assert!(!s.forwards_all_headers("https://captions.example.com/sub.vtt"));
    }

    #[test]
    fn registry_inserts_gets_and_removes() {
        let reg = SessionRegistry::new();
        let session = PlaybackSession::from_source(&source("https://a.example.com/x.mpd", None)).unwrap();
        let id = session.id.clone();

        assert!(reg.is_empty());
        reg.insert(session);
        assert_eq!(reg.len(), 1);
        assert!(reg.get(&id).is_some());
        assert!(reg.get("does-not-exist").is_none());

        reg.remove(&id);
        assert!(reg.is_empty());
    }

    #[test]
    fn registry_evicts_when_over_soft_limit() {
        let reg = SessionRegistry::new();
        for _ in 0..(SOFT_SESSION_LIMIT + 4) {
            reg.insert(
                PlaybackSession::from_source(&source("https://a.example.com/x.mpd", None)).unwrap(),
            );
        }
        assert!(
            reg.len() <= SOFT_SESSION_LIMIT,
            "registry must stay bounded, got {}",
            reg.len()
        );
    }

    #[test]
    fn max_height_zero_is_treated_as_unset() {
        let mut src = source("https://a.example.com/x.mpd", None);
        src.max_height = Some(0);
        let s = PlaybackSession::from_source(&src).unwrap();
        assert_eq!(s.max_height, None);
    }

    #[test]
    fn proxy_base_contains_session_id() {
        let s = PlaybackSession::from_source(&source("https://a.example.com/x.mpd", None)).unwrap();
        assert_eq!(s.proxy_base(), format!("/api/playback/{}", s.id));
    }
}