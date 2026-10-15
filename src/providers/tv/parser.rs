use super::models::Channel;
use std::path::PathBuf;
use std::time::SystemTime;

pub struct M3UParser {
    cache_dir: PathBuf,
    client: reqwest::Client,
}

impl Default for M3UParser {
    fn default() -> Self {
        Self::new()
    }
}
const MAX_PLAYLIST_BYTES: usize = 15 * 1024 * 1024;

impl M3UParser {
    pub fn new() -> Self {
        let cache_dir = crate::config::cache_dir().join("tv_playlists");
        std::fs::create_dir_all(&cache_dir).ok();
        let client = crate::net::http_client_builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        Self { cache_dir, client }
    }

    pub async fn fetch_playlist(
        &self,
        url: &str,
    ) -> Result<Vec<Channel>, Box<dyn std::error::Error + Send + Sync>> {
        let trimmed = url.trim().trim_matches(|c| c == '"' || c == '\'').trim();
        let is_remote = crate::net::is_http_url(trimmed);
        let content = if is_remote {
            let file_path = self.cache_dir.join(cache_filename(trimmed));
            let mut needs_download = true;

            if tokio::fs::try_exists(&file_path).await.unwrap_or(false) {
                if let Ok(metadata) = tokio::fs::metadata(&file_path).await {
                    if let Ok(modified) = metadata.modified() {
                        if let Ok(duration) = SystemTime::now().duration_since(modified) {
                            if duration.as_secs() < 24 * 3600 {
                                needs_download = false;
                            }
                        }
                    }
                }
            }

            if needs_download {
                let resp = self.client.get(trimmed).send().await?.error_for_status()?;
                if let Some(cl) = resp.content_length() {
                    if cl as usize > MAX_PLAYLIST_BYTES {
                        return Err("remote playlist exceeds maximum 15MB size limit".into());
                    }
                }
                let res = resp.text().await?;
                if res.len() > MAX_PLAYLIST_BYTES {
                    return Err("remote playlist exceeds maximum 15MB size limit".into());
                }
                let _ = crate::cache::atomic_write_file_async(&file_path, res.as_bytes()).await;
                res
            } else {
                match tokio::fs::read_to_string(&file_path).await {
                    Ok(content) => content,
                    Err(_) => {
                        let _ = tokio::fs::remove_file(&file_path).await;
                        self.client
                            .get(trimmed)
                            .send()
                            .await?
                            .error_for_status()?
                            .text()
                            .await?
                    }
                }
            }
        } else {
            let path = if let Some(stripped) = trimmed
                .strip_prefix("~/")
                .or_else(|| trimmed.strip_prefix("~\\"))
            {
                dirs::home_dir()
                    .map(|h| h.join(stripped))
                    .unwrap_or_else(|| std::path::PathBuf::from(trimmed))
            } else if trimmed == "~" {
                dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from(trimmed))
            } else {
                std::path::PathBuf::from(trimmed)
            };
            let metadata = tokio::fs::metadata(&path)
                .await
                .map_err(|error| format!("failed to read playlist file {}: {error}", trimmed))?;
            if metadata.len() as usize > MAX_PLAYLIST_BYTES {
                return Err("local playlist exceeds maximum 15MB size limit".into());
            }
            tokio::fs::read_to_string(&path)
                .await
                .map_err(|error| format!("failed to read playlist file {}: {error}", trimmed))?
        };

