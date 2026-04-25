use serde_json::Value;

use crate::event::{Event, Level};

const SNIFF_WINDOW: usize = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineFormat {
    Json,
    Plain,
}

/// Per-source format detector. Stays in `Sniffing` for the first
/// ~20 lines, then locks onto the dominant format. Once locked,
/// the choice is sticky — no re-detection mid-stream — but
/// malformed JSON within a JSON-locked source falls back to plain
/// per the acceptance criteria.
pub struct Detector {
    seen: usize,
    json_ok: usize,
    locked: Option<LineFormat>,
}

impl Detector {
    pub fn new() -> Self {
        Self { seen: 0, json_ok: 0, locked: None }
    }

    pub fn locked_format(&self) -> Option<LineFormat> {
        self.locked
    }

    pub fn parse(&mut self, id: u64, source: &str, raw: String) -> Event {
        let try_json = !matches!(self.locked, Some(LineFormat::Plain));
        let parsed: Option<Value> = if try_json {
            serde_json::from_str(&raw).ok().filter(|v| v.is_object())
        } else {
            None
        };

        if self.locked.is_none() {
            self.seen += 1;
            if parsed.is_some() {
                self.json_ok += 1;
            }
            if self.seen >= SNIFF_WINDOW {
                self.locked = Some(if self.json_ok * 2 >= self.seen {
                    LineFormat::Json
                } else {
                    LineFormat::Plain
                });
            }
        }

        match parsed {
            Some(v) => event_from_json(id, source, raw, v),
            None => event_from_plain(id, source, raw),
        }
    }
}

impl Default for Detector {
    fn default() -> Self {
        Self::new()
    }
}

fn event_from_json(id: u64, source: &str, raw: String, v: Value) -> Event {
    let obj = v.as_object().expect("filtered to objects above");
    let level = obj
        .get("level")
        .or_else(|| obj.get("lvl"))
        .or_else(|| obj.get("severity"))
        .and_then(|x| x.as_str())
        .map(parse_level_str)
        .unwrap_or(Level::Info);
    let msg = obj
        .get("msg")
        .or_else(|| obj.get("message"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    Event {
        id,
        ts: now_unix_ms(),
        source: source.to_string(),
        level,
        msg,
        raw,
        fields: Some(v),
    }
}

fn event_from_plain(id: u64, source: &str, raw: String) -> Event {
    let stripped = strip_ansi(&raw);
    let level = infer_level_substring(&stripped);
    Event {
        id,
        ts: now_unix_ms(),
        source: source.to_string(),
        level,
        msg: stripped,
        raw,
        fields: None,
    }
}

fn parse_level_str(s: &str) -> Level {
    match s.to_ascii_lowercase().as_str() {
        "error" | "err" | "fatal" | "panic" | "crit" | "critical" => Level::Error,
        "warn" | "warning" => Level::Warn,
        "info" | "notice" => Level::Info,
        "debug" | "dbg" => Level::Debug,
        "trace" => Level::Trace,
        _ => Level::Info,
    }
}

fn infer_level_substring(s: &str) -> Level {
    if s.contains("ERROR") || s.contains("error:") {
        Level::Error
    } else if s.contains("WARN") || s.contains("warn:") {
        Level::Warn
    } else if s.contains("DEBUG") {
        Level::Debug
    } else if s.contains("INFO") {
        Level::Info
    } else {
        Level::Info
    }
}

/// Strip CSI escape sequences (`ESC [ … final-byte`) and the
/// shorter `ESC X` pair. Preserves all other bytes verbatim.
pub fn strip_ansi(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b {
            i += 1;
            if i >= bytes.len() {
                break;
            }
            if bytes[i] == b'[' {
                i += 1;
                while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                    i += 1;
                }
                if i < bytes.len() {
                    i += 1;
                }
            } else {
                i += 1;
            }
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_removes_color_codes() {
        let s = "\x1b[31mERROR\x1b[0m boom";
        assert_eq!(strip_ansi(s), "ERROR boom");
    }

    #[test]
    fn detector_locks_on_json_after_window() {
        let mut d = Detector::new();
        for i in 0..SNIFF_WINDOW {
            let raw = format!("{{\"msg\":\"hi {i}\",\"level\":\"info\"}}");
            d.parse(i as u64, "test", raw);
        }
        assert_eq!(d.locked_format(), Some(LineFormat::Json));
    }

    #[test]
    fn detector_locks_on_plain_when_majority_unparseable() {
        let mut d = Detector::new();
        for i in 0..SNIFF_WINDOW {
            d.parse(i as u64, "test", format!("plain line {i}"));
        }
        assert_eq!(d.locked_format(), Some(LineFormat::Plain));
    }

    #[test]
    fn malformed_json_falls_back_to_plain_event() {
        let mut d = Detector::new();
        let ev = d.parse(1, "src", "{not valid".to_string());
        assert!(ev.fields.is_none());
        assert_eq!(ev.msg, "{not valid");
    }

    #[test]
    fn json_extracts_msg_and_level() {
        let mut d = Detector::new();
        let ev = d.parse(1, "src", r#"{"level":"error","msg":"boom"}"#.to_string());
        assert_eq!(ev.level, Level::Error);
        assert_eq!(ev.msg, "boom");
        assert!(ev.fields.is_some());
    }

    #[test]
    fn plain_level_substring_match() {
        let mut d = Detector::new();
        let ev = d.parse(1, "src", "2026-04-25 ERROR: db down".to_string());
        assert_eq!(ev.level, Level::Error);
        let ev = d.parse(2, "src", "WARN flaky".to_string());
        assert_eq!(ev.level, Level::Warn);
        let ev = d.parse(3, "src", "DEBUG details".to_string());
        assert_eq!(ev.level, Level::Debug);
        let ev = d.parse(4, "src", "no markers here".to_string());
        assert_eq!(ev.level, Level::Info);
    }
}
