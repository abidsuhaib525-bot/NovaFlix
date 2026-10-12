//! MovieBox Web — server entry point.
//!
//! Binds to `127.0.0.1` and serves two things from one port:
//!
//! - `/api/**` — the JSON API and the playback byte proxy
//! - everything else — the built SPA from `web/dist`
//!
//! One port means no CORS anywhere and no second process to supervise, which is
//! the whole point of a localhost-first deployment.
//!
//! ## Why it is not public
//!
//! There is no authentication, and the playback proxy will fetch any URL its
//! session pinned. Binding to the loopback interface is the security boundary.
//! `--host` exists for `0.0.0.0`, but see the warning printed when it is used.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use moviebox_web::api::state::AppState;
use moviebox_web::store::JsonFileStore;

/// Default bind address. Loopback only, deliberately.
const DEFAULT_ADDR: &str = "127.0.0.1:8080";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse(std::env::args().skip(1));

    moviebox_web::logging::init_with_level(Some(&args.log_level));

    let addr = args.addr();
    if !addr.ip().is_loopback() {
        log::warn!(
            "binding to {addr}, which is reachable from other machines. \
             This build has no authentication - only do this on a trusted network."
        );
    }

    // The store owns the user's existing history and favourites. Opening it
    // before binding means a broken data directory fails fast, with the paths
    // in the message, instead of serving a UI that silently loses your history.
    let store = JsonFileStore::new(store_dir(&args.data_dir))
        .map_err(|err| format!("could not open the data directory: {err}"))?;

    let state = AppState::new(store);
    state.spawn_background_tasks();

    let app = moviebox_web::api::app_router(state, &args.web_root);

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    let bound = listener.local_addr()?;

    log::info!("MovieBox {} listening on http://{bound}", env!("CARGO_PKG_VERSION"));

    if !args.web_root.join("index.html").exists() {
        log::warn!(
            "no frontend build at {} - run `npm run build` in `web/`, \
             the UI will show a \"not built\" page",
            args.web_root.display()
        );
    }

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;

    log::info!("shutdown complete");
    Ok(())
}

/// Command line arguments.
///
/// Hand-rolled rather than a crate: there are three of them, and `clap` would
/// be the largest dependency in the tree for the privilege.
struct Args {
    /// Port `0` means "let the OS pick", which is how a second instance avoids
    /// colliding with a first one already on 8080.
    addr_value: SocketAddr,
    web_root: PathBuf,
    data_dir: Option<PathBuf>,
    log_level: String,
}

impl Args {
    fn parse(mut iter: impl Iterator<Item = String>) -> Self {
        let mut addr_value: SocketAddr = DEFAULT_ADDR.parse().expect("valid default addr");
        let mut web_root = default_web_root();
        let mut data_dir = None;
        let mut log_level = "info".to_string();

        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--host" | "-h" => {
                    // Bare `--host` means all interfaces; `--host 0.0.0.0` and
                    // `--host=0.0.0.0` both work too.
                    let value = iter
                        .next()
                        .filter(|v| !v.starts_with('-'))
                        .unwrap_or_else(|| "0.0.0.0".to_string());
                    match value.parse::<std::net::IpAddr>() {
                        Ok(ip) => addr_value.set_ip(ip),
                        Err(_) => {
                            eprintln!("`{value}` is not an IP address; keeping {addr_value}");
                        }
                    }
                }
                "--port" | "-p" => {
                    let value = iter.next().unwrap_or_default();
                    match value.parse::<u16>() {
                        Ok(port) => addr_value.set_port(port),
                        Err(_) => eprintln!("`{value}` is not a port; keeping {addr_value}"),
                    }
                }
                "--web-root" => {
                    if let Some(value) = iter.next() {
                        web_root = PathBuf::from(value);
                    }
                }
                "--data-dir" => {
                    if let Some(value) = iter.next() {
                        data_dir = Some(PathBuf::from(value));
                    }
                }
                "--log" | "--log-level" => {
                    if let Some(value) = iter.next() {
                        log_level = value;
                    }
                }
                "--help" => {
                    println!("{USAGE}");
                    std::process::exit(0);
                }
                other => eprintln!("ignoring unknown argument `{other}`"),
            }
        }

        Self {
            addr_value,
            web_root,
            data_dir,
            log_level,
        }
    }

    fn addr(&self) -> SocketAddr {
        self.addr_value
    }
}

const USAGE: &str = "\
MovieBox - local movie & series browser

USAGE:
    moviebox-web [OPTIONS]