        let channels = self.parse_m3u_with_url(&content, Some(trimmed));
        if is_remote && channels.is_empty() {
            let file_path = self.cache_dir.join(cache_filename(trimmed));
            let _ = tokio::fs::remove_file(&file_path).await;
            let resp = self.client.get(trimmed).send().await?.error_for_status()?;
            if let Some(cl) = resp.content_length() {
                if cl as usize > MAX_PLAYLIST_BYTES {
                    return Err("remote playlist exceeds maximum 15MB size limit".into());
                }
            }
            let fresh = resp.text().await?;
            if fresh.len() > MAX_PLAYLIST_BYTES {
                return Err("remote playlist exceeds maximum 15MB size limit".into());
            }
            let fresh_channels = self.parse_m3u_with_url(&fresh, Some(trimmed));
            if fresh_channels.is_empty() {
                return Ok(fresh_channels);
            }
            let _ = crate::cache::atomic_write_file_async(&file_path, fresh.as_bytes()).await;
            return Ok(fresh_channels);
        }
        Ok(channels)
    }

    pub fn parse_m3u(&self, content: &str) -> Vec<Channel> {
        self.parse_m3u_with_url(content, None)
    }

    pub fn parse_m3u_with_url(&self, content: &str, url_hint: Option<&str>) -> Vec<Channel> {
        let fallback_group = url_hint.and_then(infer_group_from_url);
        let fallback_country = url_hint.and_then(infer_country_from_url);
        let estimated = content.as_bytes().iter().filter(|&&b| b == b'\n').count() / 2;
        let mut channels = Vec::with_capacity(estimated.max(16));
        let mut current_channel = Channel::default();

        for line in content.lines() {
            let line = line.trim().trim_start_matches('\u{feff}');
            if line.is_empty() {
                continue;
            }
            if line.starts_with("#EXTINF:") {
                let tvg_id = extract_attr_slice(line, "tvg-id");
                if !tvg_id.is_empty() {
                    current_channel.id = tvg_id.to_string();
                    current_channel.tvg_id = Some(tvg_id.to_string());
                }
                let tvg_logo = extract_attr_slice(line, "tvg-logo");
                if !tvg_logo.is_empty() {
                    current_channel.logo = tvg_logo.to_string();
                }
                let tvg_country = extract_attr_slice(line, "tvg-country");
                if !tvg_country.is_empty() {
                    current_channel.country = normalize_country(tvg_country);
                }
                let group_title = extract_attr_slice(line, "group-title");
                if !group_title.is_empty() {
                    current_channel.group = normalize_group_title(group_title, fallback_group.as_deref());
                    if current_channel.country.is_none() {
                        current_channel.country = infer_country_from_text(group_title);
                    }
                }

                if let Some(idx) = find_extinf_title_comma(line) {
                    current_channel.name = line[idx + 1..].trim().to_string();
                }

                if current_channel.country.is_none() {
                    if let Some(ref tid) = current_channel.tvg_id {
                        current_channel.country = infer_country_from_tvg_id(tid);
                    }
                }
            } else if !line.starts_with('#') {
                let trimmed_url = line.trim();
                let lower_url = trimmed_url.to_ascii_lowercase();
                // Reject non-streaming web pages that cannot be played in HTML5/HLS players
                if lower_url.contains("youtube.com")
                    || lower_url.contains("youtu.be")
                    || lower_url.contains("twitch.tv")
                    || lower_url.contains("dailymotion.com")
                    || lower_url.ends_with(".html")
                    || lower_url.ends_with(".htm")
                    || !crate::net::is_http_url(trimmed_url)
                {
                    current_channel = Channel::default();
                    continue;
                }

                current_channel.stream_url = trimmed_url.to_string();
                current_channel.url = trimmed_url.to_string();
                if current_channel.group.is_empty() {
                    if let Some(ref fb) = fallback_group {
                        current_channel.group = fb.clone();
                    }
                }
                if current_channel.country.is_none() {
                    current_channel.country = fallback_country.clone();
                }
                if current_channel.id.is_empty() {
                    current_channel.id = current_channel.name.clone();
                    current_channel.tvg_id = Some(current_channel.name.clone());
                }
                channels.push(std::mem::take(&mut current_channel));
            }
        }

        channels
    }
}

