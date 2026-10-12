//! Server-side download manager.
//!
//! The TUI downloaded inline and drew a progress bar. On the web the work moves
//! to the server (a browser tab can be closed mid-transfer) and progress is
//! pushed to the UI over SSE.
//!
//! ## Resuming
//!
//! [`crate::download::download`] already implements HTTP range resume via its
//! `.part` sidecar. Pausing sets the cancel flag, which makes it return
//! [`DownloadOutcome::Paused`] cleanly; resuming calls it again and it picks up
//! from the byte it stopped at. Cancelling additionally deletes the partial
//! files, which resuming deliberately does not.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::download::{download, DownloadOutcome};

/// Tasks retained after completion, so the UI can show what finished.
const MAX_RETAINED_TASKS: usize = 200;
/// Broadcast channel capacity. Slow SSE clients just miss intermediate frames.
const PROGRESS_CHANNEL_CAPACITY: usize = 256;

/// The API-visible state of one download.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Queued,
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

impl TaskState {
    /// Whether this task still occupies a slot and counts toward `active`.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

/// One row in the downloads table.
#[derive(Debug, Clone, Serialize)]
pub struct DownloadTask {
    pub id: String,
    pub filename: String,
    pub title: String,
    pub state: TaskState,
    /// 0.0–100.0. `None` when the server never sent a `Content-Length`.
    pub progress: Option<f32>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub speed_bps: Option<f64>,
    pub error: Option<String>,
    pub path: Option<String>,
}

/// A progress frame pushed over SSE.
#[derive(Debug, Clone, Serialize)]
pub struct ProgressEvent {
    pub id: String,
    pub state: TaskState,
    pub progress: Option<f32>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub speed_bps: Option<f64>,
    pub error: Option<String>,
}

/// Server-side record of a download.
struct Task {
    id: String,
    filename: String,
    title: String,
    destination: PathBuf,
    state: TaskState,
    downloaded: u64,
    total: Option<u64>,
    percent: Option<f32>,
    speed_bps: Option<f64>,
    error: Option<String>,
    /// The upstream URL. Kept private to this struct — see
    /// [`DownloadManager::resume_target`].
    url: String,
    /// The auth headers the CDN requires, for the same reason.
    headers: Vec<(String, String)>,
    /// Set to ask the in-flight download to stop at the next chunk boundary.
    cancel: Arc<AtomicBool>,
    /// Handle to the running task, so pause/cancel can signal it.
    handle: Option<tokio::task::JoinHandle<()>>,
}

/// Everything needed to restart a paused transfer.
#[derive(Clone, Debug)]
pub struct ResumeTarget {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub destination: PathBuf,
    pub title: String,
}

/// Owns every download the server is running.
///
/// Deliberately not `Debug`: `Task` holds a `JoinHandle` and the manager's
/// useful debug view is [`DownloadManager::snapshot`], which is serialisable.
/// Deriving it here would either fail to compile or print a wall of noise.
pub struct DownloadManager {
    tasks: DashMap<String, Task>,
    events: broadcast::Sender<ProgressEvent>,
    /// Insertion order, so we can evict old finished tasks.
    order: parking_lot_like::Mutex<Vec<String>>,
}

/// Tiny shim so the manager does not depend on `parking_lot` directly.
mod parking_lot_like {
    pub use std::sync::Mutex;
}

impl DownloadManager {
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(PROGRESS_CHANNEL_CAPACITY);
        Self {
            tasks: DashMap::new(),
            events,
            order: parking_lot_like::Mutex::new(Vec::new()),
        }
    }

    /// Subscribe to progress updates.
    pub fn subscribe(&self) -> broadcast::Receiver<ProgressEvent> {
        self.events.subscribe()
    }

    /// Current state of every task, newest first.
    pub fn snapshot(&self) -> Vec<DownloadTask> {
        let mut tasks: Vec<DownloadTask> = self.tasks.iter().map(|entry| entry.view()).collect();
        tasks.reverse();
        tasks
    }