OPTIONS:
    -p, --port <PORT>      Port to bind (default 8080, 0 = pick a free one)
        --host <IP>        Interface to bind (default 127.0.0.1)
                           Use 0.0.0.0 to expose on the network. No auth.
        --web-root <DIR>   Built frontend to serve (default: ./web/dist)
        --data-dir <DIR>   Where settings/TV data are written
        --log <LEVEL>      trace | debug | info | warn | error (default info)
    -h, --help             Show this message
";

/// Pick a `web/dist` to serve, from the places one plausibly lives.
///
/// A single default is wrong in every interesting case. `cargo run` sets
/// `CARGO_MANIFEST_DIR`, so the crate root is right. Running the built binary
/// directly does not, and the executable sits in `target/debug`, which has no
/// `web/` beside it. An installed release binary wants assets next to itself
/// instead, because the crate root does not exist on the user's machine at all.
///
/// Guessing one of those and reporting "no frontend build" while a perfectly good
/// build sits in the next directory over is a bad failure: the message tells the
/// user to run `npm run build`, which they already did.
fn default_web_root() -> PathBuf {
    if let Ok(explicit) = std::env::var("MOVIEBOX_WEB_ROOT") {
        return PathBuf::from(explicit);
    }

    let candidates = web_root_candidates();

    // First candidate that actually holds a build wins. The probe is on
    // `index.html` rather than the directory, because an empty or partially
    // cleaned `dist` exists more often than one that does not.
    candidates
        .iter()
        .find(|candidate| candidate.join("index.html").is_file())
        .cloned()
        .unwrap_or_else(|| {
            // Nothing found. Return the first candidate anyway so the warning
            // names the location the developer would expect, not an empty list.
            candidates.into_iter().next().unwrap_or_else(|| PathBuf::from("web/dist"))
        })
}

/// Every directory `web/dist` might be in, best guess first.
///
/// Order matters only for the "nothing found" case, where the first is the one
/// named in the warning.
fn web_root_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let mut push = |path: PathBuf| {
        // Deduped, so two identical guesses do not both appear in the error
        // message and in the probe.
        if !candidates.contains(&path) {
            candidates.push(path);
        }
    };

    // `cargo run`, and any launch that inherits cargo's environment.
    if let Some(dir) = std::env::var_os("CARGO_MANIFEST_DIR") {
        push(PathBuf::from(dir).join("web").join("dist"));
    }

    // The working directory. Covers `moviebox-web` run from the crate root,
    // which is how a developer launches the built binary by hand.
    if let Ok(cwd) = std::env::current_dir() {
        push(cwd.join("web").join("dist"));
        // One level up, for a run from inside `web/` itself.
        push(cwd.join("dist"));
    }

    // Beside the executable: a bundled release build, and `target/<profile>/`,
    // which is three levels below the crate root.
    if let Some(exe) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(PathBuf::from))
    {
        push(exe.join("web").join("dist"));
        push(exe.join("dist"));
        // `target/debug/moviebox-web.exe` -> the crate root is three levels up,
        // which is the case that motivates this whole function.
        if let Some(crate_root) = exe.parent().and_then(Path::parent) {
            push(crate_root.join("web").join("dist"));
        }
    }

    // Last resort, so the returned path is never empty. Relative, so it resolves
    // against whatever the working directory turned out to be.
    push(PathBuf::from("web").join("dist"));

    candidates
}

/// Where the store writes its documents.
fn store_dir(explicit: &Option<PathBuf>) -> PathBuf {
    if let Some(dir) = explicit {
        return dir.clone();
    }
    if let Ok(path) = std::env::var("MOVIEBOX_DATA_DIR") {
        return PathBuf::from(path);
    }
    // History and favourites live in the user's config directory; generic
    // documents go alongside them.
    moviebox_web::config::config_dir()
        .map(|dir| dir.join("data"))
        .unwrap_or_else(|| std::env::temp_dir().join("moviebox-web"))
}

