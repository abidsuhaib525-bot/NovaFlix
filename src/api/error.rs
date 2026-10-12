//! API error type and its `IntoResponse` impl.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

/// Everything an API handler can fail with.
///
/// Statuses are chosen so the frontend can branch on the number alone:
/// 404 means "try a different provider", 502 means "the upstream site is down".
#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    /// The caller sent something we cannot act on.
    #[error("{0}")]
    BadRequest(String),

    /// The requested subject/season/episode does not exist.
    #[error("{0}")]
    NotFound(String),

    /// No enabled provider can serve this request.
    #[error("{0}")]
    Unavailable(String),

    /// The provider or CDN failed on its end.
    #[error("{0}")]
    Upstream(String),

    /// Persistence failed.
    #[error("{0}")]
    Internal(String),
}

impl ApiError {
    /// Build a 500 from anything displayable.
    pub fn internal(err: impl std::fmt::Display) -> Self {
        Self::Internal(err.to_string())
    }

    fn status(&self) -> StatusCode {
        match self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::Unavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::Upstream(_) => StatusCode::BAD_GATEWAY,
            Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

/// Wire shape for every error the API returns.
#[derive(Serialize)]
pub struct ErrorBody {
    /// Human-readable, already safe to show in the UI.
    pub error: String,
    /// Coarse machine-readable tag, so the frontend can style differently
    /// without string-matching the message.
    pub kind: &'static str,
}

impl From<ApiError> for ErrorBody {
    fn from(err: ApiError) -> Self {
        let kind = match &err {
            ApiError::BadRequest(_) => "bad_request",
            ApiError::NotFound(_) => "not_found",
            ApiError::Unavailable(_) => "unavailable",
            ApiError::Upstream(_) => "upstream",
            ApiError::Internal(_) => "internal",
        };
        Self {
            error: err.to_string(),
            kind,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status();
        let body: ErrorBody = self.into();

        // 5xx means we broke; log it. 4xx means the caller did; don't spam.
        if status.is_server_error() {
            log::error!("API error: {} -> {}", body.kind, body.error);
        } else {
            log::debug!("API rejected: {} -> {}", body.kind, body.error);
        }

        (status, Json(body)).into_response()
    }
}

impl From<crate::providers::models::ProviderError> for ApiError {
    fn from(err: crate::providers::models::ProviderError) -> Self {
        use crate::providers::models::ProviderError as P;
        match err {
            // "Try a different provider" is a distinct state for the UI.
            P::NotFound => Self::NotFound("Not found on this provider".into()),
            // Rate limiting and unavailability are both transient — the UI
            // offers a retry, not a permanent failure.
            P::RateLimited(_) => {
                Self::Unavailable("Provider is rate limiting us; try again shortly".into())
            }
            P::Unavailable(msg) => Self::Unavailable(msg),
            P::Parsing(msg) | P::Network(msg) => Self::Upstream(msg),
        }
    }
}

/// Convenience alias for handler results.
pub type ApiResult<T> = Result<T, ApiError>;

/// Parse a required query-string parameter.
///
/// Takes the bare map rather than `axum::extract::Query`, which the handlers
/// already destructure. `Query` derefs to its inner type, so `&params` still
/// coerces at every call site.
pub fn required_param<T: std::str::FromStr>(
    params: &std::collections::HashMap<String, String>,
    key: &str,
) -> ApiResult<T>
where
    T::Err: std::fmt::Display,
{
    let raw = params
        .get(key)
        // An empty value is treated as absent. `?season=` is what a browser
        // form submits for a cleared field, and rejecting it with "missing
        // `season`" would be a confusing way to say "you left it blank".
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ApiError::BadRequest(format!("missing `{key}` parameter")))?;
    raw.parse::<T>()
        .map_err(|err| ApiError::BadRequest(format!("invalid `{key}`: {err}")))
}

/// Parse an optional query-string parameter, falling back to a default.
///
/// An empty string also yields the default, matching [`required_param`]'s
/// treatment of `?key=`.
pub fn optional_param<T: std::str::FromStr + Default>(
    params: &std::collections::HashMap<String, String>,
    key: &str,
) -> ApiResult<T>
where
    T::Err: std::fmt::Display,
{
    match params.get(key).filter(|value| !value.trim().is_empty()) {
        Some(raw) => raw
            .parse::<T>()
            .map_err(|err| ApiError::BadRequest(format!("invalid `{key}`: {err}"))),
        None => Ok(T::default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_map_to_the_right_class() {
        assert_eq!(ApiError::BadRequest("x".into()).status(), 400);
        assert_eq!(ApiError::NotFound("x".into()).status(), 404);
        assert_eq!(ApiError::Unavailable("x".into()).status(), 503);
        assert_eq!(ApiError::Upstream("x".into()).status(), 502);
        assert_eq!(ApiError::internal("x").status(), 500);
    }

    #[tokio::test]
    async fn renders_json_with_kind() {
        let res = ApiError::NotFound("no such show".into()).into_response();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn required_param_reports_missing_and_malformed() {
        let mut params = std::collections::HashMap::new();
        params.insert("season".to_string(), "2".to_string());

        // Present and valid.
        assert_eq!(required_param::<u32>(&params, "season").unwrap(), 2);

        // Absent.
        assert!(matches!(
            required_param::<u32>(&params, "episode"),
            Err(ApiError::BadRequest(_))
        ));

        // Present but unparseable.
        params.insert("episode".to_string(), "abc".to_string());
        assert!(matches!(
            required_param::<u32>(&params, "episode"),
            Err(ApiError::BadRequest(_))
        ));
    }

    #[test]
    fn blank_values_read_as_absent_for_both_helpers() {
        // `?season=` is what a cleared browser form field submits. Treating it
        // as "missing" for required and "default" for optional is far less
        // surprising than "must be a whole number" or "must not be empty".
        let mut params = std::collections::HashMap::new();
        params.insert("season".to_string(), "   ".to_string());

        assert!(matches!(
            required_param::<u32>(&params, "season"),
            Err(ApiError::BadRequest(_))
        ));
        assert_eq!(optional_param::<u32>(&params, "season").unwrap(), 0);
    }

    #[test]
    fn optional_param_defaults() {
        let params = std::collections::HashMap::new();
        assert_eq!(optional_param::<u32>(&params, "season").unwrap(), 0);
    }

    #[test]
    fn optional_param_still_rejects_a_present_but_bad_value() {
        // Silently defaulting a typo'd value would be worse than erroring: the
        // user would get season 0 results and blame the provider.
        let params = std::collections::HashMap::from([("season".to_string(), "two".to_string())]);
        assert!(matches!(
            optional_param::<u32>(&params, "season"),
            Err(ApiError::BadRequest(_))
        ));
    }
}