    /// Look up one task's public view.
    pub fn get(&self, id: &str) -> Option<DownloadTask> {
        self.tasks.get(id).map(|entry| entry.view())
    }

    /// Queue a download.
    ///
    /// Returns the new task id. The transfer starts immediately in the
    /// background; the HTTP response carries only the id, because a multi-
    /// gigabyte download must not hold the request open.
    pub fn enqueue(
        self: &Arc<Self>,
        url: String,
        headers: Vec<(String, String)>,
        destination: PathBuf,
        title: String,
        initial_total: Option<u64>,
    ) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let filename = destination
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "download".to_string());

        let authed = authed_client(&headers);
        let cancel = Arc::new(AtomicBool::new(false));
        let progress_cancel = Arc::clone(&cancel);

        let task = Task {
            id: id.clone(),
            filename,
            title,
            destination: destination.clone(),
            state: TaskState::Running,
            downloaded: 0,
            total: initial_total,
            percent: None,
            speed_bps: None,
            error: None,
            url: url.clone(),
            headers: headers.clone(),
            cancel: Arc::clone(&cancel),
            handle: None,
        };

        if let Ok(mut order) = self.order.lock() {
            order.push(id.clone());
        }
        self.tasks.insert(id.clone(), task);

        let manager = Arc::clone(self);
        let run_id = id.clone();
        let run_headers = headers.clone();
        let handle = tokio::spawn(async move {
            manager
                .run(run_id, authed, url, run_headers, destination, progress_cancel)
                .await;
        });

        if let Some(mut entry) = self.tasks.get_mut(&id) {
            entry.handle = Some(handle);
        }

        self.evict_finished();
        self.emit(&id);
        id
    }

    /// The transfer loop for one task.
    ///
    /// Owns all state transitions from here: the download itself, progress
    /// reporting into the store, and the terminal state on every exit path.
    async fn run(
        self: Arc<Self>,
        id: String,
        client: reqwest::Client,
        url: String,
        headers: Vec<(String, String)>,
        destination: PathBuf,
        cancel: Arc<AtomicBool>,
    ) {
        let was_cancelled = matches!(
            self.tasks.get(&id).map(|entry| entry.state),
            Some(TaskState::Cancelled)
        );

        // Throttle SSE frames: the downloader reports very frequently and each
        // frame is a broadcast to every connected browser.
        let mut last_emit = std::time::Instant::now();
        let reporter = |downloaded: u64,
                        total: Option<u64>,
                        percent: Option<f32>,
                        speed_bps: f64,
                        last_emit: &mut std::time::Instant| {
            if last_emit.elapsed() < std::time::Duration::from_millis(400) {
                return;
            }
            *last_emit = std::time::Instant::now();
            if let Some(mut entry) = self.tasks.get_mut(&id) {
                if !Arc::ptr_eq(&entry.cancel, &cancel) {
                    return;
                }
                entry.downloaded = downloaded;
                if total.is_some() {
                    entry.total = total;
                }
                if percent.is_some() {
                    entry.percent = percent;
                }
                entry.speed_bps = Some(speed_bps);
            }
            self.emit(&id);
        };

        let is_adaptive = crate::api::routes::downloads::is_adaptive_source_url(&url);
        let result = if is_adaptive {
            crate::download::download_adaptive(&url, &headers, &destination, cancel.clone(), |progress| {
                reporter(
                    progress.downloaded,
                    progress.total,
                    progress.percent,
                    progress.bytes_per_second,
                    &mut last_emit,
                );
            })
            .await
        } else {
            download(&client, &url, &destination, cancel.clone(), |progress| {
                reporter(
                    progress.downloaded,
                    progress.total,
                    progress.percent,
                    progress.bytes_per_second,
                    &mut last_emit,
                );
            })
            .await
        };

        // Final frame, so the UI lands on an exact number rather than
        // whatever the last throttled update happened to show.
        if let Some(mut entry) = self.tasks.get_mut(&id) {
            if !Arc::ptr_eq(&entry.cancel, &cancel) {
                return;
            }
            match &result {
                Ok(DownloadOutcome::Completed { bytes }) => {
                    entry.downloaded = *bytes;
                    entry.total = Some(*bytes);
                    entry.percent = Some(100.0);
                    entry.error = None;
                }
                Ok(DownloadOutcome::Paused { bytes }) => {
                    if *bytes > 0 {
                        entry.downloaded = *bytes;
                    }
                }
                Err(_) => {}
            }

            let was_paused = entry.state == TaskState::Paused;

            // `pause()` and `cancel()` trip the same flag, and the downloader
            // reports "stopped at N bytes" for both, so the loop must not map
            // every pause-shaped outcome to `Paused`: a cancel marks the task
            // `Cancelled` first and that intent must win.
            entry.state = match &result {
                Ok(outcome) => terminal_state(entry.state, outcome),
                Err(_) if was_cancelled => TaskState::Cancelled,
                Err(_) if was_paused => TaskState::Paused,
                Err(_) => TaskState::Failed,
            };
        }

        if let Err(err) = &result {
            let message = err.user_message();
            // A pause/cancel surfaces as an error from the inner downloader;
            // don't show it to the user, they asked for it.
            let suppress = matches!(
                self.tasks.get(&id).map(|entry| entry.state),
                Some(TaskState::Paused) | Some(TaskState::Cancelled)
            );
            if !suppress {
                log::warn!("download failed: {message}");
            }
            if let Some(mut entry) = self.tasks.get_mut(&id) {
                entry.error = if suppress { None } else { Some(message) };
            }
        }

        // A cancelled task discards its partial state. `cancel()` removes the
        // files too, but the loop writes a resume sidecar when it stops, so a
        // cancel that races the stop would otherwise leave the `.part.json`
        // behind.
        let cancelled = was_cancelled
            || matches!(
                self.tasks.get(&id).map(|entry| entry.state),
                Some(TaskState::Cancelled)
            );
        if cancelled {
            let _ = std::fs::remove_file(&destination);
            let _ = std::fs::remove_file(sidecar(&destination, "part"));
            let _ = std::fs::remove_file(sidecar(&destination, "part.json"));
        }

        self.emit(&id);
    }

    /// Everything needed to restart a paused transfer.
    ///
    /// Resuming needs the original URL and headers, which are deliberately not
    /// exposed through the public [`DownloadTask`] view — a signed URL in a
    /// list response would leak into browser memory and logs for no reason.
    pub fn resume_target(&self, id: &str) -> Option<ResumeTarget> {
        let entry = self.tasks.get(id)?;
        if entry.state != TaskState::Paused && entry.state != TaskState::Failed {
            return None;
        }
        Some(ResumeTarget {
            url: entry.url.clone(),
            headers: entry.headers.clone(),
            destination: entry.destination.clone(),
            title: entry.title.clone(),
        })
    }

    /// Restart a paused transfer under the same id.
    ///
    /// The `.part` file is left in place, which is what lets
    /// [`crate::download::download`] continue from the byte it stopped at
    /// rather than starting over.
    pub fn enqueue_resumed(
        self: &Arc<Self>,
        id: &str,
        target: ResumeTarget,
    ) -> bool {
        if !self.tasks.contains_key(id) {
            return false;
        }

        let authed = authed_client(&target.headers);
        let cancel = Arc::new(AtomicBool::new(false));

        if let Some(mut entry) = self.tasks.get_mut(id) {
            if let Some(old_handle) = entry.handle.take() {
                old_handle.abort();
            }
            entry.cancel = Arc::clone(&cancel);
            entry.state = TaskState::Running;
            entry.error = None;
        }

        let manager = Arc::clone(self);
        let run_id = id.to_string();
        let destination = target.destination;
        let url = target.url;
        let headers = target.headers;
        let handle = tokio::spawn(async move {
            manager
                .run(run_id, authed, url, headers, destination, cancel)
                .await;
        });

        if let Some(mut entry) = self.tasks.get_mut(id) {
            entry.handle = Some(handle);
        }
        self.emit(id);
        true
    }

    /// Ask a running download to stop, keeping its partial file.
    ///
    /// Returns `false` when the id is unknown or the task already finished.
    pub fn pause(&self, id: &str) -> bool {
        let Some(mut entry) = self.tasks.get_mut(id) else {
            return false;
        };
        if entry.state == TaskState::Paused {
            return true;
        }
        if entry.state.is_terminal() {
            return false;
        }
        entry.cancel.store(true, Ordering::Relaxed);
        entry.state = TaskState::Paused;
        drop(entry);
        self.emit(id);
        true
    }

    /// Cancel and discard partial files.
    pub fn cancel(&self, id: &str) -> bool {
        let Some(mut entry) = self.tasks.get_mut(id) else {
            return false;
        };
        if entry.state.is_terminal() {
            return false;
        }
        entry.cancel.store(true, Ordering::Relaxed);
        entry.state = TaskState::Cancelled;

        let destination = entry.destination.clone();
        drop(entry);
        // Best effort: the running task also cleans up when it observes the flag.
        tokio::spawn(async move {
            let _ = tokio::fs::remove_file(&destination).await;
            let _ = tokio::fs::remove_file(sidecar(&destination, "part")).await;
            let _ = tokio::fs::remove_file(sidecar(&destination, "part.json")).await;
        });
        // A paused task has no loop running to announce the cancel, so push the
        // frame here; a running loop's own exit frame carries the same values.
        self.emit(id);
        true
    }

    /// Forget a task entirely, including its file on disk.
    pub async fn remove(&self, id: &str) -> bool {
        let Some((_, task)) = self.tasks.remove(id) else {
            return false;
        };
        task.cancel.store(true, Ordering::Relaxed);
        if let Ok(mut order) = self.order.lock() {
            order.retain(|entry| entry != id);
        }

        // A completed download's file is the user's — don't delete it.
        if task.state != TaskState::Completed {
            let _ = tokio::fs::remove_file(sidecar(&task.destination, "part")).await;
            let _ = tokio::fs::remove_file(sidecar(&task.destination, "part.json")).await;
        }
        true
    }

    /// Forget every finished/failed task, leaving active ones running.
    pub fn clear_finished(&self) {
        let ids: Vec<String> = self
            .tasks
            .iter()
            .filter(|entry| entry.state.is_terminal())
            .map(|entry| entry.key().clone())
            .collect();
        for id in &ids {
            self.tasks.remove(id);
        }
        if let Ok(mut order) = self.order.lock() {
            order.retain(|id| self.tasks.contains_key(id));
        }
    }

    /// Count of non-finished tasks.
    pub fn active_count(&self) -> usize {
        self.tasks
            .iter()
            .filter(|entry| !entry.state.is_terminal())
            .count()
    }

    /// Drop the oldest finished tasks once we exceed the retention cap.
    fn evict_finished(&self) {
        let Ok(order) = self.order.lock() else { return };
        if order.len() <= MAX_RETAINED_TASKS {
            return;
        }
        // Only the head of the list is old enough to consider.
        for id in order.iter() {
            if self.tasks.len() <= MAX_RETAINED_TASKS {
                break;
            }
            let finished = self
                .tasks
                .get(id)
                .map(|entry| entry.state.is_terminal())
                .unwrap_or(false);
            if finished {
                self.tasks.remove(id);
            }
        }
    }

    /// Push a progress frame for one task to every SSE subscriber.
    fn emit(&self, id: &str) {
        let Some(task) = self.tasks.get(id) else {
            return;
        };
        let view = task.view();
        // A send error only means nobody is listening, which is normal.
        let _ = self.events.send(ProgressEvent {
            id: view.id,
            state: view.state,
            progress: view.progress,
            downloaded_bytes: view.downloaded_bytes,
            total_bytes: view.total_bytes,
            speed_bps: view.speed_bps,
            error: view.error,
        });
    }
}

