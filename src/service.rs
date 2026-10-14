use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::models::BrowseMetrics;
use crate::providers::Provider;
use crate::providers::ReleaseProvider;
use crate::providers::bdix::circleftp::CircleFtpClient;
use crate::providers::bdix::dhakaflix::client::DhakaFlixClient;
use crate::providers::fourkhdhub::FourKHdHubClient;
use crate::providers::models::{CatalogItem, MediaDetails, ProviderError, ProviderKind};
use crate::providers::moviebox::client::MovieBoxClient;

#[derive(Clone)]
pub struct MovieBoxService {
    pub client: MovieBoxClient,
    pub fourk_client: Option<FourKHdHubClient>,
    pub circleftp_client: CircleFtpClient,
    pub dhakaflix_client: DhakaFlixClient,
    pub addon_client: crate::providers::addons::AddonClient,
    pub dramachi_client: crate::providers::dramachi::DramachiClient,
    pub http_client: reqwest::Client,
}

impl Default for MovieBoxService {
    fn default() -> Self {
        Self::new()
    }
}

impl MovieBoxService {
    pub fn new() -> Self {
        let http_client = crate::net::http_client_builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_default();

        Self {
            client: MovieBoxClient::new(),
            fourk_client: FourKHdHubClient::new().ok(),
            circleftp_client: CircleFtpClient::new(),
            dhakaflix_client: DhakaFlixClient::new(),
            addon_client: crate::providers::addons::AddonClient::new(),
            dramachi_client: crate::providers::dramachi::DramachiClient::new(),
            http_client,
        }
    }

    pub fn capabilities(&self, provider: ProviderKind) -> crate::providers::ProviderCapabilities {
        match provider {
            ProviderKind::MovieBox => Provider::capabilities(&self.client),
            ProviderKind::FourKHdHub => self
                .fourk_client
                .as_ref()
                .map(Provider::capabilities)
                .unwrap_or_default(),
            ProviderKind::BdixCircleFtp => Provider::capabilities(&self.circleftp_client),
            ProviderKind::BdixDhakaFlix => Provider::capabilities(&self.dhakaflix_client),
            ProviderKind::Addons => Provider::capabilities(&self.addon_client),
            ProviderKind::Dramachi => Provider::capabilities(&self.dramachi_client),
        }
    }

    pub async fn suggest(&self, query: &str) -> Result<Vec<String>, String> {
        let payload = self
            .client
            .suggest(query)
            .await
            .map_err(|e| e.to_string())?;
        Ok(crate::providers::moviebox::adapt::moviebox_suggest_json_to_strings(&payload))
    }

    pub async fn search_typed(
        &self,
        provider: ProviderKind,
        query: &str,
        page: usize,
    ) -> Result<Vec<CatalogItem>, ProviderError> {
        match provider {
            ProviderKind::MovieBox => Provider::search(&self.client, query, page).await,
            ProviderKind::FourKHdHub => {
                let fourk = self.fourk_client.as_ref().ok_or_else(|| {
                    ProviderError::Unavailable("4KHDHub is unavailable".to_string())
                })?;
                Provider::search(fourk, query, page).await
            }
            ProviderKind::BdixCircleFtp => {
                Provider::search(&self.circleftp_client, query, page).await
            }
            ProviderKind::BdixDhakaFlix => {
                Provider::search(&self.dhakaflix_client, query, page).await
            }
            ProviderKind::Addons => Provider::search(&self.addon_client, query, page).await,
            ProviderKind::Dramachi => Provider::search(&self.dramachi_client, query, page).await,
        }
    }