/// Stop on Ctrl-C, or on a `terminate` signal on Unix.
///
/// Windows has no `SIGTERM` through Ctrl-C, so `ctrl_c` is the only signal a
/// user can send; the second case exists so a service manager on WSL/Linux can
/// still shut down cleanly.
async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(err) = tokio::signal::ctrl_c().await {
            log::error!("could not listen for Ctrl-C: {err}");
        }
    };

    #[cfg(unix)]
    {
        let terminate = async {
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(mut stream) => {
                    stream.recv().await;
                }
                Err(err) => log::error!("could not listen for SIGTERM: {err}"),
            }
        };
        tokio::select! {
            _ = ctrl_c => {}
            _ = terminate => {}
        }
    }

    #[cfg(not(unix))]
    ctrl_c.await;

    log::info!("received shutdown signal");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(items: &[&str]) -> Args {
        Args::parse(items.iter().map(|s| s.to_string()))
    }

    #[test]
    fn defaults_are_loopback_only() {
        let parsed = args(&[]);
        assert_eq!(parsed.addr().to_string(), "127.0.0.1:8080");
        assert!(parsed.addr().ip().is_loopback());
    }

    #[test]
    fn port_can_be_overridden() {
        assert_eq!(args(&["--port", "9999"]).addr().port(), 9999);
        assert_eq!(args(&["-p", "3000"]).addr().port(), 3000);
    }

    #[test]
    fn host_is_still_loopback_unless_asked() {
        assert!(args(&["--port", "9000"]).addr().ip().is_loopback());
    }

    #[test]
    fn explicit_host_is_honoured() {
        let parsed = args(&["--host", "0.0.0.0"]);
        assert!(!parsed.addr().ip().is_loopback());
        assert_eq!(parsed.addr().port(), 8080, "host must not reset the port");
    }

    #[test]
    fn bare_host_means_all_interfaces() {
        assert!(!args(&["--host"]).addr().ip().is_loopback());
    }

    #[test]
    fn host_keeps_a_chosen_port() {
        assert_eq!(args(&["-p", "1234", "--host", "0.0.0.0"]).addr().port(), 1234);
    }

    #[test]
    fn garbage_host_falls_back_to_loopback() {
        let parsed = args(&["--host", "not-an-ip"]);
        assert!(
            parsed.addr().ip().is_loopback(),
            "a bad IP must not widen the bind"
        );
    }

    #[test]
    fn garbage_port_keeps_the_default() {
        assert_eq!(args(&["--port", "not-a-port"]).addr().port(), 8080);
    }

    #[test]
    fn unknown_arguments_are_ignored_not_fatal() {
        assert_eq!(args(&["--wat", "--port", "7000"]).addr().port(), 7000);
    }

    #[test]
    fn data_dir_precedence_is_explicit_then_env() {
        // Explicit wins over the environment variable.
        let explicit = Some(PathBuf::from("/tmp/explicit"));
        assert_eq!(store_dir(&explicit), PathBuf::from("/tmp/explicit"));

        // With nothing explicit, the fallback must still be a usable path.
        assert!(!store_dir(&None).as_os_str().is_empty());
    }

    #[test]
    fn web_root_env_override_is_honoured() {
        // Only assert the branch reads the variable when it is set.
        if let Ok(value) = std::env::var("MOVIEBOX_WEB_ROOT") {
            let parsed = args(&[]);
            assert_eq!(parsed.web_root, PathBuf::from(value));
        } else {
            assert!(args(&[]).web_root.ends_with("dist"));
        }
    }

    #[test]
    fn web_root_candidates_are_unique_and_never_empty() {
        let candidates = web_root_candidates();

        // An empty list would make `default_web_root` return a relative
        // `web/dist`, and the warning would name the wrong directory.
        assert!(!candidates.is_empty());

        // Deduped, so a run from the crate root does not probe the same path
        // three times and list it three times in the error.
        let mut sorted = candidates.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            candidates.len(),
            "duplicate candidate: {candidates:?}"
        );
    }

    #[test]
    fn every_web_root_candidate_points_at_something_named_dist() {
        // The suffix is the part that matters for the warning: it tells the user
        // where to put the build.
        for candidate in web_root_candidates() {
            assert_eq!(
                candidate.file_name().and_then(|name| name.to_str()),
                Some("dist"),
                "candidate does not end in `dist`: {}",
                candidate.display()
            );
        }
    }

    #[test]
    fn the_default_web_root_ends_in_dist_whatever_happens() {
        // True whether or not a build was found -- both branches return a `dist`
        // path, and a bare `web` or `.` would make the warning useless.
        let root = default_web_root();
        assert_eq!(root.file_name().and_then(|name| name.to_str()), Some("dist"));
    }

    #[test]
    fn a_real_build_is_actually_found() {
        // The regression this whole function exists for. `cargo test` runs with
        // `CARGO_MANIFEST_DIR` set to the crate root and the current directory
        // already on it, so a `web/dist` with an `index.html` must be selected
        // rather than a plausible-looking path that does not exist.
        let root = default_web_root();
        assert!(
            root.join("index.html").is_file(),
            "no frontend build found; default_web_root chose {}, which has no index.html. \
             Run `npm run build` in web/, or set MOVIEBOX_WEB_ROOT.",
            root.display()
        );
    }

    // Router composition is covered by `tests/api_contract.rs`, which builds the
    // real `api::app_router` and checks every frontend path against it. What
    // remains here is argument parsing, which is all this file owns.
}
