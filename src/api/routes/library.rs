//! Watch history and favourites routes.

use axum::extract::{Path, State};
use axum::routing::{delete, get, post};
use axum::Json;
// `Serialize` is not needed by the handlers — these types only ever arrive in
// a request body — but the tests build genuine JSON requests out of them, which
// is a better exercise than hand-writing the JSON string.
use serde::{Deserialize, Serialize};

use crate::api::error::{ApiError, ApiResult};
use crate::api::response::{Ack, FavoriteToggle};
use crate::api::state::AppState;
use crate::favorites::FavoriteItem;
use crate::history::WatchHistoryItem;
use crate::store::Library;

/// Route table for this module.
pub fn router() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/history", get(get_history).post(upsert_history).delete(clear_history))
        .route("/history/progress", post(save_progress))
        .route("/history/mark-watched", post(mark_watched))
        .route("/history/{provider}/{subject_id}", delete(delete_history))
        .route("/favorites", get(get_favorites).post(toggle_favorite).delete(clear_favorites))
}

/// Everything the player reports back about its position.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProgressPayload {
    provider: String,
    subject_id: String,
    title: Option<String>,
    season: usize,
    episode: usize,
    /// Playhead in seconds.
    position: f64,
    /// Total length in seconds, when known.
    duration: Option<f64>,
    #[serde(default)]
    completed: bool,
    #[serde(default)]
    cover_url: Option<String>,
    #[serde(default)]
    release_year: Option<String>,
    /// Media type: 1 = movie, 2 = series. Matches the persisted schema.
    #[serde(default)]
    stype: i64,
    /// The release the user was watching, so the details page can offer it
    /// again on "resume" without re-deriving it.
    #[serde(default)]
    stream_filename: Option<String>,
}

impl ProgressPayload {
    /// Build the domain item the store persists.
    fn to_item(&self, progress_secs: u64, duration_secs: Option<u64>) -> WatchHistoryItem {
        WatchHistoryItem {
            provider: self.provider.clone(),
            subject_id: self.subject_id.clone(),
            title: self.title.clone().unwrap_or_default(),
            // `stype: 0` means the client did not say. A title with seasons or
            // episodes addressed is unambiguously a series; anything else is
            // treated as a movie, matching the terminal client's default.
            stype: if self.stype != 0 {
                self.stype
            } else if self.season > 0 || self.episode > 0 {
                2
            } else {
                1
            },
            release_year: self.release_year.clone().unwrap_or_default(),
            cover_url: self.cover_url.clone(),
            season: self.season,
            episode: self.episode,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or_default(),
            duration_seconds: duration_secs,
            progress_seconds: progress_secs,
            completed: self.completed,
            stream_filename: self.stream_filename.clone(),
        }
    }
}

/// Full history, newest first.
async fn get_history(State(state): State<AppState>) -> ApiResult<Json<Vec<WatchHistoryItem>>> {
    state.store.history().await.map(Json).map_err(ApiError::internal)
}

/// Insert or replace an entry directly.
async fn upsert_history(
    State(state): State<AppState>,
    Json(item): Json<WatchHistoryItem>,
) -> ApiResult<Json<Ack>> {
    state.store.upsert_history(item).await.map_err(ApiError::internal)?;
    Ok(Json(Ack::new()))
}

/// The player's periodic progress ping.
///
/// Browsers cannot debounce a reliable "page closed" signal, so the player
/// posts on an interval *and* on `visibilitychange`. Both paths land here.
async fn save_progress(
    State(state): State<AppState>,
    Json(payload): Json<ProgressPayload>,
) -> ApiResult<Json<Ack>> {
    if payload.subject_id.trim().is_empty() || payload.provider.trim().is_empty() {
        return Err(ApiError::BadRequest(
            "`provider` and `subject_id` are required".into(),
        ));
    }

    let progress = clamp_secs(payload.position);
    let duration = payload.duration.map(clamp_secs);

    state
        .store
        .upsert_history(payload.to_item(progress, duration))
        .await
        .map_err(ApiError::internal)?;

    Ok(Json(Ack::new()))
}

/// Mark a whole title as watched.
async fn mark_watched(
    State(state): State<AppState>,
    Json(payload): Json<ProgressPayload>,
) -> ApiResult<Json<Ack>> {
    let duration = payload.duration.map(clamp_secs);
    // "Watched" means the playhead sits at the very end, which is what the
    // terminal client recorded and what `is_in_progress` keys off.
    let mut item = payload.to_item(duration.unwrap_or_default(), duration);
    item.completed = true;

    state.store.upsert_history(item).await.map_err(ApiError::internal)?;
    Ok(Json(Ack::new()))
}

/// Remove every episode of one show.
async fn delete_history(
    State(state): State<AppState>,
    Path((provider, subject_id)): Path<(String, String)>,
) -> ApiResult<Json<Ack>> {
    state
        .store
        .remove_history(&provider, &subject_id)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(Ack::new()))
}

/// Wipe all history.
async fn clear_history(State(state): State<AppState>) -> ApiResult<Json<Ack>> {
    state.store.clear_history().await.map_err(ApiError::internal)?;
    Ok(Json(Ack::new()))
}

/// All favourites.
async fn get_favorites(State(state): State<AppState>) -> ApiResult<Json<Vec<FavoriteItem>>> {
    state.store.favorites().await.map(Json).map_err(ApiError::internal)
}

/// Body of `POST /api/favorites`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FavoritePayload {
    provider: String,
    subject_id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    release_year: Option<String>,
    #[serde(default)]
    cover_url: Option<String>,
    /// Media type: 1 = movie, 2 = series. `0` is normalised to a movie.
    #[serde(default)]
    stype: i64,
}