    pub async fn fetch_addon_catalog(
        &self,
        manifest_url: &str,
        r#type: &str,
        catalog_id: &str,
    ) -> Result<Vec<CatalogItem>, String> {
        let manifest_clone = manifest_url.to_string();
        let type_clone = r#type.to_string();
        let cat_id_clone = catalog_id.to_string();
        if let Ok(Some(cached)) = tokio::task::spawn_blocking(move || {
            crate::cache::get_addon_catalog_cache_typed(&manifest_clone, &type_clone, &cat_id_clone)
        })
        .await
        {
            return Ok(cached);
        }

        let base_url = crate::providers::addons::AddonClient::base_addon_url(manifest_url);
        let metas = self
            .addon_client
            .fetch_catalog(&base_url, r#type, catalog_id, None)
            .await
            .map_err(|e| e.to_string())?;

        let items: Vec<CatalogItem> = metas
            .iter()
            .map(crate::providers::addons::adapter::meta_to_catalog_item)
            .collect();

        let manifest_clone = manifest_url.to_string();
        let type_clone = r#type.to_string();
        let cat_id_clone = catalog_id.to_string();
        let items_clone = items.clone();
        tokio::task::spawn_blocking(move || {
            crate::cache::set_addon_catalog_cache_typed(
                &manifest_clone,
                &type_clone,
                &cat_id_clone,
                &items_clone,
            );
        });
        Ok(items)
    }

    pub async fn details_typed(
        &self,
        provider: ProviderKind,
        subject_id: &str,
    ) -> Result<MediaDetails, ProviderError> {
        match provider {
            ProviderKind::MovieBox => Provider::details(&self.client, subject_id).await,
            ProviderKind::FourKHdHub => {
                let fourk = self.fourk_client.as_ref().ok_or_else(|| {
                    ProviderError::Unavailable("4KHDHub is unavailable".to_string())
                })?;
                Provider::details(fourk, subject_id).await
            }
            ProviderKind::BdixCircleFtp => {
                Provider::details(&self.circleftp_client, subject_id).await
            }
            ProviderKind::BdixDhakaFlix => {
                Provider::details(&self.dhakaflix_client, subject_id).await
            }
            ProviderKind::Addons => Provider::details(&self.addon_client, subject_id).await,
            ProviderKind::Dramachi => Provider::details(&self.dramachi_client, subject_id).await,
        }
    }

    /// Every playable release for one episode, across providers.
    ///
    /// This is the facade the TUI's action dispatcher used to do by hand. It
    /// lives here rather than in a route handler because the same resolution is
    /// needed by both `/api/streams` and `/api/playback/session`.
    pub async fn episode_streams(
        &self,
        provider: ProviderKind,
        subject_id: &str,
        season: usize,
        episode: usize,
    ) -> Result<Vec<crate::providers::models::Release>, ProviderError> {
        match provider {
            ProviderKind::MovieBox => self.moviebox_episode_streams(subject_id, season, episode).await,
            ProviderKind::FourKHdHub => ReleaseProvider::episode_streams(
                self.fourk_client
                    .as_ref()
                    .ok_or_else(|| ProviderError::Unavailable("4KHDHub is unavailable".into()))?,
                subject_id,
                season,
                episode,
            )
            .await,
            ProviderKind::BdixCircleFtp => {
                ReleaseProvider::episode_streams(&self.circleftp_client, subject_id, season, episode)
                    .await
            }
            ProviderKind::BdixDhakaFlix => {
                ReleaseProvider::episode_streams(&self.dhakaflix_client, subject_id, season, episode)
                    .await
            }
            ProviderKind::Dramachi => {
                ReleaseProvider::episode_streams(&self.dramachi_client, subject_id, season, episode)
                    .await
            }
            // Addons have no single backing client: a Stremio-style id is
            // offered by whichever installed addons claim that prefix, so all
            // of them are asked and the results merged.
            ProviderKind::Addons => Ok(self.addon_episode_streams(subject_id, season, episode).await),
        }
    }

    /// Ask every enabled, stream-providing addon for this title.
    ///
    /// Addons that fail are skipped rather than failing the whole request — a
    /// single dead addon in the list must not make a title unplayable.
    async fn addon_episode_streams(
        &self,
        subject_id: &str,
        season: usize,
        episode: usize,
    ) -> Vec<crate::providers::models::Release> {
        let (kind, addon_id, clean_id) = split_addon_id(subject_id);
        let mut merged = Vec::new();

        for addon in crate::config::load_addons() {
            if !addon.enabled || !addon.provides_stream {
                continue;
            }
            // When the id names a specific addon, ask only that one.
            if !addon_id.is_empty() && addon.id_prefixes.iter().all(|p| p != &addon_id) {
                continue;
            }
            // Otherwise fall back to prefix matching so unrelated addons don't
            // return their whole catalogue under our id.
            if addon_id.is_empty()
                && !addon.id_prefixes.is_empty()
                && !addon.id_prefixes.iter().any(|p| kind.starts_with(p.as_str()))
            {
                continue;
            }

            let base = crate::providers::addons::client::AddonClient::base_addon_url(&addon.manifest_url);
            let Ok(items) = self
                .addon_client
                .fetch_streams(&base, &kind, &clean_id)
                .await
            else {
                log::debug!("addon {} did not resolve streams", addon.name);
                continue;
            };

            for item in items {
                if let Some(release) = crate::providers::addons::adapter::stream_item_to_release(
                    &addon.name,
                    &item,
                    season,
                    episode,
                ) {
                    merged.push(release);
                }
            }
        }

        merged
    }

    /// MovieBox resolves episodes from its signed `play-info` payload rather
    /// than through the generic [`ReleaseProvider`] path, so it gets its own
    /// branch with the User-Agent the signature was generated against.
    async fn moviebox_episode_streams(
        &self,
        subject_id: &str,
        season: usize,
        episode: usize,
    ) -> Result<Vec<crate::providers::models::Release>, ProviderError> {
        use crate::providers::ReleaseProvider;
        let releases = self.client.episode_streams(subject_id, season, episode).await?;
        if !releases.is_empty() {
            return Ok(releases);
        }

        // Dub fallback: if the requested ID yielded 0 releases, check if any
        // sibling dub ID for this title provides playable streams.
        if let Ok(details) = self.client.get_details(subject_id).await {
            if let Ok(media_details) =
                crate::providers::moviebox::adapt::moviebox_details_json_to_media_details(&details)
            {
                for sibling_id in media_details.sibling_ids() {
                    if sibling_id != subject_id {
                        if let Ok(fallback) =
                            self.client.episode_streams(&sibling_id, season, episode).await
                        {
                            if !fallback.is_empty() {
                                return Ok(fallback);
                            }
                        }
                    }
                }
            }
        }

        Ok(releases)
    }

    /// Turn a chosen release into something the playback proxy can consume.
    ///
    /// `max_height` caps rendition selection inside the proxy's manifest
    /// rewrite; `subtitle` is the external caption track to inject as a DASH
    /// `AdaptationSet`.
    pub fn resolve_playback_source(
        &self,
        release: &crate::providers::models::Release,
        max_height: Option<u64>,
        subtitle: Option<String>,
    ) -> Result<crate::providers::models::PlaybackSource, ProviderError> {
        let mut source =
            crate::providers::addons::adapter::release_to_playback_source(release)
                .ok_or_else(|| {
                    ProviderError::Unavailable(format!(
                        "`{}` has no playable mirror right now",
                        release.filename
                    ))
                })?;

        if let Some(height) = max_height.filter(|&h| h > 0) {
            source.max_height = Some(height);
        }
        if source.subtitle.is_none() {
            source.subtitle = subtitle;
        }
        Ok(source)
    }

    pub async fn homepage(
        &self,
        tab_id: &str,
        page: usize,
    ) -> Result<
        (
            Vec<CatalogItem>,
            std::collections::HashMap<String, BrowseMetrics>,
        ),
        String,
    > {
        let payload = self
            .client
            .get_homepage(tab_id, page)
            .await
            .map_err(|e| e.to_string())?;
        Ok(crate::providers::moviebox::adapt::moviebox_homepage_json_to_catalog(&payload))
    }

    pub async fn fetch_collection_resolutions(&self, subject_id: &str) -> Result<Vec<u32>, String> {
        self.client
            .fetch_collection_resolutions(subject_id)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn get_ext_captions(
        &self,
        subject_id: &str,
        resource_id: &str,
        sibling_ids: &[String],
        season: usize,
        episode: usize,
    ) -> Result<Vec<crate::providers::models::SubtitleOption>, String> {
        if !subject_id.is_empty() && !resource_id.is_empty() {
            let sid = subject_id.to_string();
            let rid = resource_id.to_string();
            if let Ok(Some(cached)) = tokio::task::spawn_blocking(move || {
                crate::cache::get_captions_cache_typed(&sid, &rid)
            })
            .await
            {
                if sibling_ids.is_empty() || cached.len() > 1 {
                    return Ok(cached);
                }
            }
        }

        let mut all_captions = Vec::new();
        let mut seen_urls = std::collections::HashSet::new();

        let primary_fut = self.client.get_ext_captions(subject_id, resource_id);
        let mut sibling_futs = Vec::new();
        for sib in sibling_ids.iter().take(3) {
            if !sib.is_empty() && sib != subject_id {
                let client = &self.client;
                sibling_futs.push(async move {
                    tokio::time::timeout(std::time::Duration::from_millis(2000), async move {
                        let page = if episode > 0 { (episode - 1) / 20 + 1 } else { 1 };
                        if let Ok((items, _)) =
                            client.fetch_resource_page(sib, season, episode, 0, page).await
                        {
                            let matched_item = find_matching_resource_item(&items, season, episode);
                            if let Some(item) = matched_item {
                                let item_rid = item
                                    .get("resourceId")
                                    .or_else(|| item.get("id"))
                                    .and_then(|v| {
                                        if let Some(n) = v.as_i64() {
                                            Some(n.to_string())
                                        } else if let Some(n) = v.as_u64() {
                                            Some(n.to_string())
                                        } else {
                                            v.as_str().map(|s| s.to_string())
                                        }
                                    });
                                if let Some(rid) = item_rid {
                                    if let Ok(res_payload) = client.get_ext_captions(sib, &rid).await
                                    {
                                        return crate::providers::moviebox::adapt::captions_json_to_options(
                                            &res_payload,
                                        );
                                    }
                                }
                            }
                        }
                        Vec::new()
                    })
                    .await
                    .unwrap_or_default()
                });
            }
        }

        let (primary_res, sibling_results) =
            tokio::join!(primary_fut, futures::future::join_all(sibling_futs));
        if let Ok(payload) = primary_res {
            Self::append_unique_captions(
                &mut all_captions,
                &mut seen_urls,
                crate::providers::moviebox::adapt::captions_json_to_options(&payload),
            );
        }
        for res in sibling_results {
            Self::append_unique_captions(&mut all_captions, &mut seen_urls, res);
        }
        let mut deduplicated: Vec<crate::providers::models::SubtitleOption> = Vec::new();
        let mut seen_languages = std::collections::HashSet::new();
        for sub in all_captions {
            let sanitized_lang = crate::util::text::sanitize_language_label(&sub.name);
            if seen_languages.insert(sanitized_lang) {
                deduplicated.push(sub);
            }
        }

        deduplicated.sort_by(|a, b| {
            let clean_a = crate::util::text::sanitize_language_label(&a.name);
            let clean_b = crate::util::text::sanitize_language_label(&b.name);
            if clean_a.eq_ignore_ascii_case("english") {
                std::cmp::Ordering::Less
            } else if clean_b.eq_ignore_ascii_case("english") {
                std::cmp::Ordering::Greater
            } else {
                clean_a.cmp(&clean_b)
            }
        });
        if !subject_id.is_empty() && !resource_id.is_empty() && !deduplicated.is_empty() {
            let sid = subject_id.to_string();
            let rid = resource_id.to_string();
            let to_cache = deduplicated.clone();
            tokio::task::spawn_blocking(move || {
                crate::cache::set_captions_cache_typed(&sid, &rid, &to_cache);
            });
        }

        Ok(deduplicated)
    }

    fn append_unique_captions(
        target: &mut Vec<crate::providers::models::SubtitleOption>,
        seen_urls: &mut std::collections::HashSet<String>,
        opts: Vec<crate::providers::models::SubtitleOption>,
    ) {
        for opt in opts {
            if seen_urls.insert(opt.url.clone()) {
                target.push(opt);
            }
        }
    }
    pub async fn fetch_poster_bytes(&self, url: &str) -> Option<Vec<u8>> {
        const MAX_POSTER_BYTES: usize = 5 * 1024 * 1024;
        let mut response = self
            .http_client
            .get(url)
            .header("User-Agent", crate::net::APP_HTTP_USER_AGENT)
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?;
        let content_len = response.content_length();
        if content_len.is_some_and(|len| len > MAX_POSTER_BYTES as u64) {
            log::warn!(
                "poster at {} exceeds size limit ({} bytes), skipping",
                crate::logging::sanitize_url(url),
                content_len.unwrap_or(0)
            );
            return None;
        }
        let mut buf = Vec::with_capacity(
            content_len
                .map(|l| (l as usize).min(MAX_POSTER_BYTES))
                .unwrap_or(64 * 1024),
        );
        while let Ok(Some(chunk)) = response.chunk().await {
            if buf.len().saturating_add(chunk.len()) > MAX_POSTER_BYTES {
                return None;
            }
            buf.extend_from_slice(&chunk);
        }
        if buf.is_empty() { None } else { Some(buf) }
    }

    /// Fetch a poster, serving from the on-disk image cache when possible.
    ///
    /// Web replacement for the terminal build's `fetch_and_decode_cached_poster`.
    /// The `image` crate went away with the TUI: the browser decodes and scales
    /// the image itself, so the server only ever deals in bytes.
    pub async fn fetch_cached_poster_bytes(
        &self,
        namespace: &str,
        id: &str,
        url: &str,
    ) -> Option<Arc<[u8]>> {
        let ns = namespace.to_string();
        let id_owned = id.to_string();
        let cached = tokio::task::spawn_blocking(move || {
            crate::cache::get_namespaced_image_cache(&ns, &id_owned)
        })
        .await
        .ok()
        .flatten();

        if let Some(bytes) = cached {
            return Some(Arc::from(bytes.as_slice()));
        }

        let bytes = Arc::<[u8]>::from(self.fetch_poster_bytes(url).await?);

        let ns = namespace.to_string();
        let id_owned = id.to_string();
        let bytes_for_cache = Arc::clone(&bytes);
        tokio::spawn(async move {
            let _ = tokio::task::spawn_blocking(move || {
                crate::cache::set_namespaced_image_cache(&ns, &id_owned, &bytes_for_cache);
            })
            .await;
        });

        Some(bytes)
    }

    pub async fn download_subtitle_file(
        &self,
        url: &str,
        headers: &[(String, String)],
        preferred_filename: Option<&str>,
    ) -> Result<PathBuf, String> {
        let mut request = self.http_client.get(url);
        let sub_host = crate::util::url::extract_host_authority(url);
        let referer_host = headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("referer"))
            .and_then(|(_, val)| crate::util::url::extract_host_authority(val));
        let same_host = sub_host.is_some() && sub_host == referer_host;
        for (name, value) in headers {
            if crate::util::url::should_forward_header(same_host, name) {
                request = request.header(name.as_str(), value.as_str());
            }
        }

        let response = tokio::time::timeout(std::time::Duration::from_secs(8), request.send())
            .await
            .map_err(|_| "timed out".to_string())?
            .map_err(|e| {
                if e.is_timeout() {
                    "timed out".to_string()
                } else {
                    "connection failed".to_string()
                }
            })?;
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status().as_u16()));
        }

        let bytes = response
            .bytes()
            .await
            .map_err(|_| "read error".to_string())?;

        let extension = subtitle_extension_from_url(url);
        let base_dir = resolve_subtitle_dir();
        let _ = tokio::fs::create_dir_all(&base_dir).await;

        let url_clean = url.split(['?', '#']).next().unwrap_or(url);
        let url_tag = &crate::cache::md5_hex(url_clean)[..8];
        let file_stem = if let Some(pref) = preferred_filename {
            let base = crate::download::safe_file_stem(pref);
            format!("{base}_{url_tag}")
        } else {
            format!(
                "{}_{}_{url_tag}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            )
        };
        let path = base_dir.join(format!("{file_stem}.{extension}"));
        tokio::fs::write(&path, bytes)
            .await
            .map_err(|e| format!("write error ({})", e.kind()))?;

        Ok(path)
    }
}

