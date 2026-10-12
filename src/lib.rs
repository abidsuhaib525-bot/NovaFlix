//! MovieBox Web — backend crate.
//!
//! The provider scraping, request signing and DASH/HLS proxy logic is carried
//! over unchanged from the original terminal client (`MovieBox-Tui`). What is
//! new lives in [`api`], [`proxy`] and [`store`].

pub mod api;
pub mod cache;
pub mod config;
pub mod download;
pub mod favorites;
pub mod history;
pub mod logging;
pub mod models;
pub mod net;
pub mod providers;
pub mod proxy;
pub mod service;
pub mod store;
pub mod util;