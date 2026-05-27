/// Joins pretty-printed multi-line JSON objects into single lines so
/// the downstream `Detector` sees one record per line. Without this,
/// a paste of `jq`-style output gets split — every newline becomes a
/// separate event, the closing `}` lands as its own row, and the
/// nested-msg unwrap never fires because no line is valid JSON on
/// its own.
///
/// Tracks brace/bracket depth across lines, ignoring chars inside
/// strings. Starts buffering when a line starts (after trim) with
/// `{` or `[` AND ends with positive depth or an open string.
/// Emits the joined buffer when depth returns to 0 with no open
/// string. Bails to per-line emission on cap to avoid runaway
/// buffering on streams that open a brace but never close it.
pub struct JsonLines {
    buf: String,
    depth: i32,
    in_string: bool,
    escape: bool,
    lines: usize,
    max_lines: usize,
    max_bytes: usize,
}

impl JsonLines {
    pub const DEFAULT_MAX_LINES: usize = 500;
    pub const DEFAULT_MAX_BYTES: usize = 256 * 1024;

    pub fn new() -> Self {
        Self {
            buf: String::new(),
            depth: 0,
            in_string: false,
            escape: false,
            lines: 0,
            max_lines: Self::DEFAULT_MAX_LINES,
            max_bytes: Self::DEFAULT_MAX_BYTES,
        }
    }

    pub fn has_pending(&self) -> bool {
        !self.buf.is_empty()
    }

    /// Push one input line. Returns 0+ lines ready for downstream
    /// parsing (Vec because the cap path flushes buffered content as
    /// separate lines to avoid loss).
    pub fn push(&mut self, line: String) -> Vec<String> {
        if !self.has_pending() {
            let trimmed = line.trim_start();
            if !(trimmed.starts_with('{') || trimmed.starts_with('[')) {
                return vec![line];
            }
            let (depth, in_string, escape) = scan(&line, 0, false, false);
            if depth <= 0 && !in_string {
                // Balanced (or junk that closes more than opens) on
                // this single line — let the Detector handle it.
                return vec![line];
            }
            self.buf = line;
            self.depth = depth;
            self.in_string = in_string;
            self.escape = escape;
            self.lines = 1;
            return vec![];
        }

        self.buf.push('\n');
        self.buf.push_str(&line);
        self.lines += 1;
        let (depth, in_string, escape) =
            scan(&line, self.depth, self.in_string, self.escape);
        self.depth = depth;
        self.in_string = in_string;
        self.escape = escape;

        if self.depth <= 0 && !self.in_string {
            return vec![self.take()];
        }

        if self.lines >= self.max_lines || self.buf.len() >= self.max_bytes {
            return self.flush_unjoined();
        }

        vec![]
    }

    /// EOF / idle flush. Emits the pending buffer as one joined line
    /// (downstream will parse it; if invalid JSON it falls through to
    /// the plain path, so nothing is lost).
    pub fn flush(&mut self) -> Vec<String> {
        if !self.has_pending() {
            return vec![];
        }
        vec![self.take()]
    }

    fn take(&mut self) -> String {
        self.depth = 0;
        self.in_string = false;
        self.escape = false;
        self.lines = 0;
        std::mem::take(&mut self.buf)
    }

    fn flush_unjoined(&mut self) -> Vec<String> {
        let joined = self.take();
        joined.split('\n').map(|s| s.to_string()).collect()
    }
}

impl Default for JsonLines {
    fn default() -> Self {
        Self::new()
    }
}