/// Split a Stremio-style id into `(type, addon_id, clean_id)`.
///
/// Addon ids look like `movie:tt0111161` or, when the origin addon needs
/// pinning, `series:org.example:provider:tt0111161`. The third field is what
/// actually goes to the addon; the middle one scopes the request to a single
/// addon when present.
pub fn split_addon_id(id: &str) -> (String, String, String) {
    let (kind, rest) = match id.split_once(':') {
        Some((prefix, rest))
            if ["movie", "series", "tv", "anime", "other"]
                .contains(&prefix.to_ascii_lowercase().as_str()) =>
        {
            (prefix.to_ascii_lowercase(), rest)
        }
        _ => ("movie".to_string(), id),
    };

    // A second colon means the middle segment is an addon identifier.
    if let Some((addon_id, clean)) = rest.split_once(':')
        && !addon_id.is_empty()
    {
        return (kind, addon_id.to_string(), clean.to_string());
    }

    (kind, String::new(), rest.to_string())
}

pub fn metric_value(item: &serde_json::Value, keys: &[&str]) -> Option<f64> {
    let mut containers = vec![item];
    if let Some(metadata) = item.get("metadata") {
        containers.push(metadata);
    }
    if let Some(meta) = item.get("meta") {
        containers.push(meta);
    }

    containers.into_iter().find_map(|container| {
        keys.iter().find_map(|key| {
            let value = container.get(*key)?;
            value
                .as_f64()
                .or_else(|| value.as_i64().map(|number| number as f64))
                .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))
        })
    })
}

