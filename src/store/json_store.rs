//! Single-user JSON-file implementation of the store traits.
//!
//! Wraps the existing [`HistoryManager`] and [`FavoritesManager`] rather than
//! reimplementing them: both already do atomic writes, index rebuilds and
//! conflict resolution, and both are proven against real usage.
//!
//! Every method that touches disk runs on `spawn_blocking`, because these
//! managers do synchronous file I/O and blocking the async reactor would stall
//! every in-flight playback request.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use async_trait::async_trait;
use serde::{de::DeserializeOwned, Serialize};

use crate::favorites::{FavoriteItem, FavoritesManager};
use crate::history::{HistoryManager, WatchHistoryItem};
use crate::models::SubjectIdentity;
use crate::store::traits::{Health, Library, SettingsStore, Store, StoreResult};

pub use crate::store::traits::StoreError;

/// A JSON-file-backed store rooted at one directory.
///
/// History and favourites are delegated to the existing managers, which own
/// their own canonical file locations under the user's config directory. The
/// `dir` here is used for the generic [`Store::load_doc`] / [`Store::save_doc`]
/// documents (settings, provider metadata).
///
/// Cloning is cheap and shares state via the `Arc`, so the API layer can hold a
/// single value.
#[derive(Clone)]
pub struct JsonFileStore {
    inner: std::sync::Arc<Inner>,
}

struct Inner {
    dir: RwLock<PathBuf>,
    history: RwLock<HistoryManager>,
    favorites: RwLock<FavoritesManager>,
}

impl JsonFileStore {
    /// Open (creating if needed) a store rooted at `dir`.
    pub fn new(dir: impl AsRef<Path>) -> std::io::Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        std::fs::create_dir_all(&dir)?;

        Ok(Self {
            inner: std::sync::Arc::new(Inner {
                dir: RwLock::new(dir),
                history: RwLock::new(HistoryManager::new()),
                favorites: RwLock::new(FavoritesManager::new()),
            }),
        })
    }

    /// The store's root directory.
    pub fn dir(&self) -> PathBuf {
        self.inner
            .dir
            .read()
            .map(|d| d.clone())
            .unwrap_or_default()
    }

    /// Path for one named document inside the store.
    fn doc_path(&self, key: &str) -> PathBuf {
        self.dir().join(format!("{}.json", sanitize_key(key)))
    }

    /// Reject anything that could escape the store directory.
    ///
    /// Keys come from route parameters in a few places, so this is a real
    /// boundary, not defence-in-depth theatre.
    fn check_key(key: &str) -> StoreResult<()> {
        if key.is_empty() || key.len() > 128 {
            return Err(StoreError::Corrupt(format!("invalid store key `{key}`")));
        }
        if !key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        {
            return Err(StoreError::Corrupt(format!("illegal store key `{key}`")));
        }
        Ok(())
    }

    /// Run a blocking closure against the store without blocking the reactor.
    async fn blocking<T, F>(&self, f: F) -> StoreResult<T>
    where
        F: FnOnce(&Inner) -> StoreResult<T> + Send + 'static,
        T: Send + 'static,
    {
        let inner = std::sync::Arc::clone(&self.inner);
        match tokio::task::spawn_blocking(move || f(&inner)).await {
            Ok(result) => result,
            Err(err) => Err(StoreError::Corrupt(format!("store task failed: {err}"))),
        }
    }
}

/// Reduce a key to something safe for a filename on every supported platform.
fn sanitize_key(key: &str) -> String {
    let cleaned: String = key
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() { "doc".to_string() } else { cleaned }
}

#[async_trait]
impl Library for JsonFileStore {
    async fn history(&self) -> StoreResult<Vec<WatchHistoryItem>> {
        self.blocking(|inner| {
            let guard = inner
                .history
                .read()
                .map_err(|_| StoreError::Corrupt("history lock poisoned".into()))?;
            // Newest first — what the UI shows at the top of "Continue".
            let mut items = guard.recent.clone();
            items.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
            Ok(items)
        })
        .await
    }

