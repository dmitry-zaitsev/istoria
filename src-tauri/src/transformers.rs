use std::sync::LazyLock;

use regex::Regex;
use serde::Deserialize;

/// Single source of truth for log-prefix detection. The same JSON is
/// read by `src/lib/transformers.ts` for full render-time transformation.
/// Backend uses only `extract_body` for coalescing decisions — the
/// `output.*` keys are frontend territory and are intentionally ignored
/// here.
const RULES_JSON: &str = include_str!("../../transformer_rules.json");

#[derive(Deserialize)]
struct RuleSpec {
    id: String,
    order: i32,
    pattern: String,
    #[serde(default)]
    flags: String,
}

struct CompiledRule {
    #[allow(dead_code)]
    id: String,
    re: Regex,
}

static RULES: LazyLock<Vec<CompiledRule>> = LazyLock::new(|| {
    let mut specs: Vec<RuleSpec> =
        serde_json::from_str(RULES_JSON).expect("transformer_rules.json must be valid JSON");
    specs.sort_by_key(|s| s.order);
    specs
        .into_iter()
        .filter_map(|s| {
            let pat = if s.flags.contains('i') {
                format!("(?i){}", s.pattern)
            } else {
                s.pattern.clone()
            };
            match Regex::new(&pat) {
                Ok(re) => Some(CompiledRule { id: s.id, re }),
                Err(e) => {
                    tracing::warn!(id = %s.id, error = %e, "transformer rule failed to compile");
                    None
                }
            }
        })
        .collect()
});

/// Strip a recognized wrapper prefix and return the body. If no rule
/// captures a `body` group, return the original string untouched.
///
/// Used by the coalescer to look past `@pkg:script: `, `[tag] `,
/// `INFO: `, log4j timestamps, etc., so an indented stack frame inside
/// the wrapper still registers as a continuation.
pub fn extract_body(msg: &str) -> &str {
    for rule in RULES.iter() {
        if let Some(caps) = rule.re.captures(msg) {
            if let Some(body) = caps.name("body") {
                return body.as_str();
            }
        }
    }
    msg
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_all_rules() {
        // No rule should silently fail to compile — we shipped 13.
        assert_eq!(RULES.len(), 13);
    }

    #[test]
    fn extract_body_returns_input_when_no_match() {
        assert_eq!(extract_body("plain message"), "plain message");
    }

    #[test]
    fn turbo_strips_pkg_script_prefix() {
        assert_eq!(
            extract_body("@linear/client:start-client: hello world"),
            "hello world"
        );
    }

    #[test]
    fn turbo_preserves_indentation_after_prefix() {
        // The whole point of this work — indented stack frame inside Turbo wrapper.
        assert_eq!(
            extract_body("@linear/client:start-client:     at httpServerStart (file.js:1:1)"),
            "    at httpServerStart (file.js:1:1)"
        );
    }

    #[test]
    fn nodemon_strips_prefix() {
        assert_eq!(extract_body("[nodemon] starting `node server.js`"), "starting `node server.js`");
    }

    #[test]
    fn level_prefix_strips() {
        assert_eq!(extract_body("INFO: server started"), "server started");
        assert_eq!(extract_body("ERROR: oh no"), "oh no");
    }

    #[test]
    fn bracket_tag_strips() {
        assert_eq!(extract_body("[2026-05-02] hello"), "hello");
    }

    #[test]
    fn rust_tracing_strips() {
        assert_eq!(
            extract_body("[2026-05-02T10:30:45Z INFO mod::path] body text"),
            "body text"
        );
    }

    #[test]
    fn java_log4j_strips() {
        assert_eq!(
            extract_body("2026-05-02 10:30:45,123 INFO  [main] com.example.Foo - body text"),
            "body text"
        );
    }

    #[test]
    fn python_logging_strips() {
        assert_eq!(
            extract_body("2026-05-02 10:30:45,123 - module.name - INFO - body text"),
            "body text"
        );
    }

    #[test]
    fn klog_strips() {
        assert_eq!(
            extract_body("I0114 10:30:45.123456    1 file.go:123] body text"),
            "body text"
        );
    }

    #[test]
    fn android_logcat_strips() {
        assert_eq!(extract_body("D/MyTag  ( 1234): body text"), "body text");
    }

    #[test]
    fn ios_nslog_strips() {
        assert_eq!(
            extract_body("2026-05-02 10:30:45.123 MyApp[1234:5678] body text"),
            "body text"
        );
    }

    #[test]
    fn syslog_rfc3164_strips() {
        assert_eq!(
            extract_body("<14>Jan 15 10:30:45 host program[123]: body text"),
            "body text"
        );
    }

    #[test]
    fn docker_cri_strips() {
        assert_eq!(
            extract_body("2026-05-02T10:30:45.123Z stdout F body text"),
            "body text"
        );
    }
}
