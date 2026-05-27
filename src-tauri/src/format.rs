use std::sync::LazyLock;

use regex::Regex;
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

    pub fn parse(&mut self, id: u64, source: &str, branch: &str, raw: String) -> Event {
        // Always attempt JSON extraction. The lock is sticky for the
        // diagnostic log line (`ingest.rs`), but does *not* gate per-line
        // parsing — otherwise a stream that opens with non-JSON noise
        // (startup banners, build prelude) locks Plain and silently
        // drops all later bracket-tagged JSON into the plain path,
        // burying inner pino keys inside `msg`. `serde_json::from_str`
        // short-circuits on the first non-JSON byte, so per-line cost
        // on plain streams is negligible.
        let parsed: Option<(Option<String>, Value)> = try_object_from_raw(&raw);

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
            Some((tag, v)) => event_from_json(id, source, branch, raw, v, tag.as_deref()),
            None => event_from_plain(id, source, branch, raw),
        }
    }
}

impl Default for Detector {
    fn default() -> Self {
        Self::new()
    }
}

fn event_from_json(
    id: u64,
    source: &str,
    branch: &str,
    raw: String,
    v: Value,
    tag: Option<&str>,
) -> Event {
    // Double-piped logs: when `msg` itself parses as a JSON object,
    // a wrapping tool stringified an inner structured log (pino,
    // bunyan, etc). Merge inner keys up so `pid`, `reqId`, `hostname`
    // are queryable instead of buried in a string. Inner wins on
    // conflicting keys — it's the canonical payload; outer is just
    // transport.
    let mut v = unwrap_nested_msg_json(v);
    if let (Some(t), Some(obj)) = (tag, v.as_object_mut()) {
        // Bracket prefix tag from `[be] {json}` style lines. Don't
        // clobber if inner JSON already carries a `tag` — inner is
        // canonical.
        obj.entry("tag".to_string())
            .or_insert(Value::String(t.to_string()));
    }
    let obj = v.as_object().expect("filtered to objects above");
    // Try common string-level keys first, then fall back to numeric
    // (Bunyan/Pino encode level as 10/20/30/40/50/60).
    let explicit_level = ["level", "lvl", "severity", "severity_text", "levelname", "loglevel", "log_level"]
        .iter()
        .find_map(|k| obj.get(*k))
        .and_then(|x| {
            if let Some(s) = x.as_str() {
                Some(parse_level_str(s))
            } else if let Some(n) = x.as_i64() {
                Some(parse_level_num(n))
            } else {
                x.as_f64().map(|n| parse_level_num(n as i64))
            }
        });
    let msg = obj
        .get("msg")
        .or_else(|| obj.get("message"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    // Fall back to msg-based heuristics for structured logs that
    // didn't ship a level field. Also *upgrade* an explicit `info`
    // when the msg contains stronger keywords — common with
    // double-piped logs (e.g. one producer wraps another's output as
    // JSON and tags everything `info` because the original line
    // didn't match its level rules).
    let level = match explicit_level {
        Some(Level::Info) | None => infer_level_keyword(&msg).unwrap_or(Level::Info),
        Some(other) => other,
    };
    Event {
        id,
        ts: now_unix_ms(),
        source: source.to_string(),
        branch: branch.to_string(),
        level,
        msg,
        raw,
        fields: Some(v),
    }
}

/// Try to extract a JSON object from a raw line. Handles:
///   - Pure JSON: `{"level":...}`
///   - Bracket-tagged: `[be] {"level":...}` — common when one tool
///     prefixes another's JSON output to distinguish streams (pm2-
///     style multiplexers, ad-hoc `[be]`/`[fe]` wrappers). Without
///     this, sniffing fails on the `[` and the whole stream locks to
///     plain, burying every structured field inside `msg` as a string.
/// The returned tag (when present) is added to fields downstream.
fn try_object_from_raw(raw: &str) -> Option<(Option<String>, Value)> {
    if let Ok(v) = serde_json::from_str::<Value>(raw) {
        if v.is_object() {
            return Some((None, v));
        }
    }
    let s = raw.trim_start();
    let rest = s.strip_prefix('[')?;
    let end = rest.find(']')?;
    let tag = rest[..end].trim();
    if tag.is_empty() {
        return None;
    }
    let after = rest[end + 1..].trim_start();
    if !after.starts_with('{') {
        return None;
    }
    let v = serde_json::from_str::<Value>(after).ok()?;
    if !v.is_object() {
        return None;
    }
    Some((Some(tag.to_string()), v))
}

/// If the outer object carries a string field that itself parses as a
/// JSON object, return a new object with the inner keys merged in.
/// Inner keys overwrite outer ones on conflict. Checks `msg`,
/// `message`, then `body` — covers double-piped pino (msg/message) and
/// sidecar-style wrappers that quote the canonical payload into `body`.
/// Falls back to the input untouched when no nested JSON is found.
fn unwrap_nested_msg_json(v: Value) -> Value {
    let Some(outer) = v.as_object() else { return v };
    let inner_map = ["msg", "message", "body"].iter().find_map(|k| {
        let s = outer.get(*k)?.as_str()?;
        let inner = serde_json::from_str::<Value>(s).ok()?;
        inner.as_object().cloned()
    });
    let Some(inner_map) = inner_map else { return v };
    let mut merged = outer.clone();
    for (k, val) in inner_map {
        merged.insert(k, val);
    }
    Value::Object(merged)
}

fn event_from_plain(id: u64, source: &str, branch: &str, raw: String) -> Event {
    let stripped = strip_ansi(&raw);
    // Keyword first; ANSI color is the fallback signal so that an
    // explicit `INFO` line stays Info even if a timestamp prefix is
    // colored. Only when no keyword matches does the color drive
    // the verdict (red→Error, yellow→Warn). Run keyword detection on
    // the *full* stripped text so a head like "INFO: ..." followed by
    // an indented "    error: ..." block can still be promoted.
    let level = infer_level_keyword(&stripped)
        .or_else(|| detect_ansi_level(&raw))
        .unwrap_or(Level::Info);
    // `msg` is the row-level summary; coalesced groups carry the
    // continuation text in `raw` and the Inspector's Raw tab. Keep
    // `msg` to the first line so the stream view doesn't render a
    // half-frame of stack trace.
    let msg = first_line(&stripped);
    Event {
        id,
        ts: now_unix_ms(),
        source: source.to_string(),
        branch: branch.to_string(),
        level,
        msg,
        raw,
        fields: None,
    }
}

fn first_line(s: &str) -> String {
    match s.find('\n') {
        Some(i) => s[..i].trim_end_matches('\r').to_string(),
        None => s.to_string(),
    }
}

fn parse_level_str(s: &str) -> Level {
    let lc = s.to_ascii_lowercase();
    match lc.as_str() {
        "error" | "err" | "e" | "fatal" | "f" | "panic" | "crit" | "critical" | "alert"
        | "emerg" | "emergency" => Level::Error,
        "warn" | "warning" | "w" => Level::Warn,
        "info" | "notice" | "i" => Level::Info,
        "debug" | "dbg" | "d" => Level::Debug,
        "trace" | "verbose" | "v" => Level::Trace,
        _ => {
            // Numeric strings like "30" (Bunyan/Pino).
            if let Ok(n) = lc.parse::<i64>() {
                parse_level_num(n)
            } else {
                Level::Info
            }
        }
    }
}

/// Map Bunyan/Pino-style numeric levels onto our enum. Buckets:
/// <=15 trace, <=25 debug, <=35 info, <=45 warn, >45 error.
fn parse_level_num(n: i64) -> Level {
    if n <= 15 {
        Level::Trace
    } else if n <= 25 {
        Level::Debug
    } else if n <= 35 {
        Level::Info
    } else if n <= 45 {
        Level::Warn
    } else {
        Level::Error
    }
}

// Patterns match keywords case-insensitively, bounded so the keyword
// can't be part of an identifier or path component. The bounding
// excludes word chars *and* `-`, `.`, `/`, `\` — Rust regex `\b`
// alone treats hyphens as boundaries, which produces false positives
// on package names (`@linear/error-pages`), filenames
// (`restart-on-crash.sh`), and CLI flags (`--kill-others-on-fail`).
fn level_keyword_re(keywords: &str) -> Regex {
    // (^ | non-id) keywords (non-id | $)  —  case-insensitive.
    let pat = format!(r"(?i)(?:^|[^A-Za-z0-9_./\\-])(?:{keywords})(?:[^A-Za-z0-9_./\\-]|$)");
    Regex::new(&pat).expect("level regex")
}

static ERROR_RE: LazyLock<Regex> = LazyLock::new(|| {
    level_keyword_re(
        r"error|err|fatal|critical|crit|panic(?:ked)?|exception|traceback|unhandled|uncaught|emerg(?:ency)?|alert|fail(?:ed|ure)?|crash(?:ed)?|aborted",
    )
});
static WARN_RE: LazyLock<Regex> =
    LazyLock::new(|| level_keyword_re(r"warn(?:ing)?|deprecat\w*"));
static DEBUG_RE: LazyLock<Regex> = LazyLock::new(|| level_keyword_re(r"debug"));
static TRACE_RE: LazyLock<Regex> = LazyLock::new(|| level_keyword_re(r"trace|verbose"));
static INFO_RE: LazyLock<Regex> = LazyLock::new(|| level_keyword_re(r"info|notice"));

// Match SGR sequences carrying a foreground red (31, 91) or yellow
// (33, 93) color code. Other params (bold, bg) may surround it.
static ANSI_RED_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\[(?:\d+;)*(?:31|91)(?:;\d+)*m").expect("ansi red regex"));
static ANSI_YELLOW_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\x1b\[(?:\d+;)*(?:33|93)(?:;\d+)*m").expect("ansi yellow regex")
});

fn infer_level_keyword(s: &str) -> Option<Level> {
    if ERROR_RE.is_match(s) {
        Some(Level::Error)
    } else if WARN_RE.is_match(s) {
        Some(Level::Warn)
    } else if DEBUG_RE.is_match(s) {
        Some(Level::Debug)
    } else if TRACE_RE.is_match(s) {
        Some(Level::Trace)
    } else if INFO_RE.is_match(s) {
        Some(Level::Info)
    } else {
        None
    }
}

/// Infer level from terminal color codes in the raw line. Many CLIs
/// (npm, cargo, eslint) print a colored level marker but no textual
/// keyword — so once keyword matching whiffs, color is the next-best
/// signal. Red wins over yellow if both appear.
fn detect_ansi_level(raw: &str) -> Option<Level> {
    if ANSI_RED_RE.is_match(raw) {
        Some(Level::Error)
    } else if ANSI_YELLOW_RE.is_match(raw) {
        Some(Level::Warn)
    } else {
        None
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
            d.parse(i as u64, "test", "main",raw);
        }
        assert_eq!(d.locked_format(), Some(LineFormat::Json));
    }

    #[test]
    fn detector_locks_on_plain_when_majority_unparseable() {
        let mut d = Detector::new();
        for i in 0..SNIFF_WINDOW {
            d.parse(i as u64, "test", "main",format!("plain line {i}"));
        }
        assert_eq!(d.locked_format(), Some(LineFormat::Plain));
    }

    #[test]
    fn malformed_json_falls_back_to_plain_event() {
        let mut d = Detector::new();
        let ev = d.parse(1, "src", "main","{not valid".to_string());
        assert!(ev.fields.is_none());
        assert_eq!(ev.msg, "{not valid");
    }

    #[test]
    fn json_extracts_msg_and_level() {
        let mut d = Detector::new();
        let ev = d.parse(1, "src", "main",r#"{"level":"error","msg":"boom"}"#.to_string());
        assert_eq!(ev.level, Level::Error);
        assert_eq!(ev.msg, "boom");
        assert!(ev.fields.is_some());
    }

    #[test]
    fn plain_level_substring_match() {
        let mut d = Detector::new();
        let ev = d.parse(1, "src", "main","2026-04-25 ERROR: db down".to_string());
        assert_eq!(ev.level, Level::Error);
        let ev = d.parse(2, "src", "main","WARN flaky".to_string());
        assert_eq!(ev.level, Level::Warn);
        let ev = d.parse(3, "src", "main","DEBUG details".to_string());
        assert_eq!(ev.level, Level::Debug);
        let ev = d.parse(4, "src", "main","no markers here".to_string());
        assert_eq!(ev.level, Level::Info);
    }

    #[test]
    fn plain_level_catches_exception_keywords() {
        let cases = [
            // Java
            ("Exception in thread \"main\" java.lang.NullPointerException", Level::Error),
            // Python
            ("Traceback (most recent call last):", Level::Error),
            // Go
            ("panic: runtime error: index out of range", Level::Error),
            // Rust
            ("thread 'main' panicked at 'oh no'", Level::Error),
            // Node
            ("UnhandledPromiseRejectionWarning: Error: nope", Level::Error),
            ("Uncaught TypeError: foo is undefined", Level::Error),
            // syslog severities
            ("FATAL: out of memory", Level::Error),
            ("CRITICAL system overload", Level::Error),
            // mixed case + bracket forms
            ("[error] db unreachable", Level::Error),
            ("server returned err: timeout", Level::Error),
            // npm/pnpm exit + "failed" / "crashed" idioms reported in DEE-104
            (" ELIFECYCLE  Command failed with exit code 1.", Level::Error),
            ("Process crashed with exit code 1. Restarting in 1 second...", Level::Error),
            ("Build aborted after 2 errors", Level::Error),
        ];
        for (line, want) in cases {
            let mut d = Detector::new();
            let ev = d.parse(1, "src", "main",line.to_string());
            assert_eq!(ev.level, want, "line: {line}");
        }
    }

    #[test]
    fn plain_level_uses_ansi_color_when_no_keyword() {
        // Red without any level keyword → Error.
        let mut d = Detector::new();
        let ev = d.parse(1, "src", "main","\x1b[31msomething went sideways\x1b[0m".to_string());
        assert_eq!(ev.level, Level::Error);
        // Bright red also counts.
        let mut d = Detector::new();
        let ev = d.parse(2, "src", "main","\x1b[91mboom\x1b[0m".to_string());
        assert_eq!(ev.level, Level::Error);
        // Yellow → Warn.
        let mut d = Detector::new();
        let ev = d.parse(3, "src", "main","\x1b[33mheads up\x1b[0m".to_string());
        assert_eq!(ev.level, Level::Warn);
        // Bold + color (\x1b[1;31m) still detected.
        let mut d = Detector::new();
        let ev = d.parse(4, "src", "main","\x1b[1;31mcompile failure\x1b[0m foo".to_string());
        assert_eq!(ev.level, Level::Error);
    }

    #[test]
    fn plain_level_keyword_beats_color() {
        // INFO keyword + colored timestamp prefix — keyword wins so
        // tools that color noise (timestamps, source tags) don't
        // poison the level.
        let mut d = Detector::new();
        let ev = d.parse(
            1,
            "src",
            "main",
            "\x1b[33m[12:00:00]\x1b[0m INFO startup complete".to_string(),
        );
        assert_eq!(ev.level, Level::Info);
    }

    #[test]
    fn json_info_upgraded_when_msg_signals_error() {
        // Double-piped logs: outer wrapper says level=info, but the
        // inner msg has "Error:" — upgrade to Error.
        let mut d = Detector::new();
        let ev = d.parse(
            1,
            "src",
            "main",
            r#"{"level":"info","msg":"@linear/client:start-client: Error: Port 8080 is already in use"}"#
                .to_string(),
        );
        assert_eq!(ev.level, Level::Error);
        // Same for "failed" idiom.
        let mut d = Detector::new();
        let ev = d.parse(
            2,
            "src",
            "main",
            r#"{"level":"info","msg":" ELIFECYCLE  Command failed with exit code 1."}"#.to_string(),
        );
        assert_eq!(ev.level, Level::Error);
    }

    #[test]
    fn json_explicit_non_info_is_trusted() {
        // Don't downgrade an explicit warn just because msg has no
        // keyword, and don't upgrade a debug/warn even if msg has
        // "error" in it — the producer made an explicit choice.
        let mut d = Detector::new();
        let ev = d.parse(1, "src", "main",r#"{"level":"warn","msg":"slowness"}"#.to_string());
        assert_eq!(ev.level, Level::Warn);
        let mut d = Detector::new();
        let ev = d.parse(
            2,
            "src",
            "main",
            r#"{"level":"debug","msg":"Error count: 0"}"#.to_string(),
        );
        assert_eq!(ev.level, Level::Debug);
    }

    #[test]
    fn plain_level_catches_warn_variants() {
        let cases = [
            ("warning: deprecated API", Level::Warn),
            ("[warn] retrying", Level::Warn),
            ("DeprecationWarning: foo", Level::Warn),
        ];
        for (line, want) in cases {
            let mut d = Detector::new();
            let ev = d.parse(1, "src", "main",line.to_string());
            assert_eq!(ev.level, want, "line: {line}");
        }
    }

    #[test]
    fn plain_level_does_not_match_keywords_inside_paths_or_flags() {
        // Real samples reported on DEE-104 — keywords appear inside
        // package names, filenames, and CLI flag names. Lines must
        // stay Info; identifier components are not error signals.
        let cases = [
            "> bash tools/restart-on-crash.sh pnpm start",
            "> rm -rf ./build-dev && pnpm start-db && concurrently -r --kill-others-on-fail \"pnpm watch-dev\"",
            "• Packages in scope: @linear/error-pages, @linear/api, @linear/client",
            "Loading ./error-boundary.tsx",
            "writing node_modules/failure-tracker/index.js",
            "Compiling crash-handler v0.1.0",
        ];
        for line in cases {
            let mut d = Detector::new();
            let ev = d.parse(1, "src", "main",line.to_string());
            assert_eq!(ev.level, Level::Info, "line should not be Error: {line}");
        }
    }

    #[test]
    fn plain_level_word_boundary_avoids_false_positives() {
        // "errors" is plural — `\berror\b` doesn't match, so a clean
        // "0 errors" build summary doesn't get tagged red.
        let mut d = Detector::new();
        let ev = d.parse(1, "src", "main","build complete: 0 errors".to_string());
        assert_eq!(ev.level, Level::Info);
        // "informational" must not trip `\binfo\b` (no other markers,
        // so it lands on the default Info anyway — kept here so a
        // future change to the default doesn't silently swallow this).
        let mut d = Detector::new();
        let ev = d.parse(2, "src", "main","Terraform: 0 added, 0 changed.".to_string());
        assert_eq!(ev.level, Level::Info);
    }

    #[test]
    fn json_level_alias_keys() {
        let mut d = Detector::new();
        // Python logging
        let ev = d.parse(
            1,
            "src",
            "main",
            r#"{"levelname":"ERROR","message":"boom"}"#.to_string(),
        );
        assert_eq!(ev.level, Level::Error);
        // Generic loglevel key
        let mut d = Detector::new();
        let ev = d.parse(2, "src", "main",r#"{"loglevel":"warn","msg":"x"}"#.to_string());
        assert_eq!(ev.level, Level::Warn);
    }

    #[test]
    fn json_falls_back_to_msg_heuristic_when_no_level() {
        let mut d = Detector::new();
        let ev = d.parse(
            1,
            "src",
            "main",
            r#"{"msg":"Exception in thread main"}"#.to_string(),
        );
        assert_eq!(ev.level, Level::Error);
    }

    #[test]
    fn plain_multiline_msg_is_first_line() {
        let mut d = Detector::new();
        let raw = "INFO: task running\n    Exception: boom\n    at foo".to_string();
        let ev = d.parse(1, "src", "main", raw);
        // First line drives the row-level msg; continuations live in raw.
        assert_eq!(ev.msg, "INFO: task running");
        assert!(ev.raw.contains("Exception"));
        // Level is inferred from full stripped text — `Exception`
        // upgrades the head-level `INFO` to Error.
        assert_eq!(ev.level, Level::Error);
    }

    #[test]
    fn json_nested_msg_flattens_inner_keys() {
        // Double-piped: outer wrapper stringified an inner pino log.
        // Inner keys (pid, hostname, reqId, req) should appear at the
        // top level of fields so they're queryable.
        let mut d = Detector::new();
        let raw = r#"{"id":50,"ts":1777853046862,"source":"pipe-1","level":"info","msg":"{\"level\":30,\"time\":1777853046861,\"pid\":7167,\"hostname\":\"macbookpro.lan\",\"reqId\":\"req-3\",\"req\":{\"method\":\"POST\",\"url\":\"/run/new\"},\"msg\":\"incoming request\"}"}"#;
        let ev = d.parse(1, "src", "main", raw.to_string());
        assert_eq!(ev.msg, "incoming request");
        let fields = ev.fields.expect("fields set");
        let obj = fields.as_object().expect("object");
        assert_eq!(obj.get("pid").and_then(|v| v.as_i64()), Some(7167));
        assert_eq!(obj.get("hostname").and_then(|v| v.as_str()), Some("macbookpro.lan"));
        assert_eq!(obj.get("reqId").and_then(|v| v.as_str()), Some("req-3"));
        assert_eq!(
            obj.get("req")
                .and_then(|v| v.as_object())
                .and_then(|o| o.get("method"))
                .and_then(|v| v.as_str()),
            Some("POST"),
        );
        // Outer keys preserved when not overridden.
        assert_eq!(obj.get("source").and_then(|v| v.as_str()), Some("pipe-1"));
    }

    #[test]
    fn json_nested_body_flattens_inner_keys() {
        // Sidecar-style wrapper: outer carries a short tag in `msg`
        // and the canonical structured payload stringified in `body`.
        // Inner keys (id, seq, type, subtype, model, session_id, tools)
        // should land at the top level so they're queryable as facets.
        let mut d = Detector::new();
        let raw = r#"{"ts":1779913937989,"level":"DEBUG","source":"pipe-1","msg":"sidecar.query_msg","body":"{\"ts\":\"2026-05-27T20:32:17.989Z\",\"src\":\"sidecar\",\"level\":\"debug\",\"event\":\"sidecar.query_msg\",\"id\":\"a9b66dab-2ad7-441e-baeb-9f8a7226cb2e\",\"seq\":5,\"type\":\"system\",\"subtype\":\"init\",\"model\":\"claude-haiku-4-5\",\"session_id\":\"1ad78c65-c266-45b4-83cb-c0dfbf6002d6\",\"tools\":44}","event":"sidecar.query_msg","message":"sidecar.query_msg","target":"sidecar","timestamp":"2026-05-27T20:32:17.989308Z"}"#;
        let ev = d.parse(1, "src", "main", raw.to_string());
        // Outer msg stays — it's a tag, not the inner payload.
        assert_eq!(ev.msg, "sidecar.query_msg");
        let fields = ev.fields.expect("fields set");
        let obj = fields.as_object().expect("object");
        assert_eq!(
            obj.get("id").and_then(|v| v.as_str()),
            Some("a9b66dab-2ad7-441e-baeb-9f8a7226cb2e"),
        );
        assert_eq!(obj.get("seq").and_then(|v| v.as_i64()), Some(5));
        assert_eq!(obj.get("type").and_then(|v| v.as_str()), Some("system"));
        assert_eq!(obj.get("subtype").and_then(|v| v.as_str()), Some("init"));
        assert_eq!(
            obj.get("model").and_then(|v| v.as_str()),
            Some("claude-haiku-4-5"),
        );
        assert_eq!(
            obj.get("session_id").and_then(|v| v.as_str()),
            Some("1ad78c65-c266-45b4-83cb-c0dfbf6002d6"),
        );
        assert_eq!(obj.get("tools").and_then(|v| v.as_i64()), Some(44));
    }

    #[test]
    fn json_nested_msg_wins_over_body() {
        // When both msg and body contain stringified JSON, msg wins —
        // it's the more common double-pipe shape. body is fallback only.
        let mut d = Detector::new();
        let raw = r#"{"msg":"{\"from\":\"msg\"}","body":"{\"from\":\"body\"}"}"#;
        let ev = d.parse(1, "src", "main", raw.to_string());
        let obj = ev.fields.unwrap();
        let obj = obj.as_object().unwrap();
        assert_eq!(obj.get("from").and_then(|v| v.as_str()), Some("msg"));
    }

    #[test]
    fn json_nested_msg_inner_level_wins() {
        // Outer says info (transport default), inner says 50 (pino
        // error). Trust the inner — it's the real signal.
        let mut d = Detector::new();
        let raw = r#"{"level":"info","msg":"{\"level\":50,\"msg\":\"db down\"}"}"#;
        let ev = d.parse(1, "src", "main", raw.to_string());
        assert_eq!(ev.level, Level::Error);
        assert_eq!(ev.msg, "db down");
    }

    #[test]
    fn json_msg_not_json_left_alone() {
        // Plain string msg — no nested parse attempt should change
        // anything.
        let mut d = Detector::new();
        let ev = d.parse(1, "src", "main", r#"{"level":"warn","msg":"slow query"}"#.to_string());
        assert_eq!(ev.msg, "slow query");
        assert_eq!(ev.level, Level::Warn);
    }

    #[test]
    fn bracket_tagged_json_unwraps_and_carries_tag() {
        // `[be] {json}` form — bracket prefix used by multiplexers
        // (e.g. one tool piping backend+frontend into one stream).
        // Without unwrapping, the sniffer locks plain and every
        // structured key is buried inside msg.
        let mut d = Detector::new();
        let raw = r#"[be] {"level":30,"time":1779024878883,"pid":52415,"hostname":"macbookpro.lan","reqId":"req-f","res":{"statusCode":200},"responseTime":0.37,"msg":"request completed"}"#;
        let ev = d.parse(1, "src", "main", raw.to_string());
        assert_eq!(ev.msg, "request completed");
        assert_eq!(ev.level, Level::Info);
        let fields = ev.fields.expect("fields set");
        let obj = fields.as_object().expect("object");
        assert_eq!(obj.get("tag").and_then(|v| v.as_str()), Some("be"));
        assert_eq!(obj.get("pid").and_then(|v| v.as_i64()), Some(52415));
        assert_eq!(obj.get("reqId").and_then(|v| v.as_str()), Some("req-f"));
        assert_eq!(
            obj.get("res")
                .and_then(|v| v.as_object())
                .and_then(|o| o.get("statusCode"))
                .and_then(|v| v.as_i64()),
            Some(200),
        );
    }

    #[test]
    fn bracket_tagged_json_unwraps_even_after_plain_lock() {
        // Real-world stream: 20 lines of plain startup banner lock the
        // detector to Plain, then bracket-tagged pino JSON arrives.
        // Without per-line JSON attempts, every later `[be] {...}` line
        // hits event_from_plain and the inner pino fields stay buried
        // in msg as a string. Regression test for the user's case.
        let mut d = Detector::new();
        for i in 0..SNIFF_WINDOW {
            d.parse(i as u64, "src", "main", format!("plain banner {i}"));
        }
        assert_eq!(d.locked_format(), Some(LineFormat::Plain));
        let raw = r#"[be] {"level":30,"pid":7138,"reqId":"req-1","msg":"incoming request"}"#;
        let ev = d.parse(99, "src", "main", raw.to_string());
        assert_eq!(ev.msg, "incoming request");
        assert_eq!(ev.level, Level::Info);
        let fields = ev.fields.expect("fields set");
        let obj = fields.as_object().expect("object");
        assert_eq!(obj.get("pid").and_then(|v| v.as_i64()), Some(7138));
        assert_eq!(obj.get("reqId").and_then(|v| v.as_str()), Some("req-1"));
        assert_eq!(obj.get("tag").and_then(|v| v.as_str()), Some("be"));
    }

    #[test]
    fn bracket_tagged_json_inner_tag_wins() {
        // If inner JSON already carries a `tag`, don't clobber it
        // with the bracket prefix.
        let mut d = Detector::new();
        let raw = r#"[be] {"tag":"inner","msg":"hi"}"#;
        let ev = d.parse(1, "src", "main", raw.to_string());
        let obj = ev.fields.unwrap();
        let obj = obj.as_object().unwrap();
        assert_eq!(obj.get("tag").and_then(|v| v.as_str()), Some("inner"));
    }

    #[test]
    fn bracket_prefix_without_json_falls_to_plain() {
        let mut d = Detector::new();
        let ev = d.parse(1, "src", "main", "[be] hello world".to_string());
        // No JSON body — should hit the plain path so the frontend
        // bracket-tag transformer can split the tag from a text body.
        assert!(ev.fields.is_none());
        assert_eq!(ev.msg, "[be] hello world");
    }

    #[test]
    fn bracket_tagged_garbage_after_falls_to_plain() {
        let mut d = Detector::new();
        let ev = d.parse(1, "src", "main", "[be] {not valid".to_string());
        assert!(ev.fields.is_none());
    }

    #[test]
    fn json_numeric_bunyan_levels() {
        let mut d = Detector::new();
        let ev = d.parse(1, "src", "main",r#"{"level":50,"msg":"oops"}"#.to_string());
        assert_eq!(ev.level, Level::Error);
        let mut d = Detector::new();
        let ev = d.parse(2, "src", "main",r#"{"level":40,"msg":"meh"}"#.to_string());
        assert_eq!(ev.level, Level::Warn);
        let mut d = Detector::new();
        let ev = d.parse(3, "src", "main",r#"{"level":30,"msg":"hi"}"#.to_string());
        assert_eq!(ev.level, Level::Info);
        let mut d = Detector::new();
        let ev = d.parse(4, "src", "main",r#"{"level":20,"msg":"trace"}"#.to_string());
        assert_eq!(ev.level, Level::Debug);
        let mut d = Detector::new();
        let ev = d.parse(5, "src", "main",r#"{"level":10,"msg":"trace"}"#.to_string());
        assert_eq!(ev.level, Level::Trace);
    }
}