    async fn upsert_history(&self, item: WatchHistoryItem) -> StoreResult<()> {
        self.blocking(move |inner| {
            let mut guard = inner
                .history
                .write()
                .map_err(|_| StoreError::Corrupt("history lock poisoned".into()))?;
            let progress = item.progress_seconds;
            let duration = item.duration_seconds;
            let completed = item.completed;
            // `update_progress` owns de-duplication, the watched-set and the
            // 100-entry cap; going through it keeps behaviour identical to the
            // terminal client.
            guard.update_progress(item, progress, duration, completed);
            Ok(())
        })
        .await
    }

    async fn remove_history(&self, provider: &str, subject_id: &str) -> StoreResult<()> {
        let provider = provider.to_string();
        let subject_id = subject_id.to_string();
        self.blocking(move |inner| {
            let mut guard = inner
                .history
                .write()
                .map_err(|_| StoreError::Corrupt("history lock poisoned".into()))?;
            let before = guard.recent.len();
            // `HistoryManager::remove` is per-episode; the web API's delete is
            // per-show, so drop every season/episode of this subject.
            guard.remove_subject(&provider, &subject_id);
            if guard.recent.len() != before {
                guard.save();
            }
            Ok(())
        })
        .await
    }

    async fn clear_history(&self) -> StoreResult<()> {
        self.blocking(|inner| {
            let mut guard = inner
                .history
                .write()
                .map_err(|_| StoreError::Corrupt("history lock poisoned".into()))?;
            guard.clear();
            guard.save();
            Ok(())
        })
        .await
    }

    async fn favorites(&self) -> StoreResult<Vec<FavoriteItem>> {
        self.blocking(|inner| {
            let guard = inner
                .favorites
                .read()
                .map_err(|_| StoreError::Corrupt("favorites lock poisoned".into()))?;
            Ok(guard.items.clone())
        })
        .await
    }

    async fn toggle_favorite(&self, item: FavoriteItem) -> StoreResult<bool> {
        self.blocking(move |inner| {
            let mut guard = inner
                .favorites
                .write()
                .map_err(|_| StoreError::Corrupt("favorites lock poisoned".into()))?;
            let now_favorite = guard.toggle(item);
            guard.save();
            Ok(now_favorite)
        })
        .await
    }

    async fn clear_favorites(&self) -> StoreResult<()> {
        self.blocking(|inner| {
            let mut guard = inner
                .favorites
                .write()
                .map_err(|_| StoreError::Corrupt("favorites lock poisoned".into()))?;
            guard.clear();
            guard.save();
            Ok(())
        })
        .await
    }
}

#[async_trait]
impl SettingsStore for JsonFileStore {
    async fn load_settings(&self) -> StoreResult<Option<serde_json::Value>> {
        let path = self.doc_path("settings");
        self.blocking(move |_| {
            if !path.exists() {
                return Ok(None);
            }
            let bytes = std::fs::read(&path)?;
            match serde_json::from_slice(&bytes) {
                Ok(value) => Ok(Some(value)),
                // A hand-edited settings file shouldn't take the server down;
                // fall back to defaults and let the UI overwrite it.
                Err(err) => {
                    log::warn!("settings file is unreadable ({err}); using defaults");
                    Ok(None)
                }
            }
        })
        .await
    }

    async fn save_settings(&self, value: &serde_json::Value) -> StoreResult<()> {
        let path = self.doc_path("settings");
        let bytes = serde_json::to_vec_pretty(value)
            .map_err(|err| StoreError::Corrupt(err.to_string()))?;
        self.blocking(move |_| {
            // Reuse the cache module's atomic writer so a crash mid-write can
            // never leave a truncated settings file behind.
            crate::cache::atomic_write_file(&path, &bytes).map_err(StoreError::Io)
        })
        .await
    }
}

#[async_trait]
impl Store for JsonFileStore {
    async fn health(&self) -> Health {
        let dir = self.dir();
        // Writability is the only meaningful failure mode for a file store.
        match std::fs::metadata(&dir) {
            Ok(_) => Health {
                healthy: true,
                detail: format!("json store at {}", crate::logging::sanitize_path(&dir)),
            },
            Err(err) => Health {
                healthy: false,
                detail: format!("store directory unavailable: {err}"),
            },
        }
    }

