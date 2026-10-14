use crate::providers::models::{ProviderKind, Release, SourceMirror};
use crate::providers::moviebox::client::ScraperError;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, ORIGIN, REFERER, USER_AGENT};
use serde_json::Value;

pub const H5_API_BASE: &str = "https://h5-api.aoneroom.com/wefeed-h5api-bff";
pub const DEFAULT_H5_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
pub const DEFAULT_REFERER: &str = "https://moviebox.ph/";
pub const DEFAULT_ORIGIN: &str = "https://moviebox.ph";
pub const FALLBACK_PLAYER_DOMAIN: &str = "https://mzfi.me";

pub fn build_h5_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(DEFAULT_H5_UA));
    headers.insert(REFERER, HeaderValue::from_static(DEFAULT_REFERER));
    headers.insert(ORIGIN, HeaderValue::from_static(DEFAULT_ORIGIN));
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(
        "X-Client-Info",
        HeaderValue::from_static(r#"{"timezone":"Asia/Dhaka"}"#),
    );
    headers.insert("X-Request-Lang", HeaderValue::from_static("en"));
    headers
}

pub fn build_player_headers(
    domain: &str,
    detail_path: &str,
    subject_id: &str,
    season: usize,
    episode: usize,
) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(DEFAULT_H5_UA));
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert("Accept-Language", HeaderValue::from_static("en-US,en;q=0.9"));
    headers.insert(
        "X-Client-Info",
        HeaderValue::from_static(r#"{"timezone":"Asia/Dhaka"}"#),
    );

    let referer = format!(
        "{}/spa/videoPlayPage/movies/{}?id={}&type=/movie/detail&detailSe={}&detailEp={}&lang=en",
        domain, detail_path, subject_id, season, episode
    );
    if let Ok(val) = HeaderValue::from_str(&referer) {
        headers.insert(REFERER, val);
    }
    headers
}

/// Dynamically resolves the active media player gateway domain.
pub async fn fetch_player_domain(client: &reqwest::Client) -> String {
    let url = format!("{}/media-player/get-domain", H5_API_BASE);
    let resp = client.get(&url).headers(build_h5_headers()).send().await;

    if let Ok(r) = resp {
        if let Ok(json) = r.json::<Value>().await {
            if let Some(domain) = json.get("data").and_then(|d| d.as_str()) {
                let trimmed = domain.trim().trim_end_matches('/');
                if !trimmed.is_empty() && trimmed.starts_with("http") {
                    return trimmed.to_string();
                }
            }
        }
    }

    FALLBACK_PLAYER_DOMAIN.to_string()
}

/// Fetches detailPath and title for a given subjectId from the H5 API.
pub async fn fetch_h5_detail(
    client: &reqwest::Client,
    subject_id: &str,
) -> Result<Option<(String, String)>, ScraperError> {
    let url = format!("{}/detail?subjectId={}", H5_API_BASE, subject_id);
    let resp = client
        .get(&url)
        .headers(build_h5_headers())
        .send()
        .await
        .map_err(ScraperError::Reqwest)?;

    let json: Value = resp.json().await.map_err(ScraperError::Reqwest)?;
    let subject = json.get("data").and_then(|d| d.get("subject"));

    let detail_path = subject
        .and_then(|s| s.get("detailPath"))
        .and_then(|p| p.as_str())
        .unwrap_or("")
        .to_string();

    let title = subject
        .and_then(|s| s.get("title"))
        .and_then(|t| t.as_str())
        .unwrap_or("Movie")
        .to_string();

    if detail_path.is_empty() {
        Ok(None)
    } else {
        Ok(Some((detail_path, title)))
    }
}

/// Resolves direct CDN streams using the official Web H5 API gateway.
pub async fn fetch_h5_streams(
    client: &reqwest::Client,
    subject_id: &str,
    season: usize,
    episode: usize,
) -> Result<Vec<Release>, ScraperError> {
    let detail_opt = fetch_h5_detail(client, subject_id).await?;
    let Some((detail_path, title)) = detail_opt else {
        return Ok(Vec::new());
    };

    let domain = fetch_player_domain(client).await;
    let play_url = format!(
        "{}/wefeed-h5api-bff/subject/play?subjectId={}&se={}&ep={}&detailPath={}",
        domain, subject_id, season, episode, detail_path
    );

    let headers = build_player_headers(&domain, &detail_path, subject_id, season, episode);
    let resp = client
        .get(&play_url)
        .headers(headers)
        .send()
        .await
        .map_err(ScraperError::Reqwest)?;

    let json: Value = resp.json().await.map_err(ScraperError::Reqwest)?;
    let data = json.get("data").unwrap_or(&json);
    let streams = data.get("streams").and_then(|s| s.as_array());

    let mut releases = Vec::new();
    let user_agent = DEFAULT_H5_UA.to_string();

    if let Some(stream_arr) = streams {
        for s in stream_arr {
            let url = s
                .get("url")
                .and_then(|u| u.as_str())
                .unwrap_or("")
                .trim();
            if url.is_empty() || !url.starts_with("http") {
                continue;
            }

            let resolutions = s
                .get("resolutions")
                .and_then(|r| {
                    if let Some(n) = r.as_u64() {
                        Some(n.to_string())
                    } else {
                        r.as_str().map(|str_val| str_val.to_string())
                    }
                })
                .unwrap_or_else(|| "1080".to_string());

            let quality = format!("{}p", resolutions.trim_end_matches(['p', 'P']));
            let codec = s
                .get("codecName")
                .or_else(|| s.get("codec"))
                .and_then(|c| c.as_str())
                .unwrap_or("h264")
                .to_string();

            let size_bytes = s.get("size").and_then(|sz| {
                if let Some(n) = sz.as_u64() {
                    Some(n)
                } else if let Some(n) = sz.as_i64() {
                    Some(n as u64)
                } else {
                    sz.as_str().and_then(|str_val| str_val.parse::<u64>().ok())
                }
            });

            let stream_id = s.get("id").and_then(|id| {
                if let Some(n) = id.as_i64() {
                    Some(n.to_string())
                } else if let Some(n) = id.as_u64() {
                    Some(n.to_string())
                } else {
                    id.as_str().map(|str_val| str_val.to_string())
                }
            });

            let mirror = SourceMirror {
                label: format!("MovieBox H5 ({quality})"),
                resolver_url: url.to_string(),
                headers: vec![
                    ("Referer".to_string(), format!("{domain}/")),
                    ("User-Agent".to_string(), user_agent.clone()),
                ],
                direct_file: true,
            };

            releases.push(Release {
                provider: ProviderKind::MovieBox,
                filename: format!("{title} {quality} {codec}"),
                quality: Some(quality),
                codec: Some(codec),
                language: None,
                size_bytes,
                season: if season > 0 { Some(season) } else { None },
                episode: if episode > 0 { Some(episode) } else { None },
                mirrors: vec![mirror],
                resource_id: stream_id,
            });
        }
    }

    Ok(releases)
}
