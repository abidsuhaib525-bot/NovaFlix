//! Response bodies shared by more than one route.
//!
//! ## Why these exist
//!
//! Most of the API is typed: a handler returns `Json<Vec<CatalogItem>>` and the
//! shape follows from the type. A long tail of mutating endpoints has nothing
//! useful to say beyond "that worked", and those were written as
//! `Json<serde_json::json!({ "ok": true }))>`. That compiles, but it puts the
//! wire format in a string literal where no type checker, no IDE and no reader
//! of the handler signature can see it — which is exactly the drift the
//! frontend contract test is meant to prevent, one layer in.
//!
//! Naming the shape once, here, makes the contract greppable: `Ack` appears in
//! the signature of every endpoint that acknowledges, and
//! `web/src/lib/api.ts` declares `<{ ok: true }>` to match.
//!
//! ## Why `Ack` is a body and not a 204
//!
//! `request<T>` in `api.ts` unconditionally calls `res.json()`. A 204 has an
//! empty body, so `res.json()` throws `SyntaxError: Unexpected end of JSON
//! input` and a *successful* request surfaces as a client-side error. A `200`
//! carrying `{ "ok": true }` keeps one parsing path for every outcome.
//!
//! The field is a boolean rather than absent for the same reason: a `204` would
//! need a special case, and a missing field is indistinguishable from a
//! serialisation bug.

use serde::Serialize;

/// Acknowledgement for a mutating call with no useful payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Ack {
    /// Always `true`.
    ///
    /// A field that only ever holds one value looks redundant, and it is — but
    /// it is the field the frontend awaits, and dropping it later would be a
    /// silent breaking change rather than a compile error.
    pub ok: bool,
}

impl Ack {
    /// The only value an `Ack` can take.
    pub const fn new() -> Self {
        Self { ok: true }
    }
}

impl Default for Ack {
    fn default() -> Self {
        Self::new()
    }
}

/// The identifier of a newly queued download.
///
/// Returned by `POST /api/downloads` so the caller can subscribe to that
/// transfer's progress without re-listing everything in flight.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StartedDownload {
    pub id: String,
}

impl StartedDownload {
    pub fn new(id: impl Into<String>) -> Self {
        Self { id: id.into() }
    }
}

/// The result of a favourite toggle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct FavoriteToggle {
    /// The state *after* the toggle.
    ///
    /// Returned rather than assumed because the client sends no desired state —
    /// "flip it" is the whole request — so only the server knows the outcome.
    /// Reporting the new state lets the button settle without a refetch.
    pub favorite: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ack_is_exactly_the_shape_the_frontend_declares() {
        // `api.ts` types every acknowledgement as `{ ok: true }`. If a field is
        // added or renamed, this is the test that notices.
        assert_eq!(
            serde_json::to_string(&Ack::new()).unwrap(),
            r#"{"ok":true}"#
        );
    }

    #[test]
    fn ack_is_always_true() {
        // There is deliberately no way to construct a negative one. An `ok:
        // false` response would mean the mutation failed, and failures are
        // reported as non-2xx statuses carrying an `ErrorBody`.
        assert!(Ack::new().ok);
        assert_eq!(Ack::new(), Ack::default());
    }

    #[test]
    fn download_id_serialises_as_a_bare_string() {
        assert_eq!(
            serde_json::to_string(&StartedDownload::new("abc-123")).unwrap(),
            r#"{"id":"abc-123"}"#
        );
    }

    #[test]
    fn favourite_toggle_reports_the_new_state() {
        assert_eq!(
            serde_json::to_string(&FavoriteToggle { favorite: true }).unwrap(),
            r#"{"favorite":true}"#
        );
    }
}
