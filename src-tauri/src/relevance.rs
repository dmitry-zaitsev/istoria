use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Serialize;

use crate::code::{self, CodeCache};

const DIFF_MAX_BYTES: usize = 60_000;
const CLAUDE_TIMEOUT_SECS: u64 = 120;

#[derive(Clone, Debug, Serialize)]
pub struct BranchState {
    pub branch: String,
    pub head_sha: String,
    pub has_uncommitted: bool,
    pub default_branch: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct RelevanceAnalysis {
    pub regexes: Vec<String>,
    pub branch_state: BranchState,
}

pub fn branch_state(project_root: &Path, cache: &CodeCache) -> Result<BranchState, String> {
    let head_sha = run_git(project_root, &["rev-parse", "HEAD"])?;
    let branch = run_git(project_root, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let porcelain = run_git(project_root, &["status", "--porcelain"])?;
    let default_branch = code::default_branch(project_root, cache);
    Ok(BranchState {
        branch,
        head_sha,
        has_uncommitted: !porcelain.trim().is_empty(),
        default_branch,
    })
}

pub fn analyze(
    project_root: &Path,
    claude_path: &str,
    state: &BranchState,
) -> Result<RelevanceAnalysis, String> {
    // Try origin/<default>...HEAD first (covers committed changes against
    // the default branch). Fall back to <default>...HEAD if there's no
    // origin remote configured.
    let upstream_diff_target = format!("origin/{}...HEAD", state.default_branch);
    let local_diff_target = format!("{}...HEAD", state.default_branch);
    let committed = run_git(project_root, &["diff", &upstream_diff_target])
        .or_else(|_| run_git(project_root, &["diff", &local_diff_target]))
        .unwrap_or_default();
    // Plus uncommitted (working tree vs HEAD) so in-flight log lines also
    // get picked up before the user commits.
    let uncommitted = run_git(project_root, &["diff", "HEAD"]).unwrap_or_default();
    let combined = if uncommitted.trim().is_empty() {
        committed
    } else if committed.trim().is_empty() {
        uncommitted
    } else {
        format!("{committed}\n\n--- uncommitted (HEAD..working tree) ---\n\n{uncommitted}")
    };
    let diff = truncate_utf8(&combined, DIFF_MAX_BYTES);

    let prompt = build_prompt(state, &diff);
    let stdout = run_claude(claude_path, project_root, &prompt)?;
    let regexes = parse_regexes(&stdout)?;
    Ok(RelevanceAnalysis {
        regexes,
        branch_state: state.clone(),
    })
}

fn build_prompt(state: &BranchState, diff: &str) -> String {
    format!(
        "You are helping a log viewer (istoria) highlight log entries relevant to the current git branch.\n\
\n\
Current branch: {branch}\n\
Default branch: {default}\n\
\n\
Diff (origin/{default}...HEAD plus any uncommitted changes):\n\
\n\
{diff}\n\
\n\
Identify log strings (passed to log/print/tracing/console/println!/log.info/etc) that are RELEVANT to this branch's changes:\n\
1. Log strings ADDED or MODIFIED in this branch (read the diff).\n\
2. ADJACENT log strings from the same feature/area that would help debug context. Use your judgement on what \"adjacent\" means — same module, same feature flag, same call chain.\n\
\n\
Return EXACTLY one JSON object as the LAST line of your response, in this format:\n\
{{\"regexes\": [\"pattern1\", \"pattern2\"]}}\n\
\n\
Each pattern is a JavaScript-compatible regex (no surrounding slashes, no flags). It will be matched case-insensitively against the log MESSAGE text (not source code). Aim for 3-15 patterns; prefer broader patterns that catch a family of related messages over a per-string list. Return {{\"regexes\": []}} if nothing relevant.\n",
        branch = state.branch,
        default = state.default_branch,
        diff = diff,
    )
}

fn run_claude(claude_path: &str, cwd: &Path, prompt: &str) -> Result<String, String> {
    let mut child = Command::new(claude_path)
        .arg("-p")
        .arg("--output-format")
        .arg("text")
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn claude: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .map_err(|e| format!("write claude stdin: {e}"))?;
        // Drop stdin to send EOF.
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(CLAUDE_TIMEOUT_SECS);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    return Err(format!(
                        "claude timed out after {CLAUDE_TIMEOUT_SECS}s"
                    ));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("wait claude: {e}")),
        }
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("collect claude: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "claude exited {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn run_git(project_root: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(project_root)
        .output()
        .map_err(|e| format!("git failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Truncate `s` to at most `max_bytes`, snapping to a UTF-8 char boundary.
fn truncate_utf8(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n\n[... diff truncated at {} bytes ...]", &s[..end], end)
}

/// Pull the regex list out of Claude's response. Accepts:
///   * a plain `{"regexes": [...]}` JSON object on its own line, or
///   * the same object embedded anywhere in the output.
/// Picks the LAST occurrence so the model's final answer wins over any
/// reasoning earlier in the response.
fn parse_regexes(text: &str) -> Result<Vec<String>, String> {
    // Last-line first: cheap and matches the prompt's instruction.
    for line in text.lines().rev() {
        let trimmed = line.trim();
        if trimmed.starts_with('{') && trimmed.contains("regexes") {
            if let Some(out) = try_extract_regexes(trimmed) {
                return Ok(out);
            }
        }
    }
    // Fallback: scan every "{" forward and try parsing balanced spans.
    // Walks once, O(n) in the size of the response.
    let bytes = text.as_bytes();
    let mut i = 0;
    let mut last: Option<Vec<String>> = None;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            if let Some((end, candidate)) = balanced_object(text, i) {
                if candidate.contains("\"regexes\"") {
                    if let Some(out) = try_extract_regexes(candidate) {
                        last = Some(out);
                    }
                }
                i = end;
                continue;
            }
        }
        i += 1;
    }
    last.ok_or_else(|| {
        format!(
            "could not find a {{\"regexes\": [...]}} object in claude output (head: {})",
            text.chars().take(200).collect::<String>()
        )
    })
}

fn try_extract_regexes(s: &str) -> Option<Vec<String>> {
    let v: serde_json::Value = serde_json::from_str(s).ok()?;
    let arr = v.get("regexes")?.as_array()?;
    Some(
        arr.iter()
            .filter_map(|x| x.as_str().map(|s| s.to_string()))
            .filter(|s| !s.is_empty())
            .collect(),
    )
}

/// Find the smallest balanced `{...}` slice starting at `start`.
/// Returns the end index (exclusive) and the slice text.
fn balanced_object(text: &str, start: usize) -> Option<(usize, &str)> {
    let bytes = text.as_bytes();
    if bytes.get(start) != Some(&b'{') {
        return None;
    }
    let mut depth = 0;
    let mut in_str = false;
    let mut escape = false;
    let mut i = start;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            if escape {
                escape = false;
            } else if c == b'\\' {
                escape = true;
            } else if c == b'"' {
                in_str = false;
            }
        } else {
            match c {
                b'"' => in_str = true,
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        let end = i + 1;
                        return Some((end, &text[start..end]));
                    }
                }
                _ => {}
            }
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_last_line_json() {
        let out = "Here is my analysis...\n\n{\"regexes\": [\"foo\", \"bar baz\"]}\n";
        let r = parse_regexes(out).unwrap();
        assert_eq!(r, vec!["foo".to_string(), "bar baz".to_string()]);
    }

    #[test]
    fn parses_embedded_json() {
        let out = "Reasoning:\n- found a thing\nFinal: {\"regexes\":[\"a\"]} done.";
        let r = parse_regexes(out).unwrap();
        assert_eq!(r, vec!["a".to_string()]);
    }

    #[test]
    fn ignores_empty_strings() {
        let out = "{\"regexes\": [\"\", \"x\"]}";
        let r = parse_regexes(out).unwrap();
        assert_eq!(r, vec!["x".to_string()]);
    }

    #[test]
    fn handles_no_match() {
        let err = parse_regexes("nothing here").unwrap_err();
        assert!(err.contains("could not find"));
    }

    #[test]
    fn truncate_respects_char_boundary() {
        // Multi-byte char straddling the cut.
        let s = "aaaa🦀aaaa";
        let cut = truncate_utf8(s, 5);
        assert!(cut.starts_with("aaaa"));
        assert!(!cut.starts_with("aaaa\u{FFFD}"));
    }
}