/// The state a finished transfer loop should land on.
///
/// `pause()` and `cancel()` trip the same flag and the downloader reports
/// "stopped at N bytes" for each, so the loop must not blindly map every
/// [`DownloadOutcome::Paused`] to `Paused`: a cancel marks the task
/// `Cancelled` before the loop exits, and that intent must win.
fn terminal_state(state: TaskState, outcome: &crate::download::DownloadOutcome) -> TaskState {
    match outcome {
        crate::download::DownloadOutcome::Completed { .. } => TaskState::Completed,
        crate::download::DownloadOutcome::Paused { .. } if state == TaskState::Cancelled => {
            TaskState::Cancelled
        }
        crate::download::DownloadOutcome::Paused { .. } => TaskState::Paused,
    }
}

impl Default for DownloadManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Task {
    fn view(&self) -> DownloadTask {
        let progress = self.percent.or_else(|| {
            self.total.map(|total| {
                if total == 0 {
                    0.0
                } else {
                    ((self.downloaded as f64 / total as f64) * 100.0).clamp(0.0, 100.0) as f32
                }
            })
        });

        DownloadTask {
            id: self.id.clone(),
            filename: self.filename.clone(),
            title: self.title.clone(),
            state: self.state,
            progress,
            downloaded_bytes: self.downloaded,
            total_bytes: self.total,
            speed_bps: self.speed_bps,
            error: self.error.clone(),
            path: Some(self.destination.to_string_lossy().into_owned()),
        }
    }
}

