//! Catalog, search and metadata routes.

use axum::extract::{Query, State};
use axum::routing::get;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use crate::api::error::{ApiError, ApiResult};
use crate::api::state::AppState;
use crate::providers::models::{CatalogItem, MediaDetails, ProviderKind, Release, SubtitleOption};

/// Route table for this module.
pub fn router() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/providers", get(list_providers))
        .route("/search", get(search))
        .route("/search/suggest", get(suggest))
        .route("/homepage", get(homepage))
        .route("/homepage/tabs", get(homepage_tabs))
        .route("/browse/presets", get(browse_presets))
        // Registered before `/browse/{preset}` so the literal path is not
        // captured as a preset key. Axum's matchit gives a static segment
        // priority over a parameter, so this is belt-and-braces, but relying on
        // that precedence to keep `all` out of the preset table would make the
        // two routes' order load-bearing.
        .route("/browse/all", get(browse_all))
        .route("/browse/{preset}", get(browse))
        .route("/details", get(details))
        .route("/streams", get(streams))
        .route("/streams/resolutions", get(resolutions))
        .route("/subtitles", get(subtitles))
}

/// What the frontend sends to `/api/search`.
#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    provider: String,
    /// The search text. Named `q` on the wire for a shorter URL.
    #[serde(alias = "query", rename = "q")]
    query: String,
    #[serde(default = "one")]
    page: usize,
}

fn one() -> usize {
    1
}

/// Parse a provider name from a query parameter.
fn parse_provider(raw: &str) -> ApiResult<ProviderKind> {
    ProviderKind::parse(raw).ok_or_else(|| {
        ApiError::BadRequest(format!(
            "unknown provider `{raw}`; expected one of: {}",
            ProviderKind::ENABLED
                .iter()
                .map(|p| p.cache_key())
                .collect::<Vec<_>>()
                .join(", ")
        ))
    })
}

/// Fetch a required string parameter with a consistent error message.
fn require<'a>(params: &'a HashMap<String, String>, key: &str) -> ApiResult<&'a str> {
    params
        .get(key)
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ApiError::BadRequest(format!("missing `{key}` parameter")))
}

/// Read an optional unsigned query parameter.
fn optional_usize(params: &HashMap<String, String>, key: &str) -> ApiResult<usize> {
    match params.get(key) {
        Some(raw) if !raw.trim().is_empty() => raw
            .parse::<usize>()
            .map_err(|_| ApiError::BadRequest(format!("`{key}` must be a whole number"))),
        _ => Ok(0),
    }
}

/// List every provider with its enabled/available state and capabilities.
async fn list_providers(State(state): State<AppState>) -> ApiResult<Json<Vec<ProviderSummary>>> {
    let config = crate::config::load();
    let probe = super::bdix_probe();

    Ok(Json(
        ProviderKind::ENABLED
            .into_iter()
            .map(|kind| {
                let (enabled, available) = match kind {
                    ProviderKind::MovieBox => (config.moviebox_enabled, true),
                    ProviderKind::FourKHdHub => (config.fourkhdhub_enabled, true),
                    ProviderKind::Dramachi => (config.dramachi_enabled, true),
                    // BDIX hosts live on an Indian ISP's LAN. They only report
                    // as available after a successful probe, so the UI can grey
                    // them out instead of offering a provider that will hang on
                    // every request.
                    ProviderKind::BdixCircleFtp => (config.bdix_circleftp_enabled, probe.circleftp),
                    ProviderKind::BdixDhakaFlix => (config.bdix_dhakaflix_enabled, probe.dhakaflix),
                    ProviderKind::Addons => (config.addons_enabled, true),
                };

                ProviderSummary {
                    kind,
                    label: kind.label().to_string(),
                    enabled,
                    available,
                    capabilities: state.service.capabilities(kind),
                }
            })
            .collect(),
    ))
}

#[derive(Debug, Serialize)]
pub struct ProviderSummary {
    pub kind: ProviderKind,
    pub label: String,
    pub enabled: bool,
    pub available: bool,
    pub capabilities: crate::providers::ProviderCapabilities,
}

