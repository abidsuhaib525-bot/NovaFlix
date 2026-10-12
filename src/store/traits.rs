//! The persistence contracts.

use async_trait::async_trait;
use serde::{de::DeserializeOwned, Serialize};

use crate::favorites::FavoriteItem;
use crate::history::WatchHistoryItem;

/// Result alias for store operations.
pub type StoreResult<T> = Result<T, StoreError>;

/// Errors a store implementation may surface.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("could not access store location: {0}")]
    Io(#[from] std::io::Error),

    #[error("stored data is corrupt: {0}")]
    Corrupt(String),

    #[error("no data stored under `{0}`")]
    NotFound(String),

    #[error("not implemented by this store: {0}")]
    Unsupported(String),
}

/// Liveness probe data.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Health {
    /// `false` means the store cannot currently serve reads or writes.
    pub healthy: bool,
    /// Human-readable detail, shown in the server log and the settings page.
    pub detail: String,
}

/// Watch history and favourites.
///
/// Both are keyed by `(provider, subject_id)`, which is what makes them
/// user-independent today and partitionable later.
#[async_trait]
pub trait Library: Send + Sync {
    /// Everything in the history, newest first.
    async fn history(&self) -> StoreResult<Vec<WatchHistoryItem>>;

    /// Insert or update an entry.
    async fn upsert_history(&self, item: WatchHistoryItem) -> StoreResult<()>;

    /// Delete one entry.
    async fn remove_history(&self, provider: &str, subject_id: &str) -> StoreResult<()>;

    /// Delete everything.
    async fn clear_history(&self) -> StoreResult<()>;

    /// All favourites.
    async fn favorites(&self) -> StoreResult<Vec<FavoriteItem>>;

    /// Insert or remove, returning the resulting membership.
    async fn toggle_favorite(&self, item: FavoriteItem) -> StoreResult<bool>;

    /// Delete every favourite.
    async fn clear_favorites(&self) -> StoreResult<()>;
}

/// User preferences that the TUI persisted in `config.json`.
#[async_trait]
pub trait SettingsStore: Send + Sync {
    /// Read a settings document, or `None` when nothing has been stored yet.
    async fn load_settings(&self) -> StoreResult<Option<serde_json::Value>>;

    /// Overwrite the settings document.
    async fn save_settings(&self, value: &serde_json::Value) -> StoreResult<()>;
}

/// The bundle the API handlers depend on.
///
/// Composed from the smaller traits so a caller can take just the piece it
/// needs, while [`JsonFileStore`] offers all of them at once.
#[async_trait]
pub trait Store: Library + SettingsStore {
    /// A cheap liveness check, surfaced at `/api/health`.
    async fn health(&self) -> Health;

    /// Read an arbitrary cached document.
    async fn load_doc<T: DeserializeOwned>(&self, key: &str) -> StoreResult<T>;

    /// Write an arbitrary cached document.
    ///
    /// T must be Sync because the future borrows it across an await;
    /// ?Sized lets callers pass dyn Trait values without boxing.
    async fn save_doc<T: Serialize + Sync + ?Sized>(&self, key: &str, value: &T) -> StoreResult<()>;
}
