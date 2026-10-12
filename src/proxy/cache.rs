//! In-memory cache for DASH media segments.
//!
//! Ported from the TUI's sidecar. The web case is identical in spirit: CDNs cap
//! how fast a single `.m4s` can be pulled, so segments are fetched once,
//! de-duplicated across concurrent viewers, and served from memory afterwards.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

/// Cached segment: (url, content_type, bytes).
type CachedSegment = (String, String, Arc<[u8]>);

/// Upper bound on cached segments. Each is capped at
/// [`MAX_SEGMENT_BYTES`], so the worst case is ~384 MB — tuned to hold roughly
/// 20 seconds of a multi-bitrate DASH stream.
const MAX_CACHED_SEGMENTS: usize = 24;
/// Reject rather than cache anything larger than this.
pub const MAX_SEGMENT_BYTES: usize = 16 * 1024 * 1024;
/// Size of each parallel range request when assembling a large segment.
pub const DASH_RANGE_CHUNK_BYTES: usize = 95 * 1024;

#[derive(Default)]
pub struct SegmentCache {
    completed: Mutex<VecDeque<CachedSegment>>,
    /// Segments currently being fetched, so a burst of concurrent requests for
    /// the same segment results in one upstream fetch, not N.
    in_flight: Mutex<HashMap<String, Arc<Notify>>>,
}

impl std::fmt::Debug for SegmentCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let completed = self.completed.lock().map(|c| c.len()).unwrap_or(0);
        let in_flight = self.in_flight.lock().map(|c| c.len()).unwrap_or(0);
        f.debug_struct("SegmentCache")
            .field("completed", &completed)
            .field("in_flight", &in_flight)
            .finish()
    }
}

impl SegmentCache {
    pub fn get(&self, url: &str) -> Option<(String, Arc<[u8]>)> {
        let lock = self.completed.lock().ok()?;
        lock.iter()
            .find(|(u, _, _)| u == url)
            .map(|(_, ct, b)| (ct.clone(), Arc::clone(b)))
    }

    /// True if the segment is cached or already being fetched.
    pub fn contains_or_in_flight(&self, url: &str) -> bool {
        if let Ok(lock) = self.completed.lock()
            && lock.iter().any(|(u, _, _)| u == url)
        {
            return true;
        }
        if let Ok(lock) = self.in_flight.lock() {
            return lock.contains_key(url);
        }
        false
    }

    pub fn insert(&self, url: String, content_type: String, data: Arc<[u8]>) {
        let Ok(mut lock) = self.completed.lock() else { return };
        // Never store a duplicate; the first copy wins.
        if lock.iter().any(|(u, _, _)| u == &url) {
            return;
        }
        while lock.len() >= MAX_CACHED_SEGMENTS {
            lock.pop_front();
        }
        lock.push_back((url, content_type, data));
    }

    /// Claim the right to fetch `url`.
    ///
    /// Returns [`FetchClaim::Owner`] to whichever caller won the race — it
    /// must perform the fetch, insert the result, and drop its
    /// [`InFlightGuard`]. Everyone else gets [`FetchClaim::Waiter`] and should
    /// await the notifier, then re-check [`SegmentCache::get`].
    pub fn begin_fetch(&self, url: &str) -> Option<FetchClaim> {
        let mut lock = self.in_flight.lock().ok()?;
        if let Some(existing) = lock.get(url) {
            return Some(FetchClaim::Waiter(Arc::clone(existing)));
        }
        let notify = Arc::new(Notify::new());
        lock.insert(url.to_string(), Arc::clone(&notify));
        Some(FetchClaim::Owner(notify))
    }

    /// Wait on a `notify` handed out by a *previous* `begin_fetch` call.
    pub fn notifier_for(&self, url: &str) -> Option<Arc<Notify>> {
        self.in_flight.lock().ok()?.get(url).map(Arc::clone)
    }

    pub fn end_fetch(&self, url: &str, notify: &Notify) {
        if let Ok(mut lock) = self.in_flight.lock() {
            lock.remove(url);
        }
        notify.notify_waiters();
    }
}

/// Outcome of trying to claim a segment fetch.
#[derive(Debug)]
pub enum FetchClaim {
    /// This caller won the race and must do the upstream fetch.
    Owner(Arc<Notify>),
    /// Another caller is already fetching; wait on this, then re-check cache.
    Waiter(Arc<Notify>),
}

