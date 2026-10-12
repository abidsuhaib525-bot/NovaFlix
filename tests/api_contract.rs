//! The HTTP contract between the Rust backend and the React frontend.
//!
//! ## What this protects
//!
//! `web/src/lib/api.ts` is a single hand-written client with no schema
//! generation and no compile-time link to the Rust side. Nothing stops a path
//! in that file from drifting away from the router, and when it does the
//! failure is a 404 in the browser console with no server-side error at all.
//!
//! This file closes that gap. [`FRONTEND_ROUTES`] is a transcription of every
//! path `api.ts` calls, dispatched against the real [`app_router`] — the same
//! composition `main.rs` serves, `/api` nesting and SPA fallback included.
//!
//! ## The three categories
//!
//! Status alone cannot tell a missing route from a handler that chose 404, so
//! the table is split by *what a 404 would mean*:
//!
//! | Category              | Meaning of a 404                        | Proof it matched |
//! |-----------------------|-----------------------------------------|------------------|
//! | [`FRONTEND_ROUTES`]   | the route does not exist — a bug        | status is not 404 |
//! | [`HANDLED_404S`]      | the handler legitimately said no        | JSON error body  |
//! | [`NOT_ROUTED`]        | genuinely unrouted                      | —                |
//!
//! The middle row is the one that is easy to get wrong. An out-of-range
//! playlist index *should* be a 404, so sweeping it through the first table
//! would either fail spuriously or, worse, get "fixed" by weakening the
//! assertion until the suite went green.
//!
//! Validation runs before any I/O throughout these handlers, so every assertion
//! here holds with the network unplugged.

use std::collections::BTreeSet;

use axum::body::Body;
use axum::http::{header, Method, Request};
use tower::ServiceExt;

use moviebox_web::api::app_router;
use moviebox_web::api::state::AppState;
use moviebox_web::store::JsonFileStore;

/// Paths written without the `/api` prefix, because `app_router` nests it.
const NAV_ACCEPT: &str = "text/html,application/xhtml+xml,*/*;q=0.8";

/// One entry per call site in `web/src/lib/api.ts`: `(method, path, note)`.
///
/// The note explains what the request does without reaching the network, for
/// whoever next wonders why the status is not 200.
type Case = (Method, &'static str, &'static str);

/// Endpoints that answer with something other than 404/405 when correctly
/// routed. `/api/cache/clear` is deliberately last: it deletes the real cache
/// directory, the one side effect no other route has.
const FRONTEND_ROUTES: &[Case] = &[
    (Method::GET, "/health", "config-only"),
    (Method::GET, "/providers", "config-only"),
    (Method::POST, "/providers/enabled", "`kind` must parse"),
    (Method::POST, "/providers/bdix/probe", "no arguments"),
    (Method::GET, "/search", "`provider` and `q` required"),
    (Method::GET, "/search/suggest", "`q` required"),
    (Method::GET, "/homepage", "`tab_id` required"),
    (Method::GET, "/browse/presets", "config-only"),
    (Method::GET, "/homepage/tabs", "config-only"),
    // A deliberately wrong preset key. It proves `/browse/{preset}` is registered
    // *and* keeps the suite network-independent: the handler rejects the key
    // before touching an upstream tab, whereas a real preset like `trending`
    // would make this test depend on three CDN round-trips. The lib tests cover
    // the ranking itself.
    (Method::GET, "/browse/top_rated_someday", "`{preset}` is validated first"),
    // Proves `/browse/all` is registered *and* that its filter is validated
    // before any upstream fetch, which is what keeps it in this suite: a real
    // preset would pull three CDN round-trips per rail, so twelve in total. The
    // handler rejects the unknown key first and never reaches the network.
    (Method::GET, "/browse/all?presets=not_a_preset", "filter validated first"),
    (Method::GET, "/addons/catalog", "`manifest` required"),
    (Method::GET, "/details", "`provider` and `id` required"),
    (Method::GET, "/streams", "`provider` and `id` required"),
    (Method::GET, "/streams/resolutions", "`provider` and `id` required"),
    (Method::GET, "/subtitles", "`subject_id` required"),
    (Method::GET, "/poster", "`url` required"),
    (Method::POST, "/playback/session", "`url` required"),
    (Method::GET, "/history", "store-backed"),
    (Method::POST, "/history", "body validation"),
    (Method::POST, "/history/progress", "`subject_id` required"),
    (Method::DELETE, "/history/moviebox/tt1234567", "unknown entry"),
    (Method::POST, "/history/mark-watched", "body validation"),
    (Method::DELETE, "/history", "store-backed"),
    (Method::GET, "/favorites", "store-backed"),
    (Method::POST, "/favorites", "body validation"),
    (Method::DELETE, "/favorites", "store-backed"),
    (Method::GET, "/tv/playlists", "store-backed"),
    (Method::GET, "/tv/channels", "config-only"),
    (Method::GET, "/addons", "config-backed"),
    (Method::POST, "/addons", "`manifest_url` required"),
    (Method::GET, "/downloads", "in-memory"),
    (Method::POST, "/downloads", "`provider` and `subject_id` required"),
    (Method::DELETE, "/downloads", "in-memory"),
    (Method::GET, "/settings", "config-only"),
    (Method::PUT, "/settings", "body validation"),
    (Method::POST, "/cache/clear", "deletes the real cache dir"),
];

