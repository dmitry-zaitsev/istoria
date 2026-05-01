use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;

use crate::event::{Event, Level};
use crate::transformers::extract_body;

/// Joins indented continuations (stack traces, multi-line plain
/// blocks, JSON-wrapped stack frames) into a single event. Operates
/// on parsed [`Event`]s so the indentation check looks at the
/// rendered `msg` field — that means JSON streams whose `msg` field
/// holds an indented frame (`{"msg":"    at foo"}`) coalesce too,
/// even though the raw line itself starts with `{`.
///
/// Stateful: keeps one pending head [`Event`]. For each incoming
/// event, if `msg` starts with whitespace AND there is a pending head,
/// the new event's `raw` is folded into the head's `raw` and the
/// pending head's level is upgraded if the continuation outranks it.
/// Otherwise the pending head is emitted and the new event becomes
/// the next pending head.
///
/// Caps prevent runaway groups: when either cap is hit, the pending
/// head is emitted and the incoming event starts a fresh head.
pub struct Coalescer {
    pending: Option<Event>,
    pending_lines: usize,
    idle: Duration,
    max_chars: usize,
    max_lines: usize,
}

impl Coalescer {
    pub const DEFAULT_IDLE: Duration = Duration::from_millis(150);
    pub const DEFAULT_MAX_CHARS: usize = 64 * 1024;
    pub const DEFAULT_MAX_LINES: usize = 200;

    pub fn new() -> Self {
        Self {
            pending: None,
            pending_lines: 0,
            idle: Self::DEFAULT_IDLE,
            max_chars: Self::DEFAULT_MAX_CHARS,
            max_lines: Self::DEFAULT_MAX_LINES,
        }
    }

    /// Idle window the driver should wait between lines before
    /// flushing the pending head — without this, a slow producer
    /// keeps the head pinned forever.
    pub fn idle(&self) -> Duration {
        self.idle
    }

    pub fn has_pending(&self) -> bool {
        self.pending.is_some()
    }

    /// Push an event. Returns a finalized event when one is ready
    /// (caller should assign it an id and persist it).
    pub fn push(&mut self, ev: Event) -> Option<Event> {
        if is_continuation(&ev) {
            if let Some(p) = self.pending.as_mut() {
                let new_len = p.raw.len() + 1 + ev.raw.len();
                if new_len <= self.max_chars && self.pending_lines + 1 <= self.max_lines {
                    p.raw.push('\n');
                    p.raw.push_str(&ev.raw);
                    if level_rank(ev.level) > level_rank(p.level) {
                        p.level = ev.level;
                    }
                    self.pending_lines += 1;
                    return None;
                }
                // cap reached — emit prior, the incoming event becomes the new head
                let prev = self.pending.take();
                self.pending = Some(ev);
                self.pending_lines = 1;
                return prev;
            }
            // No head to attach to: this orphan continuation becomes the head itself.
            let prev = self.pending.replace(ev);
            self.pending_lines = 1;
            return prev;
        }
        // Non-continuation: flush prior head, this becomes the new head.
        let prev = self.pending.replace(ev);
        self.pending_lines = 1;
        prev
    }

    /// Flush the pending head, if any. Use on EOF or idle timeout.
    pub fn flush(&mut self) -> Option<Event> {
        self.pending_lines = 0;
        self.pending.take()
    }
}

impl Default for Coalescer {
    fn default() -> Self {
        Self::new()
    }
}

/// Recognizable stack-frame line shapes from common runtimes. Used as
/// a backup signal when leading whitespace alone isn't enough — either
/// because a wrapper prefix's greedy `\s+` separator ate the indent
/// (turbo, bracket-tag, level-prefix all do this), or because the
/// runtime's frame format is non-indented (Go `panic:`, C++ `#0 ...`,
/// PHP `#0 file.php(N):`).
static FRAME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        // JS / Java / Kotlin: `at fn (file.ext:N)` or `at Class.method(File.ext:N)`
        r#"^at\s+\S+\s*\([^)]*\.\w{1,8}:\d+"#,
        // Bare `at <path>.<ext>:<line>` (Rust, Node deep frames)
        r#"|^at\s+[\w./-]+\.\w{1,8}:\d+"#,
        // .NET: `at fn() in <path>:line N`
        r#"|^at\s+\S+\s+in\s+\S+:line\s+\d+"#,
        // Python: `File "path", line N`
        r#"|^File\s+"[^"]+",\s+line\s+\d+"#,
        // Ruby: `from path:line:in`
        r#"|^from\s+\S+:\d+:in\s+['`]"#,
        // Go markers
        r#"|^panic:|^goroutine\s+\d+|^created\s+by\b"#,
        // C++ / glibc: `#N 0xADDR in fn`
        r#"|^#\d+\s+0x[0-9a-fA-F]+\s+in\s+"#,
        // PHP: `#N file.php(N):`
        r#"|^#\d+\s+\S+\.php\(\d+\):"#,
    ))
    .expect("frame regex")
});