/// RAII helper that clears the in-flight entry even if the fetch task panics or
/// is cancelled mid-flight. Without it, a cancelled fetch would poison the URL
/// forever and every later request would wait on a `Notify` nobody fires.
pub struct InFlightGuard {
    cache: Arc<SegmentCache>,
    url: String,
    notify: Arc<Notify>,
}

impl InFlightGuard {
    pub fn new(cache: Arc<SegmentCache>, url: String, notify: Arc<Notify>) -> Self {
        Self { cache, url, notify }
    }
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.cache.end_fetch(&self.url, &self.notify);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(n: usize) -> Arc<[u8]> {
        Arc::from(vec![7u8; n])
    }

    #[test]
    fn insert_and_get_round_trips() {
        let cache = SegmentCache::default();
        cache.insert("u1".into(), "video/iso.segment".into(), bytes(10));
        let (ct, data) = cache.get("u1").expect("cached");
        assert_eq!(ct, "video/iso.segment");
        assert_eq!(data.len(), 10);
        assert!(cache.get("missing").is_none());
    }

    #[test]
    fn insert_does_not_duplicate() {
        let cache = SegmentCache::default();
        cache.insert("u1".into(), "a".into(), bytes(1));
        cache.insert("u1".into(), "b".into(), bytes(2));
        let (ct, _) = cache.get("u1").unwrap();
        assert_eq!(ct, "a", "first insert wins");
    }

    #[test]
    fn evicts_oldest_past_capacity() {
        let cache = SegmentCache::default();
        for i in 0..(MAX_CACHED_SEGMENTS + 5) {
            cache.insert(format!("u{i}"), "ct".into(), bytes(1));
        }
        assert_eq!(cache.completed.lock().unwrap().len(), MAX_CACHED_SEGMENTS);
        // Oldest entries were dropped.
        assert!(cache.get("u0").is_none());
        assert!(cache.get(&format!("u{}", MAX_CACHED_SEGMENTS + 4)).is_some());
    }

    #[tokio::test]
    async fn only_one_fetcher_wins_the_same_url() {
        let cache = Arc::new(SegmentCache::default());
        let first = cache.begin_fetch("seg").expect("first caller gets a claim");
        assert!(
            matches!(first, FetchClaim::Owner(_)),
            "first caller must win the fetch"
        );

        let second = cache.begin_fetch("seg").expect("second caller gets a claim");
        assert!(
            matches!(second, FetchClaim::Waiter(_)),
            "second caller must wait, not fetch"
        );
        assert!(cache.contains_or_in_flight("seg"));

        if let FetchClaim::Owner(notify) = first {
            cache.end_fetch("seg", &notify);
        }
        assert!(!cache.contains_or_in_flight("seg"));
        // Once the owner finishes, a new caller can win again.
        assert!(matches!(
            cache.begin_fetch("seg"),
            Some(FetchClaim::Owner(_))
        ));
    }

    #[tokio::test]
    async fn waiter_is_woken_when_owner_finishes() {
        let cache = Arc::new(SegmentCache::default());
        let claim = cache.begin_fetch("seg").unwrap();
        let FetchClaim::Owner(notify) = claim else { panic!("expected owner") };

        let waiter_cache = Arc::clone(&cache);
        let waiter = tokio::spawn(async move {
            let waiter_notify = waiter_cache.notifier_for("seg").expect("notifier present");
            waiter_notify.notified().await;
            true
        });

        // Small delay so the waiter task is actually parked on `notified`.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        cache.end_fetch("seg", &notify);

        assert!(waiter.await.unwrap(), "waiter must be woken");
    }

    #[tokio::test]
    async fn guard_clears_in_flight_on_drop() {
        let cache = Arc::new(SegmentCache::default());
        let FetchClaim::Owner(notify) = cache.begin_fetch("seg").unwrap() else {
            panic!("expected owner")
        };
        {
            let _guard = InFlightGuard::new(Arc::clone(&cache), "seg".into(), notify);
            assert!(cache.contains_or_in_flight("seg"));
        }
        // Dropped -> entry cleared, so the URL is fetchable again.
        assert!(!cache.contains_or_in_flight("seg"));
        assert!(matches!(
            cache.begin_fetch("seg"),
            Some(FetchClaim::Owner(_))
        ));
    }
}