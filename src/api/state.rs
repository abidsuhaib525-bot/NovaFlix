//! Shared server state handed to every handler.
//!
//! One [`AppState`] is built at startup and cloned into each route's state. It
//! owns the long-lived singletons — the provider service, the playback session
//! registry, the download manager, the store — so nothing has to be rebuilt per
//! request. That is a genuine win over the TUI, which re-derived these on every
//! keystroke.

use std::sync::Arc;

use crate::proxy::SessionRegistry;
use crate::service::MovieBoxService;
use crate::store::JsonFileStore;

/// Everything a handler needs.
#[derive(Clone)]
pub struct AppState {
    pub service: Arc<MovieBoxService>,
    pub store: JsonFileStore,
    pub sessions: Arc<SessionRegistry>,
    pub downloads: Arc<crate::api::downloads::DownloadManager>,
    /// Shared upstream client for the playback proxy.
    ///
    /// One client for the whole process means connection pooling to the CDNs
    /// actually works; a per-request client would re-do the TLS handshake for
    /// every segment.
    pub http: reqwest::Client,
}

impl AppState {
    pub fn new(store: JsonFileStore) -> Self {
        let http = crate::proxy::fetch::build_client();
        Self {
            service: Arc::new(MovieBoxService::new()),
            store,
            sessions: Arc::new(SessionRegistry::new()),
            downloads: Arc::new(crate::api::downloads::DownloadManager::new()),
            http,
        }
    }

    /// Kick off the background tasks that keep state tidy.
    ///
    /// Currently: expire idle playback sessions. Called once from `main` after
    /// the state is built, because spawning tasks from a constructor would make
    /// them impossible to control in tests.
    pub fn spawn_background_tasks(&self) {
        Arc::clone(&self.sessions).spawn_reaper();
    }
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("sessions", &self.sessions.len())
            .finish_non_exhaustive()
    }
}