/// Endpoints whose correct answer *is* 404: `(method, path, json body)`.
///
/// The body is `""` for requests that take none. These are separated from
/// [`FRONTEND_ROUTES`] because asserting `!= 404` on them would be wrong, and
/// the assertion that actually matters is that the body is JSON — which is how
/// a handler's 404 is told apart from the router's.
const HANDLED_404S: &[(Method, &str, &str)] = &[
    // The playback wildcard. The session id does not exist, so nothing is
    // fetched — this also proves the lookup precedes any upstream request.
    (Method::GET, "/playback/deadbeef/https/example.com/dash/index.mpd", ""),
    (
        Method::GET,
        "/playback/deadbeef/https/example.com/dash/seg_00001.m4s",
        "",
    ),
    (
        Method::GET,
        "/playback/deadbeef/sub/https/example.com/subs/en.vtt",
        "",
    ),
    // A scheme the proxy does not support. The path is syntactically valid, so
    // the wildcard matches and the scheme is rejected before any fetch — the
    // path encoding is what stops a `file://` target being smuggled through.
    (Method::GET, "/playback/deadbeef/file/host/etc/passwd", ""),
    // An out-of-range index on an empty list.
    (Method::DELETE, "/tv/playlists/999", ""),
    (Method::DELETE, "/addons/999", ""),
    (Method::POST, "/addons/999/toggle", r#"{"enabled":true}"#),
    // A download id that is not in the manager. Worth pinning down because the
    // frontend polls these ids from a list it fetched earlier: a server restart
    // empties the manager while the UI still holds ids, and each one must
    // resolve to a clean 404 rather than a 500 from an unchecked lookup.
    (Method::POST, "/downloads/nope/pause", ""),
    (Method::POST, "/downloads/nope/resume", ""),
    (Method::POST, "/downloads/nope/cancel", ""),
    (Method::DELETE, "/downloads/nope", ""),
];

/// Paths that must not be routed at all.
const NOT_ROUTED: &[&str] = &[
    "",
    "/nope",
    "/history/nope",
    "/downloads/a/b/c",
    "/providers/enabled/extra",
];

/// A body satisfying the JSON extractor with its fields deliberately blank.
///
/// Blank rather than valid so handlers that validate reject on the *values*
/// before any network call — that is what makes these assertions
/// network-independent.
const BLANK_JSON: &str = r#"{"provider":"","subject_id":""}"#;

/// Build the real server router over a throwaway store.
///
/// Per-test rather than shared so a mutating test (`DELETE /history`) cannot
/// make a later test in the same binary observe the change; Cargo runs tests in
/// one process, so a shared store would be a hidden ordering dependency.
fn app_at(web_root: &std::path::Path) -> axum::Router {
    let dir = std::env::temp_dir().join(format!(
        "mb-contract-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create temp store dir");

    let store = JsonFileStore::new(dir).expect("open store");
    app_router(AppState::new(store), web_root)
}

/// The standard fixture: a real store, and a web root that does not exist.
///
/// A nonexistent web root matters — it stops the SPA fallback from finding an
/// `index.html` and answering a stray path with a 200 of HTML, which would mask
/// a routing bug behind a plausible status code.
fn app() -> axum::Router {
    app_at(std::path::Path::new("/definitely-not-a-build"))
}

/// Dispatch one request; return `(status, body)`.
///
/// Subresource requests deliberately omit `Accept: text/html` so they cannot be
/// rescued by the SPA shell.
async fn call(app: axum::Router, method: &Method, path: &str, body: &str) -> (u16, String) {
    let default_body = if *method == Method::POST || *method == Method::PUT {
        BLANK_JSON
    } else {
        ""
    };
    let body = if body.is_empty() { default_body } else { body };

    let request = Request::builder()
        .method(method.clone())
        .uri(format!("/api{path}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .expect("valid request");

    let response = app
        .oneshot(request)
        .await
        .expect("router responded");

    let status = response.status().as_u16();
    let bytes = axum::body::to_bytes(response.into_body(), 256 * 1024)
        .await
        .expect("read body");

    (status, String::from_utf8_lossy(&bytes).into_owned())
}

#[tokio::test]
async fn every_frontend_route_is_registered() {
    let app = app();
    for (method, path, note) in FRONTEND_ROUTES {
        let (code, _) = call(app.clone(), method, path, "").await;
        assert_ne!(
            code, 404,
            "`{method} {path}` is not registered — the frontend will get a 404 ({note})"
        );
        assert_ne!(
            code, 405,
            "`{method} {path}` exists under a different method ({note})"
        );
    }
}

#[tokio::test]
async fn unrouted_api_paths_answer_404() {
    // The reverse direction. Extra server-side routes are allowed — they are how
    // a future UI grows without a backend change — but every path here must
    // genuinely not exist, so a typo in `api.ts` fails here rather than at
    // runtime.
    let app = app();
    for path in NOT_ROUTED {
        let (code, _) = call(app.clone(), &Method::GET, path, "").await;
        assert_eq!(
            code, 404,
            "`{path}` should not be routed; if it now is, add it to FRONTEND_ROUTES"
        );
    }
}

#[tokio::test]
async fn handled_404s_carry_a_json_body() {
    // This is what pins down routes whose correct status *is* 404: a handler's
    // rejection carries `{"error": ..., "kind": ...}`, whereas the router's own
    // 404 has no body. Without this the playback wildcard and the index routes
    // would be untestable — and the wildcard is precisely the route where a
    // mistake turns into an open relay.
    let app = app();
    for (method, path, body) in HANDLED_404S {
        let (code, text) = call(app.clone(), method, path, body).await;
        assert_eq!(
            code, 404,
            "`{method} {path}` should answer 404 with an empty collection"
        );
        assert!(
            text.contains("\"error\""),
            "`{method} {path}` produced no JSON error body (got `{}`) — the route \
             did not match, so this is a missing route rather than a handler \
             rejecting the request",
            text.chars().take(120).collect::<String>()
        );
    }
}

#[tokio::test]
async fn an_unknown_playback_session_is_rejected_before_any_upstream_call() {
    // `example.com` is reserved by RFC 2606 and has no CDN behind it, so a 404
    // can only have come from the session lookup. Were the order ever reversed,
    // this would hang or 502 instead of answering immediately.
    let (code, _) = app_call(
        "/playback/deadbeef/https/example.com/x.m4s",
    )
    .await;
    assert_eq!(code, 404);
}

/// Convenience wrapper for a plain GET with no body.
async fn app_call(path: &str) -> (u16, String) {
    call(app(), &Method::GET, path, "").await
}

#[tokio::test]
async fn the_spa_fallback_only_answers_navigations() {
    // A stale `/assets/index-BXy1.js` after a redeploy is the case that
    // motivates all of this. If it were answered with `200 OK` and the HTML
    // shell, the browser reports a JavaScript syntax error on line 1 of the
    // bundle — which reads like a broken `npm run build` and survives a rebuild,
    // because the browser keeps asking for the old hashed filename.
    //
    // Built against a *real* web root so the fallback genuinely has a shell to
    // serve; otherwise the assertions would pass for the wrong reason.
    let dir = std::env::temp_dir().join(format!("mb-spa-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create web root");
    std::fs::write(dir.join("index.html"), "<!doctype html><title>SPA</title>")
        .expect("write index.html");

    let app = app_at(&dir);

    // A client-side route survives a hard refresh.
    let navigation = Request::builder()
        .uri("/watch/tt1234567")
        .header(header::ACCEPT, NAV_ACCEPT)
        .body(Body::empty())
        .expect("valid request");
    let response = app.clone().oneshot(navigation).await.expect("responded");
    assert_eq!(
        response.status(),
        200,
        "a browser navigation to a client-side route must get the SPA shell"
    );

    // A missing build asset does not.
    let asset = Request::builder()
        .uri("/assets/index-BXy1.js")
        .header(header::ACCEPT, "*/*")
        .body(Body::empty())
        .expect("valid request");
    let response = app.oneshot(asset).await.expect("responded");
    assert_eq!(
        response.status(),
        404,
        "a missing build asset must 404, not resolve to index.html"
    );

    // And a real asset is served as itself, with its own content type.
    std::fs::create_dir_all(dir.join("assets")).expect("create assets dir");
    std::fs::write(dir.join("assets").join("app.js"), "export default 1;")
        .expect("write asset");
    let app = app_at(&dir);
    let asset = Request::builder()
        .uri("/assets/app.js")
        .header(header::ACCEPT, "*/*")
        .body(Body::empty())
        .expect("valid request");
    let response = app.oneshot(asset).await.expect("responded");
    assert_eq!(response.status(), 200);
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert!(
        !content_type.starts_with("text/html"),
        "a .js asset was served as {content_type}"
    );
}

#[tokio::test]
async fn an_api_path_never_reaches_the_spa_fallback() {
    // The dangerous shape is `index.html` answering `/api/whatever`: the
    // frontend's `request()` would hand it to `res.json()` and surface a parse
    // error instead of a clean 404. With a real build present, an `text/html`
    // body under `/api` is the signature of that bug, whatever the status.
    let dir = std::env::temp_dir().join(format!("mb-api-fb-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create web root");
    std::fs::write(dir.join("index.html"), "<!doctype html><title>SPA</title>")
        .expect("write index.html");

    let app = app_at(&dir);

    for path in ["/api/definitely-not-a-route", "/api/poster/a/b/c"] {
        let request = Request::builder()
            .uri(path)
            .header(header::ACCEPT, NAV_ACCEPT)
            .body(Body::empty())
            .expect("valid request");
        let response = app.clone().oneshot(request).await.expect("responded");

        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        assert!(
            !content_type.starts_with("text/html"),
            "`{path}` was answered with the SPA shell ({content_type})"
        );
    }
}

#[tokio::test]
async fn a_missing_frontend_build_says_how_to_fix_it() {
    // A bare 404 on `/` sends the user hunting through the backend when the
    // answer is one `npm run build` away. Asserted against the nonexistent web
    // root the other tests use, so it doubles as the fresh-clone state.
    let app = app();
    let navigation = Request::builder()
        .uri("/")
        .header(header::ACCEPT, NAV_ACCEPT)
        .body(Body::empty())
        .expect("valid request");

    let response = app.oneshot(navigation).await.expect("responded");
    assert_eq!(response.status(), 404);

    let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .expect("read body");
    let text = String::from_utf8_lossy(&bytes);
    assert!(
        text.contains("npm run build"),
        "the diagnostic should name the fix, got: {}",
        text.chars().take(160).collect::<String>()
    );
}

#[tokio::test]
async fn the_contract_list_has_no_duplicate_entries() {
    // A duplicated `(method, path)` would silently mask a typo in one of the two
    // rows: the second would pass for the same reason the first did.
    let mut seen: BTreeSet<(String, String)> = BTreeSet::new();
    for (method, path, _) in FRONTEND_ROUTES {
        assert!(
            seen.insert((method.as_str().to_string(), (*path).to_string())),
            "duplicate entry in FRONTEND_ROUTES: {method} {path}"
        );
    }
    for (method, path, _) in HANDLED_404S {
        assert!(
            seen.insert((method.as_str().to_string(), (*path).to_string())),
            "`{method} {path}` is listed in both FRONTEND_ROUTES and HANDLED_404S"
        );
    }
    for path in NOT_ROUTED {
        assert!(
            seen.insert(("GET".to_string(), (*path).to_string())),
            "`{path}` is listed in NOT_ROUTED but is now routed"
        );
    }
}

#[tokio::test]
async fn every_route_is_under_the_api_prefix() {
    // A missing leading slash, or a stray `/api` in the transcription, would
    // mean `every_frontend_route_is_registered` is silently asserting against
    // the SPA fallback — and passing for the wrong reason.
    for (_, path, _) in FRONTEND_ROUTES {
        assert!(
            path.starts_with('/') && !path.starts_with("/api"),
            "`{path}` should be written with a leading slash and no `/api` prefix"
        );
    }
    for (_, path, _) in HANDLED_404S {
        assert!(
            path.starts_with('/') && !path.starts_with("/api"),
            "`{path}` should be written with a leading slash and no `/api` prefix"
        );
    }
    for path in NOT_ROUTED {
        assert!(
            !path.starts_with("/api"),
            "`{path}` should be written without the `/api` prefix"
        );
    }
}
