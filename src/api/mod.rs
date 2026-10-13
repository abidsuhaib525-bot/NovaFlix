//! The HTTP API layer.
//!
//! ## Shape of the surface
//!
//! Everything the frontend can call lives under `/api`; everything else falls
//! through to the built SPA. [`app_router`] is what draws that line, and it
//! lives here rather than in `main.rs` so `tests/api_contract.rs` can exercise
//! the real composition instead of an approximation of it.
//!
//! | Prefix             | Module                  | Purpose                              |
//! |--------------------|-------------------------|--------------------------------------|
//! | `/api/providers`   | [`routes::catalog`]     | provider list, enable/disable        |
//! | `/api/search`      | [`routes::catalog`]     | search and suggestions               |
//! | `/api/details`     | [`routes::catalog`]     | metadata, streams, resolutions       |
//! | `/api/homepage`    | [`routes::catalog`]     | browse tabs                          |
//! | `/api/playback`    | [`routes::playback`]    | sessions and the byte proxy          |
//! | `/api/history`     | [`routes::library`]     | watch progress                       |
//! | `/api/favorites`   | [`routes::library`]     | favourites                           |
//! | `/api/downloads`   | [`routes::downloads`]   | transfers and the progress stream    |
//! | `/api/settings`    | [`routes::system`]      | preferences, cache, posters, health  |
//! | `/api/tv`          | [`routes::tv`]          | TV / remote-control channels         |
//! | `/api/addons`      | [`routes::tv`]          | Stremio-style addons                 |

pub mod downloads;
pub mod error;
pub mod response;
pub mod routes;
pub mod state;

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::task::{Context, Poll};

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use tower::ServiceExt;
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

use state::AppState;

/// Assemble the `/api` router on its own, without the `/api` prefix.
///
/// Useful when composing some other layout — a second listener, a test — but
/// most callers want [`app_router`].
pub fn router(state: AppState) -> Router {
    routes::router(state)
}

/// Compose the full server: `/api/**` plus the built SPA, on one port.
///
/// ## Why the SPA needs a content-negotiating fallback
///
/// The frontend is a client-side router, so `/watch/tt123` must return
/// `index.html` on a hard refresh. The obvious way to arrange that —
/// `ServeDir::fallback(ServeFile::new(index))` — is wrong, because `ServeDir`'s
/// fallback fires for *every* unresolved path. A stale
/// `/assets/index-BXy1.js` after a redeploy would then be answered `200 OK`
/// with the HTML shell, which the browser reports as a JavaScript syntax error
/// on line 1 of the bundle.
///
/// The symptom is genuinely misleading: it looks like a broken `npm run build`,
/// and it survives a rebuild because the browser keeps asking for the old
/// hashed filename. [`SpaAssets`] 404s a subresource and only serves the shell
/// to a navigation.
///
/// ## Why compression is safe here
///
/// `tower-http` only re-encodes a response that carries no `content-encoding` of
/// its own. The playback proxy sets one explicitly on everything it forwards, so
/// `.m4s` bytes and `Content-Range` headers reach the browser exactly as the
/// CDN sent them, while the JSON API and the built JS still get gzipped.
pub fn app_router(state: AppState, web_root: &Path) -> Router {
    let api = router(state.clone());

    Router::new()
        // The nested router needs its own fallback. Without one, axum's `nest`
        // hands an unmatched `/api/…` path back to the *outer* router, where the
        // SPA shell answers it `200 OK` as `text/html` — and the frontend's
        // `request()` then reports a JSON parse error instead of the 404 that
        // would have named the actual mistake.
        .nest("/api", api.fallback(api_not_found))
        .fallback_service(SpaAssets::new(web_root))
        .layer(tower_http::cors::CorsLayer::permissive())
        // No size threshold: `tower-http` 0.6 ships no built-in predicate for
        // it. Gzipping a short JSON body costs a few dozen bytes and saves a
        // comparable amount, so a size gate would be noise either way.
        .layer(CompressionLayer::new().gzip(true))
        .layer(TraceLayer::new_for_http())
}

/// 404 for an unknown path under `/api`.
///
/// Rendered through [`ApiError`] so the shape matches every other API failure —
/// the frontend reads `error` and `kind` and has one code path for both.
async fn api_not_found() -> Response {
    error::ApiError::NotFound("No such endpoint".into()).into_response()
}

/// Serves the built SPA: real files win, navigations get the shell, and a
/// missing subresource is an honest 404.
///
/// See [`app_router`] for why the content negotiation is necessary rather than
/// cosmetic.
#[derive(Clone)]
struct SpaAssets {
    /// Resolves real files under the web root.
    files: ServeDir,
    /// What to hand back for a navigation that matched no file.
    shell: Shell,
}

/// The SPA shell, resolved once at startup.
///
/// Checking for `index.html` at composition time rather than per request keeps
/// the request path free of filesystem calls and lets the "frontend was never
/// built" case produce a diagnostic instead of a bare 404.
#[derive(Clone)]
enum Shell {
    /// The build is present and can be served.
    Built(ServeFile),
    /// `web/dist/index.html` does not exist.
    Missing,
}

impl SpaAssets {
    fn new(web_root: &Path) -> Self {
        let index = web_root.join("index.html");
        let shell = if index.is_file() {
            Shell::Built(ServeFile::new(index))
        } else {
            log::warn!(
                "no `index.html` under {} - run `npm run build` in the web/ directory",
                web_root.display()
            );
            Shell::Missing
        };

        Self {
            files: ServeDir::new(web_root),
            shell,
        }
    }
}