/// Search one provider.
async fn search(
    State(state): State<AppState>,
    Query(params): Query<SearchQuery>,
) -> ApiResult<Json<Vec<CatalogItem>>> {
    let provider = parse_provider(&params.provider)?;
    let query = params.query.trim();

    if query.is_empty() {
        // An error would make the search box feel broken; an empty result set
        // reads as "nothing yet".
        return Ok(Json(Vec::new()));
    }

    state
        .service
        .search_typed(provider, query, params.page.max(1))
        .await
        .map(Json)
        .map_err(ApiError::from)
}

/// Type-ahead suggestions. Only MovieBox implements this upstream.
async fn suggest(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Json<Vec<String>>> {
    let query = params.get("q").map(String::as_str).unwrap_or_default();
    if query.trim().is_empty() {
        return Ok(Json(Vec::new()));
    }
    // A failed suggestion lookup should degrade to "no suggestions", never to a
    // visible error while the user is still typing.
    Ok(Json(
        state.service.suggest(query).await.unwrap_or_default(),
    ))
}

/// One homepage tab's worth of catalogue.
async fn homepage(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Json<serde_json::Value>> {
    let tab_id = require(&params, "tab_id")?;
    let page = optional_usize(&params, "page")?.max(1);

    let (items, metrics) = state
        .service
        .homepage(tab_id, page)
        .await
        .map_err(ApiError::Upstream)?;

    Ok(Json(serde_json::json!({
        "items": items,
        "metrics": metrics,
    })))
}

/// The browse presets the homepage tabs map to.
async fn browse_presets() -> Json<Vec<BrowsePreset>> {
    Json(BrowsePreset::ALL.to_vec())
}

/// One entry in the browse rail list.
///
/// `Trending`, `Top Rated` and `Most Watched` are not upstream tabs — the API has
/// no such thing. They are *orderings* of the same catalogue, which is why they
/// need a metric and a source rather than a `tabId`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct BrowsePreset {
    pub key: &'static str,
    pub label: &'static str,
    /// Which [`BrowseMetrics`] field decides the order.
    pub metric: BrowseMetricKey,
    /// Homepage tabs pooled together to fill the rail.
    ///
    /// More than one because a single tab is lopsided — tab 1 is mostly recent
    /// Bollywood, so a "Top Rated" rail drawn from it alone would exclude every
    /// acclaimed international title.
    pub sources: &'static [&'static str],
}

impl BrowsePreset {
    pub const ALL: &'static [BrowsePreset] = &[
        BrowsePreset {
            key: "trending",
            label: "Trending",
            metric: BrowseMetricKey::trending,
            sources: &["1", "5", "7"],
        },
        BrowsePreset {
            key: "top_rated_all_time",
            label: "Top Rated",
            metric: BrowseMetricKey::rating,
            sources: &["1", "2", "5", "19"],
        },
        BrowsePreset {
            key: "top_rated_recent",
            label: "Top Rated This Month",
            metric: BrowseMetricKey::recent_rating,
            sources: &["1", "2", "18"],
        },
        BrowsePreset {
            key: "most_watched",
            label: "Most Watched",
            metric: BrowseMetricKey::popularity,
            sources: &["1", "5", "20"],
        },
    ];

    fn parse(key: &str) -> Option<&'static Self> {
        Self::ALL.iter().find(|preset| preset.key == key)
    }
}

/// Wire form of [`crate::models::BrowseMetric`].
///
/// The model's enum is `Copy` but not `Serialize`, and this endpoint needs it in
/// a response body. Keeping a separate serialisable mirror avoids adding a serde
/// derive to a domain type purely for the API surface.
///
/// The variant names are snake_case on the wire because they are echoed back as
/// the `metric` field of a preset, where they read as field names rather than
/// type names — and they match `BrowseMetrics`' own keys, so a client can use
/// one string to index either.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(non_camel_case_types)] // Snake case is the point: these are field names on the wire.
pub enum BrowseMetricKey {
    trending,
    rating,
    recent_rating,
    popularity,
}

impl BrowseMetricKey {
    fn read(self, metrics: &crate::models::BrowseMetrics) -> Option<f64> {
        match self {
            Self::trending => metrics.trending,
            Self::rating => metrics.rating,
            Self::recent_rating => metrics.recent_rating,
            Self::popularity => metrics.popularity,
        }
    }
}

/// How many titles a browse rail returns.
///
/// A rail is a horizontal scroller; twenty is roughly two and a half screens of
/// a 1920-wide viewport, which is enough to scroll without ever hitting the end
/// and finding it empty.
const RAIL_LENGTH: usize = 20;