/// Walk chars updating JSON depth, ignoring `{`/`}`/`[`/`]` inside
/// strings. Returns the carried-over `(depth, in_string, escape)` so
/// callers can resume scanning on the next line.
fn scan(s: &str, mut depth: i32, mut in_string: bool, mut escape: bool) -> (i32, bool, bool) {
    for c in s.chars() {
        if escape {
            escape = false;
            continue;
        }
        if in_string {
            match c {
                '\\' => escape = true,
                '"' => in_string = false,
                _ => {}
            }
        } else {
            match c {
                '"' => in_string = true,
                '{' | '[' => depth += 1,
                '}' | ']' => depth -= 1,
                _ => {}
            }
        }
    }
    (depth, in_string, escape)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn push_all(j: &mut JsonLines, lines: &[&str]) -> Vec<String> {
        let mut out = Vec::new();
        for l in lines {
            out.extend(j.push(l.to_string()));
        }
        out.extend(j.flush());
        out
    }

    #[test]
    fn passes_plain_text_through() {
        let mut j = JsonLines::new();
        let out = push_all(&mut j, &["hello", "world"]);
        assert_eq!(out, vec!["hello", "world"]);
    }

    #[test]
    fn passes_single_line_json_through() {
        let mut j = JsonLines::new();
        let out = push_all(&mut j, &[r#"{"a":1}"#]);
        assert_eq!(out, vec![r#"{"a":1}"#]);
    }

    #[test]
    fn joins_pretty_printed_object() {
        let mut j = JsonLines::new();
        let out = push_all(
            &mut j,
            &[
                "{",
                r#"  "ts": 1779913937989,"#,
                r#"  "msg": "hello""#,
                "}",
            ],
        );
        assert_eq!(out.len(), 1);
        assert!(serde_json::from_str::<serde_json::Value>(&out[0]).is_ok());
        assert!(out[0].contains("1779913937989"));
    }

    #[test]
    fn user_reported_payload_joins_to_one_line() {
        // Exact shape from the bug report: pretty-printed outer
        // object with a stringified inner payload in `body`. Must
        // emerge as a single line so the Detector can parse it and
        // the nested-msg unwrap can flatten `body`.
        let mut j = JsonLines::new();
        let out = push_all(
            &mut j,
            &[
                "{",
                r#"  "ts": 1779913937989,"#,
                r#"  "level": "DEBUG","#,
                r#"  "source": "pipe-1","#,
                r#"  "msg": "sidecar.query_msg","#,
                r#"  "body": "{\"ts\":\"2026-05-27T20:32:17.989Z\",\"src\":\"sidecar\",\"level\":\"debug\",\"event\":\"sidecar.query_msg\",\"id\":\"a9b66dab-2ad7-441e-baeb-9f8a7226cb2e\",\"seq\":5,\"type\":\"system\",\"subtype\":\"init\",\"model\":\"claude-haiku-4-5\",\"session_id\":\"1ad78c65-c266-45b4-83cb-c0dfbf6002d6\",\"tools\":44}","#,
                r#"  "event": "sidecar.query_msg","#,
                r#"  "message": "sidecar.query_msg","#,
                r#"  "target": "sidecar","#,
                r#"  "timestamp": "2026-05-27T20:32:17.989308Z""#,
                "}",
            ],
        );
        assert_eq!(out.len(), 1);
        let v: serde_json::Value =
            serde_json::from_str(&out[0]).expect("joined output parses as JSON");
        assert_eq!(
            v.get("source").and_then(|x| x.as_str()),
            Some("pipe-1"),
        );
        assert!(v.get("body").and_then(|x| x.as_str()).is_some());
    }

    #[test]
    fn joins_pretty_printed_array() {
        let mut j = JsonLines::new();
        let out = push_all(&mut j, &["[", "  1,", "  2,", "  3", "]"]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0], "[\n  1,\n  2,\n  3\n]");
    }

    #[test]
    fn braces_inside_strings_do_not_close_depth() {
        // The `{` and `}` inside the string value must not be counted.
        // If they were, depth would return to 0 on line 1 and the
        // closing brace would be a separate event.
        let mut j = JsonLines::new();
        let out = push_all(
            &mut j,
            &[
                "{",
                r#"  "k": "has { and } inside","#,
                r#"  "n": 1"#,
                "}",
            ],
        );
        assert_eq!(out.len(), 1);
        let v: serde_json::Value = serde_json::from_str(&out[0]).unwrap();
        assert_eq!(v.get("n").and_then(|x| x.as_i64()), Some(1));
    }

    #[test]
    fn escaped_quote_inside_string_does_not_close_string() {
        let mut j = JsonLines::new();
        let out = push_all(
            &mut j,
            &[
                "{",
                r#"  "k": "say \"hi\" {fake}","#,
                r#"  "n": 1"#,
                "}",
            ],
        );
        assert_eq!(out.len(), 1);
        let v: serde_json::Value = serde_json::from_str(&out[0]).unwrap();
        assert_eq!(v.get("k").and_then(|x| x.as_str()), Some(r#"say "hi" {fake}"#));
    }

    #[test]
    fn ndjson_emits_each_line_unchanged() {
        // Each line is a complete JSON object on its own — should
        // pass through without buffering.
        let mut j = JsonLines::new();
        let out = push_all(
            &mut j,
            &[r#"{"a":1}"#, r#"{"a":2}"#, r#"{"a":3}"#],
        );
        assert_eq!(out, vec![r#"{"a":1}"#, r#"{"a":2}"#, r#"{"a":3}"#]);
    }

    #[test]
    fn unrelated_line_starting_with_brace_passes_through() {
        // Bash-style `{ foo; }` block dump — closes on the same line.
        let mut j = JsonLines::new();
        let out = push_all(&mut j, &["{ echo hi; }"]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0], "{ echo hi; }");
    }

    #[test]
    fn cap_flushes_unjoined_to_avoid_runaway() {
        let mut j = JsonLines {
            buf: String::new(),
            depth: 0,
            in_string: false,
            escape: false,
            lines: 0,
            max_lines: 3,
            max_bytes: JsonLines::DEFAULT_MAX_BYTES,
        };
        // Open brace, then 3 more lines that don't close. After the
        // 3rd added line (4th total), cap hits and we flush as
        // separate lines so the user still sees the content.
        let out = push_all(&mut j, &["{", "  a", "  b", "  c"]);
        // After cap flush no pending remains; flush() returns nothing.
        assert_eq!(out.len(), 4);
        assert_eq!(out[0], "{");
        assert_eq!(out[3], "  c");
    }

    #[test]
    fn flush_emits_partial_on_eof() {
        let mut j = JsonLines::new();
        let mut out = j.push("{".to_string());
        assert!(out.is_empty());
        out.extend(j.flush());
        // Joined buffer is just `{` — Detector will treat as plain.
        assert_eq!(out, vec!["{"]);
    }

    #[test]
    fn nested_braces_track_depth() {
        let mut j = JsonLines::new();
        let out = push_all(
            &mut j,
            &[
                "{",
                r#"  "inner": {"#,
                r#"    "x": 1"#,
                "  }",
                "}",
            ],
        );
        assert_eq!(out.len(), 1);
        let v: serde_json::Value = serde_json::from_str(&out[0]).unwrap();
        assert_eq!(
            v.get("inner")
                .and_then(|x| x.as_object())
                .and_then(|o| o.get("x"))
                .and_then(|x| x.as_i64()),
            Some(1),
        );
    }
}
