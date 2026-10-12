//! Route modules and the aggregate router.

pub mod catalog;
pub mod downloads;
pub mod library;
pub mod playback;
pub mod system;
pub mod tv;

use axum::Router;

use crate::api::state::AppState;

/// The JSON API, mounted under `/api` by `main`.
///
/// [`catalog::router`] goes first so its more specific paths win over the
/// playback wildcard. Axum 0.8 rejects two routes that could match the same
/// request, so ordering here is load-bearing rather than cosmetic.
pub fn router(state: AppState) -> Router {
    Router::new()
        .merge(catalog::router())
        .merge(library::router())
        .merge(downloads::router())
        .merge(playback::router())
        .merge(tv::router())
        .merge(system::router())
        .route("/health", axum::routing::get(system::health))
        .with_state(state)
}

/// Re-exported so sibling modules can ask about BDIX reachability without
/// reaching two levels into [`system`].
pub use system::bdix_probe;