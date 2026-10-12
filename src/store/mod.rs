//! Persistence layer.
//!
//! ## Why a trait
//!
//! The app currently runs as a single-user localhost server backed by JSON
//! files on disk. Introducing a trait *now* — while there is exactly one
//! implementation — costs almost nothing and keeps the door open: swapping in
//! Postgres (or a per-user partitioned store) later means writing one new
//! impl and changing a type parameter, not auditing every call site.
//!
//! ## Why not just call the managers directly?
//!
//! [`crate::history::HistoryManager`] and [`crate::favorites::FavoritesManager`]
//! are synchronous and mutate in place. Going through an async trait lets a
//! database-backed implementation slot in without changing the API handlers,
//! which are already async.

mod json_store;
pub mod traits;

pub use json_store::{JsonFileStore, StoreError};
pub use traits::{Health, Library, SettingsStore, Store};