/// Build a client that carries the provider's auth headers.
///
/// `reqwest` has no way to add a default header to an already-constructed
/// client, so this starts from the shared builder. Malformed header names or
/// values are skipped rather than failing the whole download — one bad header
/// from a provider should not make a title undownloadable.
///
/// Falling back to a bare client is deliberate: if `build()` fails there is
/// nothing sensible to return, and a client without the auth headers will fail
/// with a clear 403 rather than the app refusing to start.
fn authed_client(headers: &[(String, String)]) -> reqwest::Client {
    let mut map = reqwest::header::HeaderMap::new();
    for (name, value) in headers {
        let Ok(name) = reqwest::header::HeaderName::from_bytes(name.as_bytes()) else {
            log::debug!("skipping malformed download header name `{name}`");
            continue;
        };
        let Ok(value) = reqwest::header::HeaderValue::from_str(value) else {
            log::debug!("skipping malformed download header value for `{name}`");
            continue;
        };
        map.insert(name, value);
    }

    crate::net::http_client_builder_base()
        .default_headers(map)
        .build()
        .unwrap_or_else(|err| {
            log::warn!("failed to build authenticated download client: {err}");
            crate::net::http_client_builder_base()
                .build()
                .unwrap_or_default()
        })
}

/// Mirror of `download::sidecar_path`, so cleanup can remove `.part` files.
fn sidecar(destination: &Path, suffix: &str) -> PathBuf {
    let mut name = destination
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    name.push('.');
    name.push_str(suffix);
    destination.with_file_name(name)
}

