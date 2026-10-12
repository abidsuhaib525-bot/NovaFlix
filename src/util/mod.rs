//! Shared helpers extracted from the TUI's `text.rs` and `player.rs`.
//!
//! These functions are domain logic (language normalisation, duration maths,
//! stream-URL classification), not presentation, so they survive the move to a
//! web backend where there is no terminal to measure or draw into.

pub mod text;
pub mod url;