pub fn normalize_group_title(group_title: &str, fallback: Option<&str>) -> String {
    let token = group_title
        .split(';')
        .next()
        .map(str::trim)
        .unwrap_or("");
    if !token.is_empty() {
        return clean_category_name(token);
    }
    if let Some(fb) = fallback {
        return clean_category_name(fb);
    }
    "General".to_string()
}

pub fn clean_category_name(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return "General".to_string();
    }
    let mut chars = trimmed.chars();
    match chars.next() {
        None => "General".to_string(),
        Some(f) if f.is_lowercase() => f.to_uppercase().collect::<String>() + chars.as_str(),
        Some(_) => trimmed.to_string(),
    }
}

pub fn infer_group_from_url(url: &str) -> Option<String> {
    let lower = url.to_ascii_lowercase();
    if lower.contains("/categories/") || lower.contains("/category/") {
        let filename = lower.rsplit('/').next()?.split('.').next()?;
        if !filename.is_empty() {
            return Some(clean_category_name(filename));
        }
    }
    None
}

pub fn country_from_code(code: &str) -> Option<&'static str> {
    match code.trim().to_ascii_lowercase().as_str() {
        "us" | "usa" => Some("United States"),
        "uk" | "gb" | "gbr" => Some("United Kingdom"),
        "pk" | "pak" => Some("Pakistan"),
        "in" | "ind" => Some("India"),
        "ca" | "can" => Some("Canada"),
        "au" | "aus" => Some("Australia"),
        "de" | "deu" => Some("Germany"),
        "fr" | "fra" => Some("France"),
        "es" | "esp" => Some("Spain"),
        "it" | "ita" => Some("Italy"),
        "sa" | "sau" => Some("Saudi Arabia"),
        "ae" | "are" => Some("United Arab Emirates"),
        "tr" | "tur" => Some("Turkey"),
        "br" | "bra" => Some("Brazil"),
        "eg" | "egy" => Some("Egypt"),
        "bd" | "bgd" => Some("Bangladesh"),
        "nl" | "nld" => Some("Netherlands"),
        "se" | "swe" => Some("Sweden"),
        "no" | "nor" => Some("Norway"),
        "dk" | "dnk" => Some("Denmark"),
        "ch" | "che" => Some("Switzerland"),
        "at" | "aut" => Some("Austria"),
        "jp" | "jpn" => Some("Japan"),
        "kr" | "kor" => Some("South Korea"),
        "cn" | "chn" => Some("China"),
        "mx" | "mex" => Some("Mexico"),
        "ar" | "arg" => Some("Argentina"),
        "za" | "zaf" => Some("South Africa"),
        "ru" | "rus" => Some("Russia"),
        "ua" | "ukr" => Some("Ukraine"),
        "nz" | "nzl" => Some("New Zealand"),
        "ie" | "irl" => Some("Ireland"),
        "af" | "afg" => Some("Afghanistan"),
        "qa" | "qat" => Some("Qatar"),
        "kw" | "kwt" => Some("Kuwait"),
        _ => None,
    }
}

pub fn normalize_country(val: &str) -> Option<String> {
    let trimmed = val.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(full) = country_from_code(trimmed) {
        return Some(full.to_string());
    }
    Some(clean_category_name(trimmed))
}

pub fn infer_country_from_tvg_id(tvg_id: &str) -> Option<String> {
    let id_base = tvg_id.split('@').next()?.trim();
    let code = id_base.rsplit('.').next()?.trim();
    if code.len() == 2 || code.len() == 3 {
        country_from_code(code).map(|s| s.to_string())
    } else {
        None
    }
}