pub fn extract_browse_metrics(item: &serde_json::Value) -> BrowseMetrics {
    BrowseMetrics {
        trending: metric_value(
            item,
            &["__browse_rank", "imdb_trending", "imdbTrending", "trending"],
        ),
        rating: metric_value(
            item,
            &["imdbRatingValue", "imdbRate", "imdb_rating", "imdbRating"],
        ),
        recent_rating: metric_value(
            item,
            &[
                "imdb_rating_30d",
                "imdbRating30Days",
                "imdbRatingLast30Days",
                "imdb_rating_recent",
                "imdbRatingValue",
                "imdbRate",
            ],
        ),
        popularity: metric_value(
            item,
            &[
                "__browse_rank",
                "imdb_popularity",
                "imdbPopularity",
                "popularity",
                "viewers",
            ],
        ),
    }
}

pub fn resolve_subtitle_dir() -> PathBuf {
    if crate::config::is_termux_environment() {
        if let Some(home) = dirs::home_dir() {
            let storage = home.join("storage/downloads/moviebox_subs");
            if home.join("storage/downloads").exists() {
                let _ = std::fs::create_dir_all(&storage);
                return storage;
            }
        }
    }
    crate::config::cache_dir().join("subs")
}

pub fn subtitle_extension_from_url(url: &str) -> &'static str {
    let clean = url.split(['?', '#']).next().unwrap_or(url);
    match clean.rsplit('.').next() {
        Some(ext) if ext.eq_ignore_ascii_case("srt") => "srt",
        Some(ext) if ext.eq_ignore_ascii_case("vtt") => "vtt",
        Some(ext) if ext.eq_ignore_ascii_case("ass") => "ass",
        Some(ext) if ext.eq_ignore_ascii_case("ssa") => "ssa",
        Some(ext) if ext.eq_ignore_ascii_case("sub") => "sub",
        _ => "srt",
    }
}