fn is_continuation(ev: &Event) -> bool {
    // Check original msg first so Go's `panic:` isn't over-stripped by
    // the turbo rule (`[\w./-]+:[\w-]+:` would falsely match it).
    if FRAME_RE.is_match(&ev.msg) {
        return true;
    }
    let body = extract_body(&ev.msg);
    matches!(body.as_bytes().first(), Some(b' ' | b'\t')) || FRAME_RE.is_match(body)
}

fn level_rank(l: Level) -> u8 {
    match l {
        Level::Error => 4,
        Level::Warn => 3,
        Level::Info => 2,
        Level::Debug => 1,
        Level::Trace => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::Detector;

    fn parse(d: &mut Detector, raw: &str) -> Event {
        d.parse(0, "test", "main", raw.to_string())
    }

    fn drain(c: &mut Coalescer, d: &mut Detector, lines: &[&str]) -> Vec<Event> {
        let mut out = Vec::new();
        for l in lines {
            let ev = parse(d, l);
            if let Some(emit) = c.push(ev) {
                out.push(emit);
            }
        }
        if let Some(emit) = c.flush() {
            out.push(emit);
        }
        out
    }

    #[test]
    fn single_line_passes_through() {
        let mut c = Coalescer::new();
        let mut d = Detector::new();
        let out = drain(&mut c, &mut d, &["hello world"]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].raw, "hello world");
    }

    #[test]
    fn plain_indented_lines_attach_to_head() {
        let mut c = Coalescer::new();
        let mut d = Detector::new();
        let out = drain(
            &mut c,
            &mut d,
            &[
                "Error: boom",
                "    at foo (a.js:1:1)",
                "    at bar (b.js:2:2)",
            ],
        );
        assert_eq!(out.len(), 1);
        assert_eq!(
            out[0].raw,
            "Error: boom\n    at foo (a.js:1:1)\n    at bar (b.js:2:2)"
        );
        assert_eq!(out[0].msg, "Error: boom");
        assert_eq!(out[0].level, Level::Error);
    }

    #[test]
    fn json_wrapped_frames_attach_to_json_head() {
        // The exact shape from DEE-107 dogfood paste: each line is a
        // JSON object whose `msg` field is the head or an indented frame.
        let mut c = Coalescer::new();
        let mut d = Detector::new();
        let out = drain(
            &mut c,
            &mut d,
            &[
                r#"{"level":"error","msg":"Error: Port 8080 is already in use"}"#,
                r#"{"level":"info","msg":"    at httpServerStart (a.js:1:1)"}"#,
                r#"{"level":"info","msg":"    at startServer (b.js:2:2)"}"#,
            ],
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].msg, "Error: Port 8080 is already in use");
        assert_eq!(out[0].level, Level::Error);
        // Continuation JSON lines are folded into raw, joined by \n.
        assert!(out[0].raw.contains("at httpServerStart"));
        assert!(out[0].raw.contains("at startServer"));
        assert_eq!(out[0].raw.matches('\n').count(), 2);
    }

    #[test]
    fn tab_indented_continuation_attaches() {
        let mut c = Coalescer::new();
        let mut d = Detector::new();
        let out = drain(&mut c, &mut d, &["head", "\tcont"]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].raw, "head\n\tcont");
    }

    #[test]
    fn non_indented_line_starts_new_group() {
        let mut c = Coalescer::new();
        let mut d = Detector::new();
        let out = drain(
            &mut c,
            &mut d,
            &["head1", "    cont", "head2", "    cont2"],
        );
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].raw, "head1\n    cont");
        assert_eq!(out[1].raw, "head2\n    cont2");
    }

    #[test]
    fn orphan_continuation_becomes_head() {
        // No prior head — orphan-indented event becomes its own head
        // (it's the best we can do without time-rewinding).
        let mut c = Coalescer::new();
        let mut d = Detector::new();
        let out = drain(&mut c, &mut d, &["    orphan"]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].raw, "    orphan");
    }

    #[test]
    fn continuation_upgrades_level() {
        // Plain head infers Info; continuation containing "Exception"
        // infers Error. Coalesced event is Error.
        let mut c = Coalescer::new();
        let mut d = Detector::new();
        let out = drain(
            &mut c,
            &mut d,
            &["task running", "    Exception in main"],
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].level, Level::Error);
    }

    #[test]
    fn line_cap_emits_partial_group() {
        let mut c = Coalescer {
            pending: None,
            pending_lines: 0,
            idle: Coalescer::DEFAULT_IDLE,
            max_chars: Coalescer::DEFAULT_MAX_CHARS,
            max_lines: 3,
        };
        let mut d = Detector::new();
        let out = drain(
            &mut c,
            &mut d,
            &["head", "  a", "  b", "  c", "  d"],
        );
        // 1st group: head + 2 continuations = 3 lines (cap hit).
        // 4th continuation rolls into a fresh group as orphan head.
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].raw, "head\n  a\n  b");
        assert_eq!(out[1].raw, "  c\n  d");
    }

    #[test]
    fn char_cap_emits_partial_group() {
        let mut c = Coalescer {
            pending: None,
            pending_lines: 0,
            idle: Coalescer::DEFAULT_IDLE,
            max_chars: 12,
            max_lines: Coalescer::DEFAULT_MAX_LINES,
        };
        let mut d = Detector::new();
        // "head" (4) + "\n" + "  cont" (6) = 11, fits.
        // Adding "\n  more" → 18 > 12, cap hits.
        let out = drain(&mut c, &mut d, &["head", "  cont", "  more"]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].raw, "head\n  cont");
        assert_eq!(out[1].raw, "  more");
    }

    #[test]
    fn flush_returns_pending() {
        let mut c = Coalescer::new();
        let mut d = Detector::new();
        let _ = c.push(parse(&mut d, "head"));
        assert!(c.has_pending());
        let flushed = c.flush().unwrap();
        assert_eq!(flushed.raw, "head");
        assert!(!c.has_pending());
    }

    // ---- prefix-aware tests (one per real-world wrapper) ----

    #[test]
    fn turbo_prefix_frame_attaches() {
        // The exact DEE-107 paste shape: each line is JSON whose msg
        // carries a Turbo `@pkg:script:` prefix before the indented
        // stack frame.
        let mut c = Coalescer::new();
        let mut d = Detector::new();
        let out = drain(
            &mut c,
            &mut d,
            &[
                r#"{"level":"error","msg":"@linear/client:start-client: Error: Port 8080 is already in use"}"#,
                r#"{"level":"info","msg":"@linear/client:start-client:     at httpServerStart (file.js:1:1)"}"#,
                r#"{"level":"info","msg":"@linear/client:start-client:     at process.processTicksAndRejections (node:internal/process/task_queues:105:5)"}"#,
            ],
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].level, Level::Error);
        assert!(out[0].raw.contains("at httpServerStart"));
        assert!(out[0].raw.contains("processTicksAndRejections"));
    }

    #[test]
    fn bracket_tag_frame_attaches() {
        let mut c = Coalescer::new();
        let mut d = Detector::new();
        let out = drain(
            &mut c,
            &mut d,
            &[
                "[2026-05-02] starting up",
                "[2026-05-02]     at boot (a.js:1:1)",
            ],
        );
        assert_eq!(out.len(), 1);
        assert!(out[0].raw.contains("at boot"));
    }

    #[test]
    fn level_prefix_frame_attaches() {
        let mut c = Coalescer::new();
        let mut d = Detector::new();
        let out = drain(
            &mut c,
            &mut d,
            &[
                "ERROR: server crashed",
                "ERROR:     at handler (s.js:9:1)",
            ],
        );
        assert_eq!(out.len(), 1);
        assert!(out[0].raw.contains("at handler"));
    }

    #[test]
    fn nodemon_frame_attaches() {
        let mut c = Coalescer::new();
        let mut d = Detector::new();
        let out = drain(
            &mut c,
            &mut d,
            &[
                "[nodemon] app crashed",
                "[nodemon]     at restart (n.js:1:1)",
            ],
        );
        assert_eq!(out.len(), 1);
        assert!(out[0].raw.contains("at restart"));
    }

    #[test]
    fn rust_tracing_frame_attaches() {
        let mut c = Coalescer::new();
        let mut d = Detector::new();
        let out = drain(
            &mut c,
            &mut d,
            &[
                "[2026-05-02T10:30:45Z ERROR myapp::api] request failed",
                "[2026-05-02T10:30:45Z ERROR myapp::api]     at api.rs:42",
            ],
        );
        assert_eq!(out.len(), 1);
        assert!(out[0].raw.contains("at api.rs"));
    }

    #[test]
    fn java_log4j_frame_attaches() {
        let mut c = Coalescer::new();
        let mut d = Detector::new();
        let out = drain(
            &mut c,
            &mut d,
            &[
                "2026-05-02 10:30:45,123 ERROR [main] com.example.Foo - boom",
                "2026-05-02 10:30:45,123 ERROR [main] com.example.Foo -     at com.example.Foo.bar(Foo.java:42)",
            ],
        );
        assert_eq!(out.len(), 1);
        assert!(out[0].raw.contains("Foo.java:42"));
    }

    #[test]
    fn python_logging_frame_attaches() {
        let mut c = Coalescer::new();
        let mut d = Detector::new();
        let out = drain(
            &mut c,
            &mut d,
            &[
                "2026-05-02 10:30:45,123 - app.api - ERROR - request failed",
                "2026-05-02 10:30:45,123 - app.api - ERROR -   File \"/srv/app/api.py\", line 42, in handle",
            ],
        );
        assert_eq!(out.len(), 1);
        assert!(out[0].raw.contains("File \"/srv/app/api.py\""));
    }

    #[test]
    fn klog_frame_attaches() {
        let mut c = Coalescer::new();
        let mut d = Detector::new();
        let out = drain(
            &mut c,
            &mut d,
            &[
                "E0502 10:30:45.123456    1 server.go:42] panic recovered",
                "E0502 10:30:45.123456    1 server.go:42]     at handler.Foo (handler.go:12)",
            ],
        );
        assert_eq!(out.len(), 1);
        assert!(out[0].raw.contains("handler.go:12"));
    }

    #[test]
    fn go_panic_attaches() {
        // `panic:` line is a non-indented Go marker — should attach
        // to a prior head as a continuation.
        let mut c = Coalescer::new();
        let mut d = Detector::new();
        let out = drain(
            &mut c,
            &mut d,
            &[
                "fatal error encountered",
                "panic: runtime error: index out of range [3] with length 2",
                "goroutine 1 [running]:",
            ],
        );
        assert_eq!(out.len(), 1);
        assert!(out[0].raw.contains("panic: runtime error"));
        assert!(out[0].raw.contains("goroutine 1"));
    }

    #[test]
    fn cpp_backtrace_attaches() {
        let mut c = Coalescer::new();
        let mut d = Detector::new();
        let out = drain(
            &mut c,
            &mut d,
            &[
                "Segmentation fault",
                "#0  0x0000555555554890 in main () from /usr/bin/app",
                "#1  0x00007ffff7a05bf7 in __libc_start_main ()",
            ],
        );
        assert_eq!(out.len(), 1);
        assert!(out[0].raw.contains("0x0000555555554890"));
        assert!(out[0].raw.contains("__libc_start_main"));
    }

    #[test]
    fn php_backtrace_attaches() {
        let mut c = Coalescer::new();
        let mut d = Detector::new();
        let out = drain(
            &mut c,
            &mut d,
            &[
                "Uncaught exception",
                "#0  /srv/app/index.php(42): handle()",
                "#1  /srv/app/lib/router.php(15): route()",
            ],
        );
        assert_eq!(out.len(), 1);
        assert!(out[0].raw.contains("/srv/app/index.php(42)"));
    }

    #[test]
    fn unrecognized_prefix_no_false_positive() {
        // Two heads with a non-matching prefix (no rule strips it,
        // not whitespace, not a frame marker) stay as separate heads.
        let mut c = Coalescer::new();
        let mut d = Detector::new();
        let out = drain(
            &mut c,
            &mut d,
            &[
                "custom-tag>> first message",
                "custom-tag>> second message",
            ],
        );
        assert_eq!(out.len(), 2);
    }
}