pub fn infer_country_from_url(url: &str) -> Option<String> {
    let lower = url.to_ascii_lowercase();
    if lower.contains("/countries/") || lower.contains("/country/") {
        let filename = lower.rsplit('/').next()?.split('.').next()?;
        if let Some(full) = country_from_code(filename) {
            return Some(full.to_string());
        }
        return Some(clean_category_name(filename));
    }
    for code in ["_us.", "_gb.", "_uk.", "_pk.", "_in.", "_ca.", "_au.", "_de.", "_fr.", "_es.", "_it.", "_sa.", "_ae."] {
        if lower.contains(code) {
            let pure_code = code.trim_matches(|c| c == '_' || c == '.');
            if let Some(full) = country_from_code(pure_code) {
                return Some(full.to_string());
            }
        }
    }
    None
}

pub fn infer_country_from_text(text: &str) -> Option<String> {
    let token = text.split([';', ',']).next().map(str::trim).unwrap_or("");
    if let Some(c) = country_from_code(token) {
        return Some(c.to_string());
    }
    let lower = token.to_ascii_lowercase();
    match lower.as_str() {
        "united states" | "usa" => Some("United States".to_string()),
        "united kingdom" | "uk" => Some("United Kingdom".to_string()),
        "pakistan" => Some("Pakistan".to_string()),
        "india" => Some("India".to_string()),
        "canada" => Some("Canada".to_string()),
        "australia" => Some("Australia".to_string()),
        "germany" => Some("Germany".to_string()),
        "france" => Some("France".to_string()),
        "spain" => Some("Spain".to_string()),
        "italy" => Some("Italy".to_string()),
        "saudi arabia" => Some("Saudi Arabia".to_string()),
        "united arab emirates" | "uae" => Some("United Arab Emirates".to_string()),
        "turkey" => Some("Turkey".to_string()),
        "brazil" => Some("Brazil".to_string()),
        "egypt" => Some("Egypt".to_string()),
        "bangladesh" => Some("Bangladesh".to_string()),
        "afghanistan" => Some("Afghanistan".to_string()),
        "russia" => Some("Russia".to_string()),
        "ukraine" => Some("Ukraine".to_string()),
        "china" => Some("China".to_string()),
        "japan" => Some("Japan".to_string()),
        "south korea" => Some("South Korea".to_string()),
        "mexico" => Some("Mexico".to_string()),
        "argentina" => Some("Argentina".to_string()),
        "south africa" => Some("South Africa".to_string()),
        _ => None,
    }
}

fn extract_attr_slice<'a>(line: &'a str, attr_name: &str) -> &'a str {
    let bytes = line.as_bytes();
    let name_bytes = attr_name.as_bytes();
    let mut i = 0;
    while i + name_bytes.len() + 2 <= bytes.len() {
        if &bytes[i..i + name_bytes.len()] == name_bytes {
            let next_byte = bytes[i + name_bytes.len()];
            if next_byte == b'=' {
                let quote = bytes[i + name_bytes.len() + 1];
                if quote == b'"' || quote == b'\'' {
                    let start = i + name_bytes.len() + 2;
                    if let Some(end_rel) = bytes[start..].iter().position(|&b| b == quote) {
                        return &line[start..start + end_rel];
                    }
                }
            }
        }
        i += 1;
    }
    ""
}

fn find_extinf_title_comma(line: &str) -> Option<usize> {
    let mut in_quote: Option<char> = None;
    for (idx, ch) in line.char_indices() {
        match in_quote {
            Some(quote) if ch == quote => in_quote = None,
            None if ch == '"' || ch == '\'' => in_quote = Some(ch),
            None if ch == ',' => return Some(idx),
            _ => {}
        }
    }
    line.find(',')
}