pub fn ensure_moviebox_subdir(path: &Path) -> PathBuf {
    let is_already_mb = path
        .file_name()
        .map(|name| {
            let s = name.to_string_lossy();
            s.eq_ignore_ascii_case("MovieBox-TUI") || s.eq_ignore_ascii_case("MovieBox")
        })
        .unwrap_or(false);

    if is_already_mb {
        path.to_path_buf()
    } else {
        path.join("MovieBox-TUI")
    }
}

pub fn resolve_download_dir(custom_dir: Option<&Path>) -> PathBuf {
    if let Some(custom) = custom_dir {
        if std::fs::create_dir_all(custom).is_ok() {
            let probe = custom.join(format!(".mb_probe_{}", std::process::id()));
            if std::fs::write(&probe, b"ok").is_ok() {
                let _ = std::fs::remove_file(&probe);
                return ensure_moviebox_subdir(custom);
            }
        }
    }

    let base_dir = dirs::download_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Downloads")))
        .unwrap_or_else(|| PathBuf::from("."));

    if crate::config::is_termux_environment() {
        if let Some(home) = dirs::home_dir() {
            let android_storage = home.join("storage/downloads");
            if android_storage.exists() {
                return ensure_moviebox_subdir(&android_storage);
            }
        }
    }

    ensure_moviebox_subdir(&base_dir)
}