/// One rail, ready to render.
#[derive(Debug, Serialize)]
pub struct BrowseRail {
    pub key: &'static str,
    pub label: &'static str,
    pub items: Vec<CatalogItem>,
}

/// Build one browse rail by pooling its source tabs and ordering by metric.
///
/// ## Why this is not just a `tabId`
///
/// The upstream API exposes only editorial tabs ("Movies", "TV Series", …). It
/// has no trending or top-rated feed, so a rail has to be derived: fetch a broad
/// slice of the catalogue, then order it by the ranking fields the homepage
/// response already carries. That is why [`BrowsePreset`] names a metric and a
/// set of sources instead of a single tab.
///
/// ## Partial failure is the normal case
///
/// One unreachable tab must not empty the rail. A tab that fails is skipped, and
/// the rail is returned as long as *any* source answered — so a single provider
/// hiccup degrades a rail rather than breaking the home page.
async fn browse(
    State(state): State<AppState>,
    axum::extract::Path(preset_key): axum::extract::Path<String>,
) -> ApiResult<Json<BrowseRail>> {
    let preset = BrowsePreset::parse(&preset_key).ok_or_else(|| {
        ApiError::BadRequest(format!(
            "unknown browse preset `{preset_key}`; expected one of: {}",
            BrowsePreset::ALL
                .iter()
                .map(|p| p.key)
                .collect::<Vec<_>>()
                .join(", ")
        ))
    })?;

    Ok(Json(build_rail(&state, preset).await?))
}

/// Pool a preset's source tabs and order the result.
///
/// Split out of [`browse`] so [`browse_all`] and the single-rail endpoint share
/// one implementation. Two copies of this loop would eventually disagree about
/// how a partial failure is handled, and only one of them would be tested.
async fn build_rail(state: &AppState, preset: &'static BrowsePreset) -> ApiResult<BrowseRail> {
    let mut pooled: Vec<(CatalogItem, Option<f64>)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut failed_sources = 0usize;

    // Sequential rather than concurrent: three extra requests to one CDN at once
    // is what trips its rate limiter, and a rail is not latency-critical enough
    // to be worth a 429.
    for source in preset.sources {
        match state.service.homepage(source, 1).await {
            Ok((items, metrics)) => {
                for item in items {
                    let score = preset.metric.read(&metrics[&item.id.value]);
                    if seen.insert(item.id.value.clone()) {
                        pooled.push((item, score));
                    }
                }
            }
            Err(error) => {
                failed_sources += 1;
                log::warn!("browse source tab {source} failed: {error}");
            }
        }
    }

    if pooled.is_empty() {
        return Err(ApiError::Upstream(format!(
            "no catalogue source answered for `{}`",
            preset.key
        )));
    }

    // Titles with no value for this metric sort last instead of dropping out:
    // the rail should stay full, and a title that simply lacks an IMDb rating is
    // still worth watching.
    let items = rank_rail(pooled, RAIL_LENGTH);

    if failed_sources > 0 {
        log::info!(
            "browse `{}` built from {}/{} source tabs",
            preset.key,
            preset.sources.len() - failed_sources,
            preset.sources.len()
        );
    }

    Ok(BrowseRail {
        key: preset.key,
        label: preset.label,
        items,
    })
}

/// Every browse rail, in one response.
///
/// ## Why the home page needs this rather than four calls
///
/// [`browse`] fetches its source tabs sequentially because concurrent requests to
/// one CDN trip the rate limiter. The home page however mounts four rails at
/// once, so four browser requests meant four *concurrent* walk-ups of that same
/// sequential walk -- and the limiter, which tolerates one, did not tolerate
/// four. One rail came back empty or failed, and the page silently lost a row.
///
/// Moving the loop behind a single endpoint restores the invariant that only one
/// rail is ever being fetched upstream at a time. The frontend pays one round
/// trip instead of four, which is also strictly better on localhost.
///
/// ## Failures are per-rail, not fatal
///
/// A rail whose sources all failed is left out of the list. The rest still
/// render, because a home page with three of four rails is the right outcome and
/// an error page with none is not.
async fn browse_all(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<BrowseAllQuery>,
) -> ApiResult<Json<Vec<BrowseRail>>> {
    // Every key is resolved before the first fetch, so a typo costs one round
    // trip rather than three per rail -- and so an invalid request is provably
    // answered without touching the network. `tests/api_contract.rs` relies on
    // that second half to cover this route without a live CDN.
    let presets = resolve_presets(query.presets.as_deref())?;

    let mut rails = Vec::with_capacity(presets.len());

    for preset in presets {
        match build_rail(&state, preset).await {
            Ok(rail) => rails.push(rail),
            Err(error) => {
                // Logged with the preset named. Swallowing this silently is how a
                // rail goes missing without anyone noticing.
                log::warn!("browse-all: `{}` failed: {}", preset.key, error);
            }
        }
    }

    if rails.is_empty() {
        return Err(ApiError::Upstream(
            "no browse rail could be built; the catalogue is unreachable".into(),
        ));
    }

    Ok(Json(rails))
}