fn cache_filename(raw: &str) -> String {
    format!("{}.m3u", crate::cache::md5_hex(raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_m3u_double_and_single_quotes() {
        let parser = M3UParser::new();
        let content = r#"#EXTM3U
#EXTINF:-1 tvg-id="cnn.us" tvg-logo="http://logo.png/cnn.png" group-title="News",CNN HD
http://example.com/cnn.m3u8
#EXTINF:-1 tvg-id='bbc.uk' tvg-logo='http://logo.png/bbc.png' group-title='News',BBC World News
http://example.com/bbc.m3u8
#EXTINF:-1,Discovery Channel
http://example.com/discovery.m3u8
"#;
        let channels = parser.parse_m3u(content);
        assert_eq!(channels.len(), 3);

        assert_eq!(channels[0].id, "cnn.us");
        assert_eq!(channels[0].name, "CNN HD");
        assert_eq!(channels[0].logo, "http://logo.png/cnn.png");
        assert_eq!(channels[0].group, "News");
        assert_eq!(channels[0].stream_url, "http://example.com/cnn.m3u8");

        assert_eq!(channels[1].id, "bbc.uk");
        assert_eq!(channels[1].name, "BBC World News");
        assert_eq!(channels[1].logo, "http://logo.png/bbc.png");
        assert_eq!(channels[1].group, "News");
        assert_eq!(channels[1].stream_url, "http://example.com/bbc.m3u8");

        assert_eq!(channels[2].id, "Discovery Channel");
        assert_eq!(channels[2].name, "Discovery Channel");
        assert_eq!(channels[2].group, "");
        assert_eq!(channels[2].stream_url, "http://example.com/discovery.m3u8");
    }

    #[test]
    fn test_parse_m3u_title_with_commas_and_quoted_attributes() {
        let parser = M3UParser::new();
        let content = r#"#EXTM3U
#EXTINF:-1 tvg-id="cnn.us" group-title="News, International",CNN, The Worldwide News Leader
http://example.com/cnn.m3u8
#EXTINF:0,Movie Channel, HD (US), 24/7
http://example.com/movie.m3u8
"#;
        let channels = parser.parse_m3u(content);
        assert_eq!(channels.len(), 2);
        assert_eq!(channels[0].name, "CNN, The Worldwide News Leader");
        assert_eq!(channels[0].group, "News, International");
        assert_eq!(channels[1].name, "Movie Channel, HD (US), 24/7");
    }
    #[tokio::test]
    async fn test_load_channels_local_file_size_limit() {
        let temp_dir = std::env::temp_dir().join(format!("mb_test_m3u_{}", std::process::id()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let file_path = temp_dir.join("oversized.m3u");
        let file = std::fs::File::create(&file_path).unwrap();
        file.set_len((MAX_PLAYLIST_BYTES + 1) as u64).unwrap();

        let parser = M3UParser::new();
        let result = parser.fetch_playlist(file_path.to_str().unwrap()).await;
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("maximum 15MB size limit")
        );

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_parse_m3u_handles_utf8_bom_and_stream_inf_headers() {
        let parser = M3UParser::new();
        let content = "\u{feff}#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2500000\n#EXTINF:-1 tvg-id=\"sp1\" group-title=\"Sports\",Sports Live\n#EXTVLCOPT:http-user-agent=CustomUA\nhttps://live.example.com/sports.m3u8\n";
        let channels = parser.parse_m3u(content);
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].id, "sp1");
        assert_eq!(channels[0].name, "Sports Live");
        assert_eq!(channels[0].group, "Sports");
        assert_eq!(
            channels[0].stream_url,
            "https://live.example.com/sports.m3u8"
        );
    }

    #[test]
    fn test_normalize_group_title_and_infer_category() {
        assert_eq!(normalize_group_title("Entertainment;Family;General", None), "Entertainment");
        assert_eq!(normalize_group_title("Movies;Series", None), "Movies");
        assert_eq!(normalize_group_title("news;live", None), "News");
        assert_eq!(normalize_group_title("", Some("Animation")), "Animation");

        assert_eq!(
            infer_group_from_url("https://iptv-org.github.io/iptv/categories/movies.m3u"),
            Some("Movies".to_string())
        );
        assert_eq!(
            infer_group_from_url("https://iptv-org.github.io/iptv/categories/news.m3u"),
            Some("News".to_string())
        );
    }
}
