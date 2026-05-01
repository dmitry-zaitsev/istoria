use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

#[derive(Clone, Debug, Serialize)]
pub struct Event {
    pub id: u64,
    /// Unix milliseconds.
    pub ts: i64,
    pub source: String,
    /// Git branch (or folder name fallback) of the producer's cwd at
    /// pipe attach time. Empty string when unknown (HTTP ingest).
    pub branch: String,
    pub level: Level,
    pub msg: String,
    pub raw: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<serde_json::Value>,
}

impl Event {
    pub fn from_plain_line(id: u64, source: &str, raw: String) -> Self {
        let ts = now_unix_ms();
        let msg = raw.clone();
        Self {
            id,
            ts,
            source: source.to_string(),
            branch: String::new(),
            level: Level::Info,
            msg,
            raw,
            fields: None,
        }
    }
}

fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