/// Which rails [`browse_all`] should build.
#[derive(Debug, Default, Deserialize)]
pub struct BrowseAllQuery {
    /// Comma-separated preset keys. Absent means every preset, in
    /// [`BrowsePreset::ALL`] order.
    ///
    /// A filter rather than a count because it is the only version that stays
    /// meaningful: a client that wants one rail can name it, and cannot
    /// accidentally get a different one because the list changed underneath it.
    presets: Option<String>,
}

/// Resolve a `presets` filter into the presets to build.
///
/// An empty or absent filter means "all", which is what a bare `/browse/all` from
/// the home page sends. Blank entries are skipped so a trailing comma is not an
/// error -- the same forgiving reading [`optional_query_param`] applies elsewhere.
fn resolve_presets(filter: Option<&str>) -> ApiResult<Vec<&'static BrowsePreset>> {
    let Some(filter) = filter.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(BrowsePreset::ALL.iter().collect());
    };

    let mut chosen = Vec::new();
    for key in filter.split(',').map(str::trim).filter(|key| !key.is_empty()) {
        let preset = BrowsePreset::parse(key).ok_or_else(|| {
            ApiError::BadRequest(format!(
                "unknown browse preset `{key}`; expected one of: {}",
                BrowsePreset::ALL
                    .iter()
                    .map(|p| p.key)
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        })?;
        // Deduped rather than erroring: `?presets=trending,trending` asking for
        // one rail twice is a client bug, not two requests for the same thing.
        if !chosen
            .iter()
            .any(|existing: &&'static BrowsePreset| existing.key == preset.key)
        {
            chosen.push(preset);
        }
    }

    if chosen.is_empty() {
        // A filter of nothing but separators reads as "all" rather than "no
        // rails", because "no rails" has no useful meaning here and the
        // alternative -- an error -- is unhelpful for a malformed URL.
        return Ok(BrowsePreset::ALL.iter().collect());
    }

    Ok(chosen)
}

/// Order pooled titles by score, highest first, and cut to `limit`.
///
/// Split out of [`browse`] because the ordering is the whole point of a rail and
/// needs testing without three upstream requests. Takes ownership so it can
/// build the result in place rather than sorting twice.
fn rank_rail(
    mut pooled: Vec<(CatalogItem, Option<f64>)>,
    limit: usize,
) -> Vec<CatalogItem> {
    pooled.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    pooled.truncate(limit);
    pooled.into_iter().map(|(item, _)| item).collect()
}

/// A homepage tab as the UI should present it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct HomepageTab {
    /// The upstream `tabId`, as a string.
    ///
    /// A string because it travels as a query parameter and back out again in a
    /// link; keeping it opaque means an id that is not numeric costs nothing.
    pub id: &'static str,
    pub label: &'static str,
    /// Short description shown under the label on the tab rail.
    pub blurb: &'static str,
    /// Only listed when `mature_content_enabled` is set.
    pub mature: bool,
}

/// The homepage tabs, in display order.
///
/// ## Provenance
///
/// These ids are **not** in the upstream API documentation and they are not
/// guessable — `/tab-operating?tabId=N` silently returns the default tab for an
/// unknown id rather than an error, so a wrong id looks like a working one. The
/// list below was established by probing ids against the live API and reading
/// what came back, then is pinned here with tests so a future upstream change
/// surfaces as a reviewable diff instead of a silently reshuffled home page.
///
/// Ids that are deliberately absent:
///
/// | Id      | Why not                                                        |
/// |---------|----------------------------------------------------------------|
/// | `3`     | School course work (CBSE textbooks) — not a media catalogue.     |
/// | `4`     | Music videos. Real content, wrong shape for a film browser.       |
/// | `6, 10` | Byte-identical to `1`. Alias tabs, not distinct feeds.            |
/// | `13`    | Byte-identical to `7`.                                          |
/// | `14-17` | Return an empty catalogue.                                      |
/// | `21, 26`| Return an empty catalogue.                                      |
/// | `22+`   | Collapse to the default tab.                                    |
const HOME_TABS: &[HomepageTab] = &[
    HomepageTab {
        id: "1",
        label: "For You",
        blurb: "Movies and series, freshly added",
        mature: false,
    },
    HomepageTab {
        id: "2",
        label: "Movies",
        blurb: "Hindi and Bollywood films",
        mature: false,
    },
    HomepageTab {
        id: "5",
        label: "TV Series",
        blurb: "Indian serialised television",
        mature: false,
    },
    HomepageTab {
        id: "19",
        label: "International",
        blurb: "Series from around the world",
        mature: false,
    },
    HomepageTab {
        id: "18",
        label: "Indian Drama",
        blurb: "Romance and family drama serials",
        mature: false,
    },
    HomepageTab {
        id: "20",
        label: "Reality TV",
        blurb: "Big Brother, talk shows, competitions",
        mature: false,
    },
    HomepageTab {
        id: "8",
        label: "Anime",
        blurb: "Japanese animation, dubbed",
        mature: false,
    },
    HomepageTab {
        id: "23",
        label: "Kids",
        blurb: "Animation and family films",
        mature: false,
    },
    HomepageTab {
        id: "7",
        label: "Short Films",
        blurb: "Independent and low-budget features",
        mature: false,
    },
    HomepageTab {
        id: "9",
        label: "Midnight",
        blurb: "Adult catalogue",
        mature: true,
    },
];

/// The tabs the current settings allow.
fn visible_homepage_tabs(config: &crate::config::Config) -> Vec<HomepageTab> {
    HOME_TABS
        .iter()
        .copied()
        .filter(|tab| !tab.mature || config.mature_content_enabled)
        .collect()
}

/// The tab rail, filtered by settings.
///
/// The frontend never hardcodes this list. Tab ids are an upstream implementation
/// detail with no documentation, so duplicating them into TypeScript would create
/// a second place to get wrong and no way to notice.
async fn homepage_tabs() -> ApiResult<Json<Vec<HomepageTab>>> {
    Ok(Json(visible_homepage_tabs(&crate::config::load())))
}

/// Full metadata for one title.
async fn details(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Json<MediaDetails>> {
    let provider = parse_provider(require(&params, "provider")?)?;
    let id = require(&params, "id")?;

    state
        .service
        .details_typed(provider, id)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

/// Available releases for a title, narrowed to one episode when given.
async fn streams(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Json<Vec<Release>>> {
    let provider = parse_provider(require(&params, "provider")?)?;
    let id = require(&params, "id")?;
    let season = optional_usize(&params, "season")?;
    let episode = optional_usize(&params, "episode")?;

    state
        .service
        .episode_streams(provider, id, season, episode)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

/// The distinct video heights on offer for a title.
async fn resolutions(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Json<Vec<u32>>> {
    let provider = parse_provider(require(&params, "provider")?)?;
    let subject_id = require(&params, "id")?;

    if provider != ProviderKind::MovieBox {
        // Only MovieBox exposes a resolution collection upstream; the others
        // return a flat list where every release already carries its own
        // quality label.
        return Ok(Json(Vec::new()));
    }

    state
        .service
        .fetch_collection_resolutions(subject_id)
        .await
        .map(Json)
        .map_err(ApiError::Upstream)
}

/// External subtitle tracks for one episode.
async fn subtitles(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Json<Vec<SubtitleOption>>> {
    let subject_id = require(&params, "subject_id")?;
    let resource_id = require(&params, "resource_id")?;
    let siblings: Vec<String> = params
        .get("siblings")
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let season = optional_usize(&params, "season")?;
    let episode = optional_usize(&params, "episode")?;

    state
        .service
        .get_ext_captions(&subject_id, &resource_id, &siblings, season, episode)
        .await
        .map(Json)
        .map_err(ApiError::Upstream)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::BrowseMetrics;
    use crate::providers::models::ProviderMediaId;

    /// A catalogue entry with just enough shape for the ranking tests.
    fn item(id: &str) -> CatalogItem {
        CatalogItem {
            id: ProviderMediaId {
                provider: ProviderKind::MovieBox,
                value: id.to_string(),
            },
            title: format!("title-{id}"),
            media_type: crate::providers::models::MediaType::Movie,
            year: None,
            poster_url: None,
            season_count: None,
        }
    }

    /* Preset lookup ------------------------------------------------------- */

    #[test]
    fn every_advertised_preset_parses() {
        // `browse_presets` publishes these keys and `browse` accepts them. If a
        // key is listed but unparseable, the rail 400s for a link the app itself
        // just rendered.
        for preset in BrowsePreset::ALL {
            assert_eq!(
                BrowsePreset::parse(preset.key).map(|p| p.key),
                Some(preset.key),
                "`{}` is advertised by /api/browse/presets but rejected by /api/browse/{{}}",
                preset.key
            );
        }
    }

    #[test]
    fn an_unknown_preset_key_is_rejected() {
        assert!(BrowsePreset::parse("top_rated_someday").is_none());
        assert!(BrowsePreset::parse("").is_none());
        // Case-sensitive on purpose: these arrive from a fixed set of links, and
        // a lenient match would silently route a typo to the wrong ordering.
        assert!(BrowsePreset::parse("Trending").is_none());
    }

    #[test]
    fn presets_are_distinct() {
        let mut keys: Vec<&str> = BrowsePreset::ALL.iter().map(|p| p.key).collect();
        let count = keys.len();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), count, "duplicate preset key");
    }

    #[test]
    fn every_preset_reads_a_metric_that_homepage_actually_sends() {
        // A rail ordered by a field the homepage payload never populates would
        // fall back to source order and look like a bug nobody can explain.
        let populated = BrowseMetrics {
            trending: Some(10.0),
            rating: Some(8.0),
            recent_rating: Some(7.0),
            popularity: Some(9.0),
        };
        for preset in BrowsePreset::ALL {
            assert!(
                preset.metric.read(&populated).is_some(),
                "`{}` sorts by {:?}, which no sample metric sets",
                preset.key,
                preset.metric
            );
        }
    }

    #[test]
    fn every_preset_source_is_a_tab_we_advertise() {
        // Otherwise a rail quietly pulls from a tab the tab rail does not show,
        // which makes the two disagree about what the catalogue contains.
        let advertised: HashSet<&str> = HOME_TABS.iter().map(|t| t.id).collect();
        for preset in BrowsePreset::ALL {
            for source in preset.sources {
                assert!(
                    advertised.contains(source),
                    "preset `{}` draws from tab {source}, which is not in HOME_TABS",
                    preset.key
                );
            }
        }
    }

    /* Metric access ------------------------------------------------------- */

    #[test]
    fn each_metric_key_reads_its_own_field() {
        let metrics = BrowseMetrics {
            trending: Some(1.0),
            rating: Some(2.0),
            recent_rating: Some(3.0),
            popularity: Some(4.0),
        };
        assert_eq!(BrowseMetricKey::trending.read(&metrics), Some(1.0));
        assert_eq!(BrowseMetricKey::rating.read(&metrics), Some(2.0));
        assert_eq!(BrowseMetricKey::recent_rating.read(&metrics), Some(3.0));
        assert_eq!(BrowseMetricKey::popularity.read(&metrics), Some(4.0));
    }

    #[test]
    fn a_metric_key_serialises_to_the_field_name_it_reads() {
        // The `metric` field of a preset is documentation for the client, and it
        // doubles as a key into `BrowseMetrics`. Renaming one side silently
        // breaks that.
        let json = serde_json::to_value(BrowseMetricKey::recent_rating).unwrap();
        assert_eq!(json, serde_json::json!("recent_rating"));
    }

    /* Ranking ------------------------------------------------------------- */

    #[test]
    fn ranking_orders_by_score_highest_first() {
        let pooled = vec![
            (item("low"), Some(1.0)),
            (item("high"), Some(9.0)),
            (item("mid"), Some(5.0)),
        ];
        let ranked = rank_rail(pooled, 10);
        let ids: Vec<&str> = ranked.iter().map(|i| i.id.value.as_str()).collect();
        assert_eq!(ids, ["high", "mid", "low"]);
    }

    #[test]
    fn unrated_titles_sink_to_the_bottom_rather_than_vanishing() {
        // A rail with a hole in it reads as a bug; a title with no IMDb rating is
        // still watchable, so it belongs at the end of the rail, not outside it.
        let pooled = vec![
            (item("unrated"), None),
            (item("rated"), Some(3.0)),
            (item("also-unrated"), None),
        ];
        let ranked = rank_rail(pooled, 10);
        let ids: Vec<&str> = ranked.iter().map(|i| i.id.value.as_str()).collect();
        assert_eq!(ids, ["rated", "unrated", "also-unrated"]);
    }

    #[test]
    fn ranking_cuts_to_the_rail_length() {
        let pooled: Vec<_> = (0..100)
            .map(|n| (item(&format!("i{n}")), Some(n as f64)))
            .collect();
        let ranked = rank_rail(pooled, RAIL_LENGTH);
        assert_eq!(ranked.len(), RAIL_LENGTH);
        assert_eq!(ranked[0].id.value, "i99", "should keep the highest scores");
    }

    #[test]
    fn a_rail_shorter_than_its_limit_is_left_alone() {
        let pooled = vec![(item("only"), Some(1.0))];
        assert_eq!(rank_rail(pooled, RAIL_LENGTH).len(), 1);
    }

    #[test]
    fn equal_scores_keep_their_source_order() {
        // Stability matters more than it looks: the source order is upstream's
        // editorial ranking, so an unstable sort would discard it for no reason.
        let pooled = vec![
            (item("first"), Some(5.0)),
            (item("second"), Some(5.0)),
            (item("third"), Some(5.0)),
        ];
        let ids: Vec<String> = rank_rail(pooled, 10)
            .into_iter()
            .map(|i| i.id.value)
            .collect();
        assert_eq!(ids, ["first", "second", "third"]);
    }

    /* Homepage tabs ------------------------------------------------------- */

    #[test]
    fn mature_tab_is_hidden_until_it_is_opted_into() {
        let mut config = crate::config::Config::default();

        let hidden = visible_homepage_tabs(&config);
        assert!(
            !hidden.iter().any(|t| t.mature),
            "Midnight must not be listed by default: {:?}",
            hidden.iter().map(|t| t.label).collect::<Vec<_>>()
        );
        // The tab must still exist, just gated -- otherwise re-enabling the
        // setting would have nothing to reveal.
        assert!(HOME_TABS.iter().any(|t| t.mature));

        config.mature_content_enabled = true;
        let shown = visible_homepage_tabs(&config);
        assert!(shown.iter().any(|t| t.mature));
        assert_eq!(shown.len(), HOME_TABS.len());
    }

    #[test]
    fn mature_content_defaults_to_off() {
        // Stated as a test because it is a product decision, not an
        // implementation detail: a fresh install must never surface adult
        // content without the user asking for it.
        assert!(!crate::config::Config::default().mature_content_enabled);
    }

    #[test]
    fn homepage_tab_ids_are_unique() {
        let mut ids: Vec<&str> = HOME_TABS.iter().map(|t| t.id).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "duplicate homepage tab id");
    }

    #[test]
    fn homepage_tab_labels_are_unique() {
        let mut labels: Vec<&str> = HOME_TABS.iter().map(|t| t.label).collect();
        let count = labels.len();
        labels.sort_unstable();
        labels.dedup();
        assert_eq!(labels.len(), count, "duplicate homepage tab label");
    }

    #[test]
    fn homepage_tabs_exclude_the_known_useless_upstream_ids() {
        // Each of these was probed against the live API and found to be an alias
        // of another tab, or empty. Listing one would either duplicate a rail or
        // show nothing at all -- and because an unknown id silently falls back to
        // the default tab, a mistake here is invisible in testing.
        let listed: HashSet<&str> = HOME_TABS.iter().map(|t| t.id).collect();

        // Byte-identical duplicates of tab 1 and tab 7.
        for alias in ["6", "10", "13", "22", "24", "25"] {
            assert!(
                !listed.contains(alias),
                "tab {alias} duplicates another tab upstream and must stay unlisted"
            );
        }
        // School course work and music videos: real content, wrong shape.
        for offbeat in ["3", "4"] {
            assert!(
                !listed.contains(offbeat),
                "tab {offbeat} is courses/music, not a media catalogue"
            );
        }
        // Empty catalogues.
        for empty in ["14", "15", "16", "17", "21", "26"] {
            assert!(
                !listed.contains(empty),
                "tab {empty} returns an empty catalogue"
            );
        }
    }

    #[test]
    fn the_first_tab_is_the_default_feed() {
        // "For You" is what the home page loads before the user picks anything,
        // so it has to be the broad mixed feed rather than a niche tab.
        assert_eq!(HOME_TABS.first().map(|t| t.id), Some("1"));
        assert_eq!(HOME_TABS.first().map(|t| t.label), Some("For You"));
    }

    /* ------------------------------------------------------------------ */
    /* Browse-all filter                                                    */
    /* ------------------------------------------------------------------ */

    /// The keys of a resolved filter.
    fn keys_of(presets: &[&'static BrowsePreset]) -> Vec<&'static str> {
        presets.iter().map(|preset| preset.key).collect()
    }

    /// The keys of every preset, in declaration order.
    fn all_keys() -> Vec<&'static str> {
        BrowsePreset::ALL.iter().map(|preset| preset.key).collect()
    }

    #[test]
    fn no_filter_means_every_preset_in_declaration_order() {
        // The bare `/browse/all` the home page sends. Order is the server's,
        // because the server is also what decides how many rails exist.
        assert_eq!(
            keys_of(&resolve_presets(None).expect("no filter cannot fail")),
            all_keys()
        );
        // A blank filter reads as absent rather than as an empty list, because
        // "no rails at all" is not a state this endpoint has a meaning for.
        assert_eq!(
            keys_of(&resolve_presets(Some("")).expect("blank cannot fail")),
            all_keys()
        );
        assert_eq!(
            keys_of(&resolve_presets(Some("   ")).expect("blank cannot fail")),
            all_keys()
        );
    }

    #[test]
    fn a_filter_narrows_to_the_named_presets() {
        let chosen = resolve_presets(Some("trending,most_watched")).expect("both are real");
        assert_eq!(keys_of(&chosen), ["trending", "most_watched"]);
    }

    #[test]
    fn a_filter_preserves_the_requested_order() {
        // Deliberately reversed relative to `BrowsePreset::ALL`. A caller that
        // names three rails wants them in the order it named them, not silently
        // reordered into declaration order.
        let chosen = resolve_presets(Some("most_watched,trending")).expect("both are real");
        assert_eq!(keys_of(&chosen), ["most_watched", "trending"]);
    }

    #[test]
    fn a_filter_repeats_and_pads_without_complaining() {
        // A trailing comma or doubled comma is a URL someone typed, not a client
        // bug worth rejecting, and neither should produce two requests for the
        // same rail.
        let chosen = resolve_presets(Some("trending,trending,")).expect("noisy but valid");
        assert_eq!(keys_of(&chosen), ["trending"]);
    }

    #[test]
    fn a_filter_of_only_separators_means_every_preset() {
        let chosen = resolve_presets(Some(",, ,")).expect("blank cannot fail");
        assert_eq!(keys_of(&chosen), all_keys());
    }

    #[test]
    fn an_unknown_key_is_rejected_naming_the_valid_ones() {
        // The message has to list the alternatives. "unknown preset" alone sends
        // the caller back to the source to find the spelling.
        let error = resolve_presets(Some("trending,nope")).expect_err("`nope` is not a preset");

        let message = error.to_string();
        assert!(
            message.contains("nope"),
            "the message must name the offending key: {message}"
        );
        for preset in BrowsePreset::ALL {
            assert!(
                message.contains(preset.key),
                "the message must list `{}` as a valid key: {message}",
                preset.key
            );
        }
    }

    #[test]
    fn keys_are_case_sensitive() {
        // Matches `/browse/{preset}`. A filter that accepted `Trending` while the
        // single-rail route rejected it would be a second spelling to keep in
        // sync, and would silently fall back to "all" rather than erroring.
        assert!(resolve_presets(Some("Trending")).is_err());
    }

    #[test]
    fn the_batch_filter_and_the_single_route_accept_the_same_keys() {
        // Two parsers for one set of names is exactly the kind of duplication
        // that drifts, so this pins them together explicitly.
        for preset in BrowsePreset::ALL {
            assert!(BrowsePreset::parse(preset.key).is_some());
            assert!(
                resolve_presets(Some(preset.key)).is_ok(),
                "`{}` must pass the filter too",
                preset.key
            );
        }
    }
}
