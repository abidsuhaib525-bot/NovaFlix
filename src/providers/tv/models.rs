use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Channel {
    pub id: String,
    #[serde(default)]
    pub tvg_id: Option<String>,
    pub name: String,
    pub logo: String,
    pub group: String,
    #[serde(default)]
    pub country: Option<String>,
    pub stream_url: String,
    #[serde(default)]
    pub url: String,
}