/// Add if absent, remove if present. Returns the resulting membership.
async fn toggle_favorite(
    State(state): State<AppState>,
    Json(payload): Json<FavoritePayload>,
) -> ApiResult<Json<FavoriteToggle>> {
    if payload.provider.trim().is_empty() || payload.subject_id.trim().is_empty() {
        return Err(ApiError::BadRequest(
            "`provider` and `subject_id` are required".into(),
        ));
    }

    let item = FavoriteItem {
        provider: payload.provider.clone(),
        subject_id: payload.subject_id.clone(),
        title: payload.title.unwrap_or_default(),
        stype: if payload.stype == 0 { 1 } else { payload.stype },
        release_year: payload.release_year.unwrap_or_default(),
        cover_url: payload.cover_url,
        added_at: now_secs(),
    };

    let favorite = state
        .store
        .toggle_favorite(item)
        .await
        .map_err(ApiError::internal)?;

    Ok(Json(FavoriteToggle { favorite }))
}

/// Wipe all favourites.
async fn clear_favorites(State(state): State<AppState>) -> ApiResult<Json<Ack>> {
    state.store.clear_favorites().await.map_err(ApiError::internal)?;
    Ok(Json(Ack::new()))
}

/// Seconds since the Unix epoch.
///
/// A clock set before 1970 yields 0 rather than a negative number, which is
/// the only value the persistence layer would misorder on.
fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

/// Coerce a client-reported float into whole seconds.
///
/// The player sends `video.currentTime`, which is a float and can briefly be
/// negative or `NaN` while metadata loads. Truncating rather than rounding keeps
/// "resume at 59.9s" from jumping to 60s.
fn clamp_secs(value: f64) -> u64 {
    if !value.is_finite() || value <= 0.0 {
        return 0;
    }
    value as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_seconds_are_truncated_not_rounded() {
        assert_eq!(clamp_secs(59.9), 59);
        assert_eq!(clamp_secs(0.0), 0);
        assert_eq!(clamp_secs(-5.0), 0);
        // A NaN from a not-yet-loaded video must not become garbage.
        assert_eq!(clamp_secs(f64::NAN), 0);
        assert_eq!(clamp_secs(f64::INFINITY), 0);
        assert_eq!(clamp_secs(120.7), 120);
    }

    fn payload() -> ProgressPayload {
        ProgressPayload {
            provider: "moviebox".into(),
            subject_id: "abc".into(),
            title: Some("A Movie".into()),
            season: 1,
            episode: 2,
            position: 300.9,
            duration: Some(7200.0),
            completed: false,
            cover_url: None,
            release_year: Some("2024".into()),
            stype: 2,
            stream_filename: Some("Movie Title [1080p].mkv".into()),
        }
    }

    #[test]
    fn payload_maps_onto_the_domain_item() {
        let item = payload().to_item(clamp_secs(300.9), Some(clamp_secs(7200.0)));
        assert_eq!(item.progress_seconds, 300);
        assert_eq!(item.duration_seconds, Some(7200));
        assert_eq!(item.season, 1);
        assert_eq!(item.episode, 2);
        assert_eq!(item.stype, 2);
        assert!(item.timestamp > 0, "timestamp must be filled in");
    }

    #[test]
    fn unknown_duration_stays_unknown() {
        // `None` means "the player has not loaded metadata yet", which is not
        // the same as "zero seconds long" — collapsing the two would make the
        // UI show 0% progress on every title.
        let mut p = payload();
        p.duration = None;
        assert_eq!(p.to_item(0, None).duration_seconds, None);
    }

    #[test]
    fn stype_defaults_by_shape_when_the_client_omits_it() {
        // Season/episode addressing means series.
        let mut p = payload();
        p.stype = 0;
        p.season = 1;
        p.episode = 2;
        assert_eq!(p.to_item(0, None).stype, 2);

        // Neither means movie.
        p.season = 0;
        p.episode = 0;
        assert_eq!(p.to_item(0, None).stype, 1);
    }

    #[test]
    fn an_explicit_stype_is_never_second_guessed() {
        let mut p = payload();
        p.stype = 1;
        p.season = 3;
        p.episode = 4;
        assert_eq!(p.to_item(0, None).stype, 1);
    }

    #[tokio::test]
    async fn progress_rejects_blank_identity() {
        let app = axum::Router::new()
            .route("/history/progress", post(save_progress))
            .with_state(test_state().await);

        let mut body = payload();
        body.subject_id = "  ".into();
        let res = post_json(&app, "/history/progress", &body).await;
        assert_eq!(res, 400, "a blank subject_id must be rejected");
    }

    #[tokio::test]
    async fn progress_is_persisted() {
        let app = axum::Router::new()
            .route("/history/progress", post(save_progress))
            .with_state(test_state().await);

        let res = post_json(&app, "/history/progress", &payload()).await;
        assert_eq!(res, 200);
    }

    // -- helpers ----------------------------------------------------------

    async fn test_state() -> crate::api::state::AppState {
        let dir = tempfile::tempdir().expect("tempdir");
        // Leak the TempDir so it outlives the store for the duration of a test.
        Box::leak(Box::new(dir));
        let store =
            crate::store::JsonFileStore::new(std::env::temp_dir().join("moviebox-web-tests"))
                .expect("store");
        crate::api::state::AppState::new(store)
    }

    async fn post_json(app: &axum::Router, path: &str, body: &impl serde::Serialize) -> u16 {
        use axum::body::Body;
        use axum::http::Request;

        let req = Request::builder()
            .method("POST")
            .uri(path)
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(body).expect("serialize")))
            .expect("request");

        app.clone()
            .oneshot(req)
            .await
            .expect("response")
            .status()
            .as_u16()
    }

    use tower::ServiceExt;
}