    async fn load_doc<T: DeserializeOwned>(&self, key: &str) -> StoreResult<T> {
        Self::check_key(key)?;
        let path = self.doc_path(key);
        let name = key.to_string();

        // Only the file read happens on the blocking pool. JSON decoding stays
        // on the async side so `load_doc` needs no `Send + 'static` bound on
        // `T`, which would otherwise leak into every caller's signature.
        let bytes: Vec<u8> = self
            .blocking(move |_| {
                std::fs::read(&path).map_err(|err| {
                    if err.kind() == std::io::ErrorKind::NotFound {
                        StoreError::NotFound(name)
                    } else {
                        StoreError::Io(err)
                    }
                })
            })
            .await?;

        serde_json::from_slice(&bytes).map_err(|err| StoreError::Corrupt(err.to_string()))
    }

    async fn save_doc<T: Serialize + Sync + ?Sized>(&self, key: &str, value: &T) -> StoreResult<()> {
        Self::check_key(key)?;
        let path = self.doc_path(key);
        // Serialise before handing off, for the same reason as `load_doc`.
        let bytes = serde_json::to_vec_pretty(value)
            .map_err(|err| StoreError::Corrupt(err.to_string()))?;
        self.blocking(move |_| {
            crate::cache::atomic_write_file(&path, &bytes).map_err(StoreError::Io)
        })
        .await
    }
}

impl JsonFileStore {
    /// Whether a show is currently marked as a favourite.
    pub fn is_favorite(&self, identity: &SubjectIdentity<'_>) -> bool {
        self.inner
            .favorites
            .read()
            .map(|guard| guard.is_favorite(identity))
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (tempfile::TempDir, JsonFileStore) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = JsonFileStore::new(dir.path()).expect("store opens");
        (dir, store)
    }

    #[tokio::test]
    async fn settings_round_trip() {
        let (_dir, store) = temp_store();
        assert!(store.load_settings().await.unwrap().is_none());

        let value = serde_json::json!({ "active_theme": "nord", "tv_enabled": false });
        store.save_settings(&value).await.unwrap();

        let loaded = store.load_settings().await.unwrap().expect("settings present");
        assert_eq!(loaded["active_theme"], "nord");
        assert_eq!(loaded["tv_enabled"], false);
    }

    #[tokio::test]
    async fn corrupt_settings_falls_back_to_defaults() {
        let (_dir, store) = temp_store();
        std::fs::write(store.doc_path("settings"), b"{ not json").unwrap();
        // Must not error — the server has to come up regardless.
        assert!(store.load_settings().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn generic_docs_round_trip() {
        let (_dir, store) = temp_store();

        #[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
        struct Doc {
            count: u32,
            label: String,
        }

        let doc = Doc { count: 7, label: "hi".into() };
        store.save_doc("sample", &doc).await.unwrap();
        let loaded: Doc = store.load_doc("sample").await.unwrap();
        assert_eq!(loaded, doc);
    }

    #[tokio::test]
    async fn missing_doc_reports_not_found() {
        let (_dir, store) = temp_store();
        let err = store
            .load_doc::<serde_json::Value>("absent")
            .await
            .unwrap_err();
        assert!(matches!(err, StoreError::NotFound(_)));
    }

    #[tokio::test]
    async fn keys_cannot_escape_the_store_directory() {
        let (_dir, store) = temp_store();
        for bad in ["../escape", "a/b", "", &"x".repeat(200)] {
            let err = store.save_doc(bad, &serde_json::json!({})).await.unwrap_err();
            assert!(
                matches!(err, StoreError::Corrupt(_)),
                "key `{bad}` should have been rejected"
            );
        }
    }

    #[tokio::test]
    async fn health_reports_a_usable_store() {
        let (_dir, store) = temp_store();
        let health = store.health().await;
        assert!(health.healthy, "detail: {}", health.detail);
    }

    #[tokio::test]
    async fn store_is_shared_between_clones() {
        let (_dir, store) = temp_store();
        let clone = store.clone();
        clone
            .save_doc("shared", &serde_json::json!({ "v": 1 }))
            .await
            .unwrap();
        let loaded: serde_json::Value = store.load_doc("shared").await.unwrap();
        assert_eq!(loaded["v"], 1);
    }

    #[test]
    fn key_sanitisation_replaces_separators() {
        assert_eq!(sanitize_key("a/b"), "a_b");
        assert_eq!(sanitize_key("a.b"), "a_b");
        assert_eq!(sanitize_key("keep-me_1"), "keep-me_1");
        assert_eq!(sanitize_key(""), "doc");
    }
}