pub fn find_matching_resource_item(
    items: &[serde_json::Value],
    season: usize,
    episode: usize,
) -> Option<&serde_json::Value> {
    items.iter().find(|item| {
        let parse_num = |k: &str| -> Option<usize> {
            item.get(k).and_then(|v| {
                v.as_u64()
                    .map(|n| n as usize)
                    .or_else(|| v.as_i64().map(|n| n as usize))
                    .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
            })
        };
        let se = parse_num("se");
        let ep_num = parse_num("ep");
        (season == 0 && episode == 0) || (se == Some(season) && ep_num == Some(episode))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_matching_resource_item_integer_and_string_values() {
        let items = vec![
            serde_json::json!({
                "id": "1001",
                "se": 1,
                "ep": 1
            }),
            serde_json::json!({
                "id": "1002",
                "se": "2",
                "ep": "5"
            }),
        ];

        let matched = find_matching_resource_item(&items, 2, 5);
        assert!(matched.is_some());
        assert_eq!(matched.unwrap().get("id").unwrap().as_str(), Some("1002"));
    }

    #[test]
    fn test_find_matching_resource_item_series_does_not_fall_back_to_episode_one() {
        let items = vec![
            serde_json::json!({
                "id": "1001",
                "se": 1,
                "ep": 1
            }),
            serde_json::json!({
                "id": "1002",
                "se": 1,
                "ep": 2
            }),
        ];

        let matched = find_matching_resource_item(&items, 2, 3);
        assert!(matched.is_none());
    }

    #[test]
    fn test_find_matching_resource_item_movie_matches_first() {
        let items = vec![
            serde_json::json!({
                "id": "movie_res_1"
            }),
            serde_json::json!({
                "id": "movie_res_2"
            }),
        ];

        let matched = find_matching_resource_item(&items, 0, 0);
        assert!(matched.is_some());
        assert_eq!(
            matched.unwrap().get("id").unwrap().as_str(),
            Some("movie_res_1")
        );
    }

    #[test]
    fn test_subtitle_extension_from_url_strips_signed_query_and_fragment() {
        assert_eq!(
            subtitle_extension_from_url(
                "https://cacdn.hakunaymatata.com/subtitle/5cc122.vtt?Policy=eyJ&Signature=abc&Key-Pair-Id=KMH"
            ),
            "vtt"
        );
        assert_eq!(
            subtitle_extension_from_url("https://cdn.example.com/subs/track.ASS?token=123#cue1"),
            "ass"
        );
        assert_eq!(
            subtitle_extension_from_url("https://cdn.example.com/subs/track.ssa"),
            "ssa"
        );
        assert_eq!(
            subtitle_extension_from_url("https://cdn.example.com/subs/track.sub?exp=999"),
            "sub"
        );
        assert_eq!(
            subtitle_extension_from_url("https://cdn.example.com/subs/unknown?format=text"),
            "srt"
        );
    }
}