impl tower::Service<Request> for SpaAssets {
    type Response = Response;
    type Error = std::convert::Infallible;
    // Boxed because the two branches (serve a file, or serve the shell) are
    // different futures with no shared type, and this path is not hot enough
    // for the indirection to matter.
    type Future = Pin<Box<dyn Future<Output = Result<Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        // `ServeDir`'s `Service` impl is generic over the request body, so the
        // call has to name it. It never has a real error — reading a missing
        // file is a 404 response, not a failed service.
        tower::Service::<Request>::poll_ready(&mut self.files, cx)
            .map_err(|err: std::convert::Infallible| match err {})
    }

    fn call(&mut self, req: Request) -> Self::Future {
        // Read the header before `req` moves into `oneshot`.
        let navigation = wants_html(&req);
        let files = self.files.clone();
        let shell = self.shell.clone();

        Box::pin(async move {
            // `SpaAssets` cannot fail: a missing file is a 404 response, not a
            // service error. Wrapping in `Ok` keeps the infallible contract.
            Ok(match files.oneshot(req).await {
                Ok(response) if response.status() != StatusCode::NOT_FOUND => {
                    response.into_response()
                }
                // No file matched. Only a navigation may fall through to the
                // shell; anything else is a genuinely missing asset.
                _ if navigation => serve_shell(shell).await,
                _ => not_found().into_response(),
            })
        })
    }
}

/// Hand back the SPA shell, or explain that there is no build.
async fn serve_shell(shell: Shell) -> Response {
    match shell {
        Shell::Built(file) => match file.oneshot(empty_get()).await {
            Ok(response) => response.into_response(),
            // `ServeFile` reports a missing file as `Ok(404)`, not `Err`, so
            // this arm is unreachable in practice. Handling it anyway keeps a
            // future change from turning into an `unwrap`.
            Err(_) => no_frontend_build(),
        },
        Shell::Missing => no_frontend_build(),
    }
}

/// `text/html` 404 naming the command that fixes it.
///
/// A bare 404 on `/` sends the user hunting through the backend, when the
/// answer is one `npm run build` away.
fn no_frontend_build() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        )],
        "<!doctype html><meta charset=utf-8><title>MovieBox</title>\
         <p style=\"font:16px system-ui;margin:4rem auto;max-width:32rem\">\
         The frontend has not been built.<br><br>\
         Run <code>npm install &amp;&amp; npm run build</code> in the \
         <code>web/</code> directory, then restart the server.</p>",
    )
        .into_response()
}

fn not_found() -> Response {
    StatusCode::NOT_FOUND.into_response()
}

/// A bare GET for services that only need a request to look at.
fn empty_get() -> Request {
    Request::builder()
        .uri("/")
        .body(Body::empty())
        .expect("static request is valid")
}

/// Whether this request is a browser navigation rather than a subresource.
///
/// `Accept` is the only signal that separates the two:
///
/// | Request                                    | `Accept`      | Result       |
/// |--------------------------------------------|---------------|--------------|
/// | Address bar, `<a href>`, client-side router | `text/html,…` | `index.html` |
/// | `<script src>`, `<link href>`, `fetch()`    | `*/*`         | 404          |
/// | `curl`                                       | `*/*`         | 404          |
///
/// Letting `*/*` fall through to a 404 is deliberate: a `curl` of a deep link
/// then reports the truth instead of dumping a page of HTML, and the browser is
/// the only client that needs the shell.
fn wants_html<B>(req: &axum::http::Request<B>) -> bool {
    req.headers()
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        // Case-insensitive: `Accept` is case-insensitive by spec, and some
        // clients send `Text/HTML`.
        .is_some_and(|accept| {
            accept
                .split(',')
                .any(|part| part.trim().to_ascii_lowercase().starts_with("text/html"))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(accept: Option<&str>) -> Request {
        let mut builder = Request::builder().uri("/watch/tt1");
        if let Some(value) = accept {
            builder = builder.header(header::ACCEPT, value);
        }
        builder.body(Body::empty()).expect("valid request")
    }

    #[test]
    fn navigations_are_recognised_across_media_types() {
        // A real browser sends the full list, with `text/html` not first.
        assert!(wants_html(&request(Some(
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        ))));
        assert!(wants_html(&request(Some("text/html"))));
        // Case-insensitive per RFC.
        assert!(wants_html(&request(Some("Text/HTML"))));
        // Whitespace around the comma is legal and common.
        assert!(wants_html(&request(Some("application/json , text/html"))));
    }

    #[test]
    fn subresource_requests_are_not_navigations() {
        // The whole reason the fallback negotiates: these must 404 so a stale
        // asset surfaces as a missing file rather than as HTML.
        assert!(!wants_html(&request(Some("*/*"))));
        assert!(!wants_html(&request(Some("application/javascript"))));
        assert!(!wants_html(&request(Some("text/css,*/*;q=0.1"))));
        // `fetch()` from the app, and `curl`, both send or omit `*/*`.
        assert!(!wants_html(&request(None)));
    }

    #[test]
    fn a_missing_build_reports_the_fix() {
        let response = no_frontend_build();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        assert!(
            content_type.starts_with("text/html"),
            "the diagnostic must render, not download: {content_type}"
        );
    }
}