/// Re-export so handlers can match on it without importing `crate::download`.
pub use crate::download::DownloadOutcome as Outcome;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_starts_empty_and_counts_zero_active() {
        let mgr = DownloadManager::new();
        assert!(mgr.snapshot().is_empty());
        assert_eq!(mgr.active_count(), 0);
    }

    #[test]
    fn unknown_ids_are_reported_not_panicked() {
        let mgr = DownloadManager::new();
        assert!(!mgr.pause("nope"));
        assert!(!mgr.cancel("nope"));
        assert!(mgr.get("nope").is_none());
    }

    #[tokio::test]
    async fn remove_unknown_id_returns_false() {
        let mgr = DownloadManager::new();
        assert!(!mgr.remove("nope").await);
    }

    #[test]
    fn progress_is_null_when_total_is_unknown() {
        let task = Task {
            id: "a".into(),
            filename: "f.mkv".into(),
            title: "T".into(),
            destination: PathBuf::from("/tmp/f.mkv"),
            state: TaskState::Running,
            downloaded: 5_000,
            total: None,
            percent: None,
            speed_bps: None,
            error: None,
            url: "https://example.com/file.mkv".into(),
            headers: Vec::new(),
            cancel: Arc::new(AtomicBool::new(false)),
            handle: None,
        };
        assert!(task.view().progress.is_none(), "unknown size -> no percentage");
    }

    #[test]
    fn a_cancel_is_never_downgraded_to_a_pause() {
        use crate::download::DownloadOutcome;

        // The queue marked the task cancelled; the loop must keep that even
        // though the downloader reports a pause-shaped outcome.
        assert_eq!(
            terminal_state(TaskState::Cancelled, &DownloadOutcome::Paused { bytes: 100 }),
            TaskState::Cancelled
        );
        assert_eq!(
            terminal_state(TaskState::Running, &DownloadOutcome::Paused { bytes: 100 }),
            TaskState::Paused
        );
        assert_eq!(
            terminal_state(TaskState::Running, &DownloadOutcome::Completed { bytes: 100 }),
            TaskState::Completed
        );
    }

    #[test]
    fn progress_is_a_clamped_percentage() {
        let mut task = Task {
            id: "a".into(),
            filename: "f.mkv".into(),
            title: "T".into(),
            destination: PathBuf::from("/tmp/f.mkv"),
            state: TaskState::Running,
            downloaded: 250,
            total: Some(1000),
            percent: None,
            speed_bps: Some(1234.5),
            error: None,
            url: "https://example.com/file.mkv".into(),
            headers: Vec::new(),
            cancel: Arc::new(AtomicBool::new(false)),
            handle: None,
        };
        assert_eq!(task.view().progress, Some(25.0));

        // An over-reported `downloaded` must not produce >100%.
        task.downloaded = 5000;
        assert_eq!(task.view().progress, Some(100.0));

        // A zero total must not divide by zero.
        task.total = Some(0);
        assert_eq!(task.view().progress, Some(0.0));
    }

    #[test]
    fn terminal_states_are_terminal() {
        assert!(TaskState::Completed.is_terminal());
        assert!(TaskState::Failed.is_terminal());
        assert!(TaskState::Cancelled.is_terminal());
        assert!(!TaskState::Paused.is_terminal(), "paused work can resume");
        assert!(!TaskState::Running.is_terminal());
    }

    #[test]
    fn sidecar_paths_match_the_downloaders_naming() {
        let dest = Path::new("/downloads/movie.mkv");
        assert!(sidecar(dest, "part").ends_with("movie.mkv.part"));
        assert!(sidecar(dest, "part.json").ends_with("movie.mkv.part.json"));
    }

    #[tokio::test]
    async fn clear_finished_keeps_active_work() {
        let mgr = DownloadManager::new();
        mgr.tasks.insert(
            "done".into(),
            Task {
                id: "done".into(),
                filename: "a".into(),
                title: "A".into(),
                destination: PathBuf::from("/tmp/a"),
                state: TaskState::Completed,
                downloaded: 1,
                total: Some(1),
                percent: None,
                speed_bps: None,
                error: None,
                url: "https://example.com/file.mkv".into(),
                headers: Vec::new(),
                cancel: Arc::new(AtomicBool::new(false)),
                handle: None,
            },
        );
        mgr.tasks.insert(
            "busy".into(),
            Task {
                id: "busy".into(),
                filename: "b".into(),
                title: "B".into(),
                destination: PathBuf::from("/tmp/b"),
                state: TaskState::Running,
                downloaded: 0,
                total: Some(10),
                percent: None,
                speed_bps: None,
                error: None,
                url: "https://example.com/file.mkv".into(),
                headers: Vec::new(),
                cancel: Arc::new(AtomicBool::new(false)),
                handle: None,
            },
        );

        mgr.clear_finished();
        assert!(mgr.get("done").is_none());
        assert!(mgr.get("busy").is_some(), "a running download must survive");
    }

    #[test]
    fn outcome_is_re_exported_for_handlers() {
        // Just prove the alias resolves.
        let _: Option<Outcome> = None;
    }
}
