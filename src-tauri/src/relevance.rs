//! Branch relevance: auto-detect log events emitted by code that's
//! been touched on the current branch (or imported by a touched file).
//!
//! Pipeline per source root:
//!   1. `git diff origin/<default>...HEAD` + `git diff HEAD` →
//!      distinct list of *touched files* in recognized languages.
//!   2. Build/refresh `ProjectIndex` per root: file mtimes, log calls
//!      per file, reverse module-id → referrers map.
//!   3. **Direct patterns**: every log call in any touched file.
//!   4. **Indirect (1-hop) patterns**: every log call in any file that
//!      imports a touched file (skipping touched files themselves).
//!   5. Compile a combined alternation regex per source; one capture
//!      group per pattern, indexed back to the pattern entry.
//!   6. For each event in the ring under that source, run captures
//!      against `ev.msg`; on hit, mark id relevant + bump per-site
//!      emitted_count.
//!
//! Why patterns instead of `find_emission_site`: the rendered-message
//! needle approach in `code.rs` requires an 8-char contiguous static
//! run, which fails on common templates like `"loaded {} items"` →
//! `"loaded 7 items"`. Extracting the skeleton from the *call site*
//! handles concat / format / template literals uniformly.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::time::{Instant, SystemTime};

use parking_lot::Mutex;
use regex::Regex;
use serde::Serialize;

use crate::event::Event;
use crate::ring::Ring;

const SCAN_FILE_MAX_BYTES: u64 = 1_000_000;
const SCAN_DIR_BUDGET: usize = 20_000;
const RECOMPUTE_INTERVAL_SECS: u64 = 15;
const EMIT_DEBOUNCE_MS: u64 = 100;

const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "vendor",
    ".next",
    ".turbo",
    ".cache",
    ".venv",
    "venv",
    "__pycache__",
    ".idea",
    ".vscode",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Lang {
    TsJs,
    Rust,
    Java,
}

impl Lang {
    fn from_ext(ext: &str) -> Option<Self> {
        match ext {
            "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => Some(Lang::TsJs),
            "rs" => Some(Lang::Rust),
            "java" => Some(Lang::Java),
            _ => None,
        }
    }

    fn from_path(path: &Path) -> Option<Self> {
        path.extension()
            .and_then(|e| e.to_str())
            .and_then(Self::from_ext)
    }
}

// --------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PatternKind {
    Direct,
    Indirect { via_files: Vec<String> },
}

#[derive(Clone, Debug)]
pub struct LogPattern {
    /// Uncompiled regex for this log call's static skeleton.
    pub regex: String,
    pub source: String,
    pub rel_path: String,
    pub line: u32,
    pub raw_call: String,
    pub kind: PatternKind,
}

#[derive(Clone, Debug, Serialize)]
pub struct CodeLine {
    pub line: u32,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct RelevanceSite {
    pub source: String,
    pub rel_path: String,
    /// Absolute path on the producer machine. Frontend uses this to
    /// build editor-URL clicks; backend keeps the `open_url`
    /// scheme allow-list for safety.
    pub abs_path: String,
    pub line: u32,
    pub raw_call: String,
    pub snippet: Vec<CodeLine>,
    pub emitted_count: u64,
    pub kind: PatternKind,
}

#[derive(Clone, Debug, Serialize)]
pub struct RelevanceSnapshot {
    pub ids: Vec<u64>,
    pub sites: Vec<RelevanceSite>,
}

// --------------------------------------------------------------------
// SourceRoots: source_name → its cwd
// --------------------------------------------------------------------

#[derive(Default)]
pub struct SourceRoots {
    inner: Mutex<HashMap<String, PathBuf>>,
}

impl SourceRoots {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, source: &str, cwd: PathBuf) {
        self.inner.lock().insert(source.to_string(), cwd);
    }

    pub fn get(&self, source: &str) -> Option<PathBuf> {
        self.inner.lock().get(source).cloned()
    }

    pub fn snapshot(&self) -> HashMap<String, PathBuf> {
        self.inner.lock().clone()
    }
}

// --------------------------------------------------------------------
// LogCall + ProjectIndex
// --------------------------------------------------------------------

#[derive(Clone, Debug)]
struct LogCall {
    line: u32,
    raw_call: String,
    /// Static pieces extracted from the call's string-literal args,
    /// pre-`regex::escape`. Combined at compile time via `.*?`.
    pieces: Vec<String>,
}

#[derive(Debug)]
struct FileEntry {
    mtime: SystemTime,
    lang: Lang,
    /// Module ids imported by this file (last segment of each import).
    imports: HashSet<String>,
    log_calls: Vec<LogCall>,
}

/// Per-source-root: tracks every recognized source file's parse state
/// and a reverse map of imported module-id → referrer files.
#[derive(Default)]
struct ProjectIndex {
    files: HashMap<PathBuf, FileEntry>,
    ref_index: HashMap<String, HashSet<PathBuf>>,
    last_scan_at: Option<Instant>,
}

impl ProjectIndex {
    fn ensure_fresh(&mut self, root: &Path) {
        // Walk the project, stat every recognized file, re-parse only
        // those whose mtime changed (or are new). Drop entries for
        // files that no longer exist.
        let mut seen: HashSet<PathBuf> = HashSet::new();
        let mut budget = SCAN_DIR_BUDGET;
        self.walk(root, &mut seen, &mut budget);
        // Remove stale entries
        let stale: Vec<PathBuf> = self
            .files
            .keys()
            .filter(|p| !seen.contains(*p))
            .cloned()
            .collect();
        for p in stale {
            self.remove_file(&p);
        }
        self.last_scan_at = Some(Instant::now());
    }

    fn walk(
        &mut self,
        dir: &Path,
        seen: &mut HashSet<PathBuf>,
        budget: &mut usize,
    ) {
        if *budget == 0 {
            return;
        }
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            if SKIP_DIRS.iter().any(|d| *d == name) {
                continue;
            }
            let ft = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if ft.is_dir() {
                self.walk(&path, seen, budget);
                continue;
            }
            if !ft.is_file() {
                continue;
            }
            *budget = budget.saturating_sub(1);
            if *budget == 0 {
                return;
            }
            let Some(lang) = Lang::from_path(&path) else {
                continue;
            };
            let meta = match path.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.len() > SCAN_FILE_MAX_BYTES {
                continue;
            }
            let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            seen.insert(path.clone());
            let needs_parse = match self.files.get(&path) {
                Some(e) => e.mtime != mtime || e.lang != lang,
                None => true,
            };
            if !needs_parse {
                continue;
            }
            let Ok(content) = read_file(&path) else { continue };
            let imports = extract_imports(&content, lang);
            let log_calls = extract_log_calls(&content);
            self.replace_file(
                path,
                FileEntry { mtime, lang, imports, log_calls },
            );
        }
    }

    fn remove_file(&mut self, path: &Path) {
        if let Some(entry) = self.files.remove(path) {
            for id in entry.imports {
                if let Some(set) = self.ref_index.get_mut(&id) {
                    set.remove(path);
                    if set.is_empty() {
                        self.ref_index.remove(&id);
                    }
                }
            }
        }
    }

    fn replace_file(&mut self, path: PathBuf, new_entry: FileEntry) {
        // Strip old import edges
        if let Some(old) = self.files.get(&path) {
            for id in &old.imports {
                if let Some(set) = self.ref_index.get_mut(id) {
                    set.remove(&path);
                    if set.is_empty() {
                        self.ref_index.remove(id);
                    }
                }
            }
        }
        // Add new edges
        for id in &new_entry.imports {
            self.ref_index
                .entry(id.clone())
                .or_default()
                .insert(path.clone());
        }
        self.files.insert(path, new_entry);
    }

    fn log_calls(&self, path: &Path) -> Option<&Vec<LogCall>> {
        self.files.get(path).map(|e| &e.log_calls)
    }

    fn referring_files(&self, module_id: &str) -> Option<&HashSet<PathBuf>> {
        self.ref_index.get(module_id)
    }
}

// --------------------------------------------------------------------
// File I/O helpers
// --------------------------------------------------------------------

fn read_file(path: &Path) -> std::io::Result<String> {
    let mut f = fs::File::open(path)?;
    let mut buf = String::new();
    f.read_to_string(&mut buf)?;
    Ok(buf)
}

// --------------------------------------------------------------------
// Module-id derivation (touched file → module_ids candidates)
// --------------------------------------------------------------------

/// Derive the module identifier(s) a file would be imported as.
/// Returns 1-2 candidates per file (e.g. `index.ts` yields parent
/// dir name; everything else yields the file stem). Returns empty
/// vec for files in unrecognized languages.
pub fn module_id_candidates(rel_path: &Path) -> Vec<String> {
    let Some(lang) = Lang::from_path(rel_path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let stem = rel_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let parent_dir = rel_path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("");
    match lang {
        Lang::TsJs => {
            if stem == "index" && !parent_dir.is_empty() {
                out.push(parent_dir.to_string());
            } else if !stem.is_empty() {
                out.push(stem.to_string());
            }
        }
        Lang::Rust => {
            if stem == "mod" && !parent_dir.is_empty() {
                out.push(parent_dir.to_string());
            } else if !stem.is_empty() {
                out.push(stem.to_string());
            }
        }
        Lang::Java => {
            if !stem.is_empty() {
                out.push(stem.to_string());
            }
        }
    }
    out
}

// --------------------------------------------------------------------
// Import line extraction (per-language)
// --------------------------------------------------------------------

fn import_re_ts() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r#"(?:from\s+["']([^"']+)["']|require\(\s*["']([^"']+)["']|import\(\s*["']([^"']+)["'])"#,
        )
        .unwrap()
    })
}

fn import_re_rust() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        // Capture the path segment after `use ` or `mod `.
        Regex::new(r"\b(?:use|mod)\s+([\w:]+)").unwrap()
    })
}

fn import_re_java() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"import\s+(?:static\s+)?([\w.]+)\s*;").unwrap())
}

fn extract_imports(content: &str, lang: Lang) -> HashSet<String> {
    let mut out = HashSet::new();
    match lang {
        Lang::TsJs => {
            for cap in import_re_ts().captures_iter(content) {
                for i in 1..=3 {
                    if let Some(m) = cap.get(i) {
                        if let Some(id) = ts_module_id_from_path(m.as_str()) {
                            out.insert(id);
                        }
                    }
                }
            }
        }
        Lang::Rust => {
            for cap in import_re_rust().captures_iter(content) {
                if let Some(m) = cap.get(1) {
                    let path = m.as_str().trim_matches(|c: char| !c.is_alphanumeric() && c != ':' && c != '_');
                    if let Some(last) = path.rsplit("::").next() {
                        if !last.is_empty() && last != "self" && last != "super" && last != "crate" {
                            out.insert(last.to_string());
                        }
                    }
                }
            }
        }
        Lang::Java => {
            for cap in import_re_java().captures_iter(content) {
                if let Some(m) = cap.get(1) {
                    let path = m.as_str();
                    if let Some(last) = path.rsplit('.').next() {
                        if !last.is_empty() && last != "*" {
                            out.insert(last.to_string());
                        }
                    }
                }
            }
        }
    }
    out
}

fn ts_module_id_from_path(path: &str) -> Option<String> {
    let p = Path::new(path);
    let stem = p.file_stem()?.to_str()?;
    if stem == "index" {
        p.parent()
            .and_then(|x| x.file_name())
            .and_then(|n| n.to_str())
            .map(String::from)
    } else {
        Some(stem.to_string())
    }
}

// --------------------------------------------------------------------
// Log call extraction (language-agnostic detector)
// --------------------------------------------------------------------

fn log_call_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r"\b(?:console\.\w+|log\.\w+|logger\.\w+|tracing::\w+!|println!|eprintln!|info!|warn!|error!|debug!|trace!|logging\.\w+|fmt\.Println|fmt\.Printf|slog\.\w+|printf|fprintf|System\.out\.print(?:ln|f)?)\s*\(",
        )
        .unwrap()
    })
}

/// Walk `content` for log-API matches, balanced-paren-extract each
/// call's arg list, run the skeleton extractor, emit a LogCall with
/// the (1-based) starting line.
fn extract_log_calls(content: &str) -> Vec<LogCall> {
    let line_starts = compute_line_starts(content);
    let bytes = content.as_bytes();
    let mut out = Vec::new();
    for m in log_call_re().find_iter(content) {
        // Match ends at the `(`; balanced-paren walk from there.
        let paren_open = m.end().saturating_sub(1);
        if bytes.get(paren_open) != Some(&b'(') {
            continue;
        }
        let Some(close) = find_matching_paren(content, paren_open) else {
            continue;
        };
        let args = &content[paren_open + 1..close];
        let pieces = extract_pieces_from_args(args);
        if pieces.is_empty() {
            continue;
        }
        let line = line_no_for(&line_starts, m.start());
        let raw_call = content[m.start()..close + 1].to_string();
        out.push(LogCall { line, raw_call, pieces });
    }
    out
}

fn compute_line_starts(s: &str) -> Vec<usize> {
    let mut v = vec![0usize];
    for (i, b) in s.bytes().enumerate() {
        if b == b'\n' {
            v.push(i + 1);
        }
    }
    v
}

fn line_no_for(line_starts: &[usize], offset: usize) -> u32 {
    match line_starts.binary_search(&offset) {
        Ok(i) => (i + 1) as u32,
        Err(i) => i as u32,
    }
}

fn find_matching_paren(s: &str, open_idx: usize) -> Option<usize> {
    let bytes = s.as_bytes();
    if bytes.get(open_idx) != Some(&b'(') {
        return None;
    }
    let mut depth = 0i32;
    let mut i = open_idx;
    let mut in_str = false;
    let mut str_delim = 0u8;
    let mut escape = false;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            if escape {
                escape = false;
            } else if c == b'\\' {
                escape = true;
            } else if c == str_delim {
                in_str = false;
            }
        } else {
            match c {
                b'"' | b'\'' | b'`' => {
                    in_str = true;
                    str_delim = c;
                }
                b'(' => depth += 1,
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i);
                    }
                }
                _ => {}
            }
        }
        i += 1;
    }
    None
}

// --------------------------------------------------------------------
// Skeleton extraction (the heart of the matcher)
// --------------------------------------------------------------------

/// Walk the call's arg list, find every string literal, split each on
/// format placeholders / template expressions, return the surviving
/// static pieces in source order. Each piece carries enough content
/// (≥ 2 alphanumeric chars) to be useful as a runtime anchor.
fn extract_pieces_from_args(args: &str) -> Vec<String> {
    let bytes = args.as_bytes();
    let mut pieces = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'"' || c == b'\'' || c == b'`' {
            let delim = c;
            let start = i + 1;
            let mut j = start;
            let mut escape = false;
            while j < bytes.len() {
                let cc = bytes[j];
                if escape {
                    escape = false;
                } else if cc == b'\\' {
                    escape = true;
                } else if cc == delim {
                    break;
                }
                j += 1;
            }
            if j >= bytes.len() {
                break;
            }
            let inner = &args[start..j];
            let split_parts = if delim == b'`' {
                split_template_literal(inner)
            } else {
                split_format_placeholders(inner)
            };
            for p in split_parts {
                let cleaned = decode_escapes(&p);
                let alnum = cleaned.chars().filter(|c| c.is_alphanumeric()).count();
                if alnum >= 2 {
                    pieces.push(cleaned);
                }
            }
            i = j + 1;
        } else {
            i += 1;
        }
    }
    pieces
}

fn placeholder_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    // `{...}` for Rust/Python, `%X` for printf-family.
    R.get_or_init(|| Regex::new(r"\{[^}]*\}|%[a-zA-Z]").unwrap())
}

fn split_format_placeholders(s: &str) -> Vec<String> {
    placeholder_re()
        .split(s)
        .map(|p| p.to_string())
        .collect()
}

fn split_template_literal(s: &str) -> Vec<String> {
    // JS template literal: `${...}` placeholders with possibly nested
    // braces inside the expression.
    let bytes = s.as_bytes();
    let mut parts = Vec::new();
    let mut cur = String::new();
    let mut i = 0;
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'$' && bytes[i + 1] == b'{' {
            parts.push(std::mem::take(&mut cur));
            i += 2;
            let mut depth = 1i32;
            while i < bytes.len() && depth > 0 {
                if bytes[i] == b'{' {
                    depth += 1;
                } else if bytes[i] == b'}' {
                    depth -= 1;
                }
                i += 1;
            }
        } else {
            // Push the single byte; we only handle ASCII boundaries
            // safely because non-ASCII chars in literals are still
            // valid UTF-8 sequences that pass through unchanged when
            // we copy by char. So convert to char index walking.
            // Simpler: rebuild via char iter outside this fast path
            // when we hit a non-ASCII run.
            if bytes[i] < 0x80 {
                cur.push(bytes[i] as char);
                i += 1;
            } else {
                // Walk one full UTF-8 char.
                let ch_len = utf8_char_len(bytes[i]);
                let end = (i + ch_len).min(bytes.len());
                if let Ok(s_chunk) = std::str::from_utf8(&bytes[i..end]) {
                    cur.push_str(s_chunk);
                }
                i = end;
            }
        }
    }
    parts.push(cur);
    parts
}

fn utf8_char_len(b: u8) -> usize {
    if b & 0x80 == 0 {
        1
    } else if b & 0xE0 == 0xC0 {
        2
    } else if b & 0xF0 == 0xE0 {
        3
    } else if b & 0xF8 == 0xF0 {
        4
    } else {
        1
    }
}

fn decode_escapes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('r') => out.push('\r'),
                Some('\\') => out.push('\\'),
                Some('"') => out.push('"'),
                Some('\'') => out.push('\''),
                Some('`') => out.push('`'),
                Some(other) => out.push(other),
                None => break,
            }
        } else {
            out.push(c);
        }
    }
    out.trim().to_string()
}

/// Convert pieces to a regex string. Each piece is regex-escaped and
/// joined by non-greedy `.*?`. Caller wraps in `(?i)` and a capture
/// group as part of the combined alternation.
fn build_pattern_regex(pieces: &[String]) -> String {
    pieces
        .iter()
        .map(|p| regex::escape(p))
        .collect::<Vec<_>>()
        .join(".*?")
}

// --------------------------------------------------------------------
// Unified-diff parser (touched files + + lines)
// --------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffHit {
    pub rel_path: String,
    pub line_no: u32,
    pub text: String,
}

/// Parse `git diff --unified=N` output. Returns one `DiffHit` per `+`
/// line, with the new-file line number computed from each `@@` header.
/// Header lines (`+++ b/path`) advance the current file; everything
/// else is per-hunk.
pub fn parse_unified_diff(diff: &str) -> Vec<DiffHit> {
    let mut out = Vec::new();
    let mut cur_file: Option<String> = None;
    let mut new_line: u32 = 0;
    for raw in diff.lines() {
        if let Some(rest) = raw.strip_prefix("+++ ") {
            // "+++ b/path/to/file" or "+++ /dev/null"
            cur_file = rest
                .strip_prefix("b/")
                .or_else(|| rest.strip_prefix("a/"))
                .map(|s| s.to_string())
                .filter(|s| s != "/dev/null");
            continue;
        }
        if raw.starts_with("--- ") {
            continue;
        }
        if let Some(rest) = raw.strip_prefix("@@") {
            // "@@ -A,B +C,D @@ ..."
            if let Some((start, _)) = parse_hunk_header(rest) {
                new_line = start;
            }
            continue;
        }
        if raw.starts_with("diff --git") || raw.starts_with("index ")
            || raw.starts_with("similarity") || raw.starts_with("rename")
            || raw.starts_with("new file") || raw.starts_with("deleted file")
            || raw.starts_with("Binary ")
        {
            continue;
        }
        let Some(file) = cur_file.as_deref() else { continue };
        match raw.chars().next() {
            Some('+') => {
                let text = &raw[1..];
                out.push(DiffHit {
                    rel_path: file.to_string(),
                    line_no: new_line,
                    text: text.to_string(),
                });
                new_line += 1;
            }
            Some('-') => {
                // Deletions don't advance new_line.
            }
            Some(' ') => {
                new_line += 1;
            }
            _ => {}
        }
    }
    out
}

/// Parse the `+C,D` portion of an `@@ -A,B +C,D @@` header. Returns
/// `(C, D)`. `D` defaults to 1 if omitted.
fn parse_hunk_header(rest: &str) -> Option<(u32, u32)> {
    let plus = rest.find('+')?;
    let after = &rest[plus + 1..];
    let end = after.find(' ').unwrap_or(after.len());
    let span = &after[..end];
    let (start_s, count_s) = match span.find(',') {
        Some(i) => (&span[..i], &span[i + 1..]),
        None => (span, "1"),
    };
    let start: u32 = start_s.parse().ok()?;
    let count: u32 = count_s.parse().ok()?;
    Some((start, count))
}

/// Distinct list of new-file paths touched by the diff.
pub fn touched_files(diff: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    for raw in diff.lines() {
        if let Some(rest) = raw.strip_prefix("+++ ") {
            if let Some(p) = rest
                .strip_prefix("b/")
                .or_else(|| rest.strip_prefix("a/"))
                .filter(|s| *s != "/dev/null")
            {
                out.insert(p.to_string());
            }
        }
    }
    out
}

// --------------------------------------------------------------------
// Git plumbing
// --------------------------------------------------------------------

fn run_git(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| format!("git failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn default_branch(root: &Path) -> String {
    match Command::new("git")
        .args(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .current_dir(root)
        .output()
    {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            s.strip_prefix("origin/").map(String::from).unwrap_or(s)
        }
        _ => "main".into(),
    }
}

fn head_sha(root: &Path) -> Result<String, String> {
    run_git(root, &["rev-parse", "HEAD"]).map(|s| s.trim().to_string())
}

fn collect_diff(root: &Path) -> String {
    let def = default_branch(root);
    let upstream = format!("origin/{def}...HEAD");
    let local = format!("{def}...HEAD");
    let committed = run_git(root, &["diff", "--unified=0", &upstream])
        .or_else(|_| run_git(root, &["diff", "--unified=0", &local]))
        .unwrap_or_default();
    let uncommitted = run_git(root, &["diff", "--unified=0", "HEAD"]).unwrap_or_default();
    if committed.trim().is_empty() {
        uncommitted
    } else if uncommitted.trim().is_empty() {
        committed
    } else {
        format!("{committed}\n{uncommitted}")
    }
}

// --------------------------------------------------------------------
// RootPatterns + PatternCache
// --------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
pub struct SiteKey {
    pub source: String,
    pub rel_path: String,
    pub line: u32,
}

struct RootState {
    /// Cached HEAD SHA + uncommitted-diff hash so we can skip
    /// recomputation when nothing changed.
    head_sha: String,
    diff_hash: u64,
    patterns: Vec<LogPattern>,
    compiled: Option<Regex>,
    index: ProjectIndex,
}

impl Default for RootState {
    fn default() -> Self {
        Self {
            head_sha: String::new(),
            diff_hash: 0,
            patterns: Vec::new(),
            compiled: None,
            index: ProjectIndex::default(),
        }
    }
}

/// Per-(root, source_name) pattern cache. We key by root *and* source
/// so two forwarders sharing the same cwd don't stomp on each other's
/// source-tagged patterns.
#[derive(Default)]
pub struct PatternCache {
    inner: Mutex<HashMap<(PathBuf, String), RootState>>,
}

impl PatternCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Recompute patterns for one (root, source) pair. Returns `true`
    /// if the pattern set actually changed (so callers can rescan the
    /// ring) and `false` if nothing moved.
    pub fn recompute(
        &self,
        root: &Path,
        source_name: &str,
    ) -> Result<bool, String> {
        let head = head_sha(root)?;
        let diff = collect_diff(root);
        let dh = quick_hash(&diff);

        let mut guard = self.inner.lock();
        let entry = guard
            .entry((root.to_path_buf(), source_name.to_string()))
            .or_insert_with(RootState::default);

        if entry.head_sha == head && entry.diff_hash == dh && entry.compiled.is_some() {
            return Ok(false);
        }

        entry.index.ensure_fresh(root);

        let touched = touched_files(&diff);
        let touched_abs: HashSet<PathBuf> = touched
            .iter()
            .map(|p| root.join(p))
            .collect();

        let mut patterns: Vec<LogPattern> = Vec::new();

        // Direct
        for tf_rel in &touched {
            let abs = root.join(tf_rel);
            if Lang::from_path(&abs).is_none() {
                continue;
            }
            let Some(calls) = entry.index.log_calls(&abs).cloned() else { continue };
            for call in calls {
                let regex = build_pattern_regex(&call.pieces);
                if regex.is_empty() {
                    continue;
                }
                patterns.push(LogPattern {
                    regex,
                    source: source_name.to_string(),
                    rel_path: tf_rel.clone(),
                    line: call.line,
                    raw_call: call.raw_call,
                    kind: PatternKind::Direct,
                });
            }
        }

        // Indirect (1-hop): for each touched file's module_ids, find
        // referrers; emit log calls in each referrer with via_files.
        let mut via_map: HashMap<PathBuf, Vec<String>> = HashMap::new();
        for tf_rel in &touched {
            let tf_path = Path::new(tf_rel);
            let ids = module_id_candidates(tf_path);
            for id in ids {
                if let Some(refs) = entry.index.referring_files(&id) {
                    for r in refs {
                        if touched_abs.contains(r) {
                            continue;
                        }
                        via_map
                            .entry(r.clone())
                            .or_default()
                            .push(tf_rel.clone());
                    }
                }
            }
        }
        for (ref_path, via_files) in via_map {
            let rel_path = ref_path
                .strip_prefix(root)
                .unwrap_or(&ref_path)
                .to_string_lossy()
                .into_owned();
            let Some(calls) = entry.index.log_calls(&ref_path).cloned() else { continue };
            for call in calls {
                let regex = build_pattern_regex(&call.pieces);
                if regex.is_empty() {
                    continue;
                }
                patterns.push(LogPattern {
                    regex,
                    source: source_name.to_string(),
                    rel_path: rel_path.clone(),
                    line: call.line,
                    raw_call: call.raw_call,
                    kind: PatternKind::Indirect { via_files: via_files.clone() },
                });
            }
        }

        let compiled = compile_combined(&patterns);
        entry.head_sha = head;
        entry.diff_hash = dh;
        entry.patterns = patterns;
        entry.compiled = compiled;
        Ok(true)
    }

    pub fn match_event(
        &self,
        root: &Path,
        source: &str,
        msg: &str,
    ) -> Option<MatchedPattern> {
        let guard = self.inner.lock();
        let entry = guard.get(&(root.to_path_buf(), source.to_string()))?;
        let re = entry.compiled.as_ref()?;
        let caps = re.captures(msg)?;
        for i in 1..caps.len() {
            if caps.get(i).is_some() {
                let p = entry.patterns.get(i - 1)?.clone();
                return Some(MatchedPattern { pattern: p });
            }
        }
        None
    }

    pub fn patterns_for(&self, root: &Path, source: &str) -> Vec<LogPattern> {
        let guard = self.inner.lock();
        guard
            .get(&(root.to_path_buf(), source.to_string()))
            .map(|e| e.patterns.clone())
            .unwrap_or_default()
    }

    pub fn clear_source(&self, root: &Path, source: &str) {
        self.inner.lock().remove(&(root.to_path_buf(), source.to_string()));
    }
}

#[derive(Clone, Debug)]
pub struct MatchedPattern {
    pub pattern: LogPattern,
}

fn compile_combined(patterns: &[LogPattern]) -> Option<Regex> {
    if patterns.is_empty() {
        return None;
    }
    let alt: Vec<String> = patterns
        .iter()
        .map(|p| format!("({})", p.regex))
        .collect();
    let combined = format!("(?i){}", alt.join("|"));
    Regex::new(&combined).ok()
}

fn quick_hash(s: &str) -> u64 {
    // Cheap, stable, non-cryptographic. Used only to detect change.
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

// --------------------------------------------------------------------
// RelevanceEngine: per-event consideration + emit debounce
// --------------------------------------------------------------------

#[derive(Default)]
struct EngineState {
    ids: HashSet<u64>,
    /// Keyed by (source, rel_path, line) so per-site emitted_count is
    /// accurate even when the same path appears from multiple sources.
    sites: HashMap<(String, String, u32), SiteAccum>,
    /// Set true when state changed since last emit; the debounce task
    /// reads and clears this.
    dirty: bool,
}

#[derive(Clone, Debug)]
struct SiteAccum {
    source: String,
    rel_path: String,
    line: u32,
    raw_call: String,
    emitted_count: u64,
    kind: PatternKind,
}

pub struct RelevanceEngine {
    source_roots: Arc<SourceRoots>,
    patterns: Arc<PatternCache>,
    ring: Arc<Ring>,
    state: Mutex<EngineState>,
    emit: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
}

impl RelevanceEngine {
    pub fn new(
        source_roots: Arc<SourceRoots>,
        patterns: Arc<PatternCache>,
        ring: Arc<Ring>,
    ) -> Self {
        Self {
            source_roots,
            patterns,
            ring,
            state: Mutex::new(EngineState::default()),
            emit: Mutex::new(None),
        }
    }

    pub fn set_emit<F: Fn() + Send + Sync + 'static>(&self, f: F) {
        *self.emit.lock() = Some(Box::new(f));
    }

    fn mark_dirty(&self) {
        self.state.lock().dirty = true;
        if let Some(f) = self.emit.lock().as_ref() {
            f();
        }
    }

    /// Walk a single event and update state if its msg matches.
    pub fn consider(&self, ev: &Event) {
        let Some(root) = self.source_roots.get(&ev.source) else { return };
        // Lazily recompute on first event if we have no compiled regex.
        // The 15s tick takes the steady-state path.
        if self.patterns.patterns_for(&root, &ev.source).is_empty() {
            let _ = self.patterns.recompute(&root, &ev.source);
        }
        let Some(matched) = self
            .patterns
            .match_event(&root, &ev.source, &ev.msg)
            .or_else(|| self.patterns.match_event(&root, &ev.source, &ev.raw))
        else {
            return;
        };
        let key = (ev.source.clone(), matched.pattern.rel_path.clone(), matched.pattern.line);
        let mut state = self.state.lock();
        let fresh_id = state.ids.insert(ev.id);
        let acc = state.sites.entry(key).or_insert_with(|| SiteAccum {
            source: matched.pattern.source.clone(),
            rel_path: matched.pattern.rel_path.clone(),
            line: matched.pattern.line,
            raw_call: matched.pattern.raw_call.clone(),
            emitted_count: 0,
            kind: matched.pattern.kind.clone(),
        });
        acc.emitted_count += 1;
        if fresh_id {
            state.dirty = true;
            drop(state);
            if let Some(f) = self.emit.lock().as_ref() {
                f();
            }
        }
    }

    /// Drop everything tagged with `source` and re-queue all events
    /// from that source for re-consideration. Called after a pattern
    /// recompute changes the active pattern set.
    pub fn clear_source_and_requeue(&self, source: &str) {
        {
            let mut s = self.state.lock();
            s.ids.retain(|id| {
                // ids are not source-tagged; clear all and let consider
                // re-add. (Slightly more aggressive than strictly needed
                // but keeps state coherent across sources.)
                let _ = id;
                false
            });
            s.sites.retain(|(src, _, _), _| src != source);
            s.dirty = true;
        }
        self.mark_dirty();
    }

    /// Force a recompute now (e.g. on window focus, or the 15s tick).
    /// Only rescans the ring when at least one source's patterns
    /// actually changed.
    pub fn force_recompute_all(&self) {
        let sources = self.source_roots.snapshot();
        let mut any_changed = false;
        for (name, root) in sources {
            match self.patterns.recompute(&root, &name) {
                Ok(true) => any_changed = true,
                Ok(false) => {}
                Err(_) => {}
            }
        }
        if any_changed {
            self.rescan_ring();
            self.mark_dirty();
        }
    }

    pub fn rescan_ring(&self) {
        // Replace state with a fresh scan over the entire ring under
        // the current patterns. Cheap: combined regex test per event.
        let events = self.ring.snapshot_since(0, usize::MAX);
        let mut new_state = EngineState::default();
        let cache = self.patterns.clone();
        for ev in &events {
            let Some(root) = self.source_roots.get(&ev.source) else { continue };
            let Some(matched) = cache
                .match_event(&root, &ev.source, &ev.msg)
                .or_else(|| cache.match_event(&root, &ev.source, &ev.raw))
            else {
                continue;
            };
            new_state.ids.insert(ev.id);
            let key = (
                ev.source.clone(),
                matched.pattern.rel_path.clone(),
                matched.pattern.line,
            );
            let acc = new_state.sites.entry(key).or_insert_with(|| SiteAccum {
                source: matched.pattern.source.clone(),
                rel_path: matched.pattern.rel_path.clone(),
                line: matched.pattern.line,
                raw_call: matched.pattern.raw_call.clone(),
                emitted_count: 0,
                kind: matched.pattern.kind.clone(),
            });
            acc.emitted_count += 1;
        }
        new_state.dirty = true;
        *self.state.lock() = new_state;
    }

    /// IPC: take the current state as a wire snapshot.
    pub fn snapshot(&self) -> RelevanceSnapshot {
        let state = self.state.lock();
        let mut ids: Vec<u64> = state.ids.iter().copied().collect();
        ids.sort_unstable();
        let mut sites: Vec<RelevanceSite> = state
            .sites
            .values()
            .map(|s| {
                let snippet = read_snippet(&self.source_roots, &s.source, &s.rel_path, s.line);
                let abs_path = self
                    .source_roots
                    .get(&s.source)
                    .map(|r| r.join(&s.rel_path).to_string_lossy().into_owned())
                    .unwrap_or_else(|| s.rel_path.clone());
                RelevanceSite {
                    source: s.source.clone(),
                    rel_path: s.rel_path.clone(),
                    abs_path,
                    line: s.line,
                    raw_call: s.raw_call.clone(),
                    snippet,
                    emitted_count: s.emitted_count,
                    kind: s.kind.clone(),
                }
            })
            .collect();
        sites.sort_by(|a, b| {
            a.source
                .cmp(&b.source)
                .then(a.rel_path.cmp(&b.rel_path))
                .then(a.line.cmp(&b.line))
        });
        RelevanceSnapshot { ids, sites }
    }

    pub fn clear_all(&self) {
        *self.state.lock() = EngineState::default();
        self.mark_dirty();
    }
}

fn read_snippet(
    roots: &SourceRoots,
    source: &str,
    rel_path: &str,
    line: u32,
) -> Vec<CodeLine> {
    let Some(root) = roots.get(source) else { return Vec::new() };
    let abs = root.join(rel_path);
    let Ok(content) = read_file(&abs) else { return Vec::new() };
    let lo = line.saturating_sub(1).max(1);
    let hi = line.saturating_add(1);
    let mut out = Vec::new();
    for (i, l) in content.lines().enumerate() {
        let n = (i as u32) + 1;
        if n < lo {
            continue;
        }
        if n > hi {
            break;
        }
        out.push(CodeLine { line: n, text: l.to_string() });
    }
    out
}

pub fn recompute_interval() -> std::time::Duration {
    std::time::Duration::from_secs(RECOMPUTE_INTERVAL_SECS)
}

pub fn emit_debounce() -> std::time::Duration {
    std::time::Duration::from_millis(EMIT_DEBOUNCE_MS)
}

// --------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn build_call_regex(src: &str) -> String {
        let calls = extract_log_calls(src);
        assert_eq!(calls.len(), 1, "expected exactly one log call in {src:?}");
        build_pattern_regex(&calls[0].pieces)
    }

    fn check_match(call_src: &str, msg: &str) -> bool {
        let pat = build_call_regex(call_src);
        if pat.is_empty() {
            return false;
        }
        let re = Regex::new(&format!("(?i){pat}")).unwrap();
        re.is_match(msg)
    }

    #[test]
    fn console_log_concat_matches_loaded_7_items() {
        assert!(check_match(
            r#"console.log("loaded", count, "items")"#,
            "loaded 7 items"
        ));
    }

    #[test]
    fn rust_tracing_format_matches_loaded_7_items() {
        assert!(check_match(
            r#"tracing::info!("loaded {} items", n)"#,
            "loaded 7 items"
        ));
    }

    #[test]
    fn js_template_literal_matches_loaded_7_items() {
        assert!(check_match(
            r#"console.log(`loaded ${n} items`)"#,
            "loaded 7 items"
        ));
    }

    #[test]
    fn printf_percent_s_extracts_pieces() {
        assert!(check_match(
            r#"printf("user %s signed in", name)"#,
            "user alice signed in"
        ));
    }

    #[test]
    fn no_string_literal_yields_no_pattern() {
        let calls = extract_log_calls("log.info(err)");
        assert!(calls.is_empty() || calls[0].pieces.is_empty());
    }

    #[test]
    fn nested_parens_in_args_dont_break_balance() {
        assert!(check_match(
            r#"log.info("got", req.url(), "for", user.id())"#,
            "got https://x for 42"
        ));
    }

    #[test]
    fn escaped_quote_inside_literal() {
        assert!(check_match(
            r#"console.log("said \"hello\" to", user)"#,
            r#"said "hello" to alice"#
        ));
    }

    #[test]
    fn parse_unified_diff_single_file_addition() {
        let diff = "--- a/foo.ts\n+++ b/foo.ts\n@@ -10,0 +11,2 @@\n+console.log(\"x\");\n+console.log(\"y\");\n";
        let hits = parse_unified_diff(diff);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].line_no, 11);
        assert_eq!(hits[1].line_no, 12);
        assert_eq!(hits[0].rel_path, "foo.ts");
    }

    #[test]
    fn parse_unified_diff_skips_deletion_only_hunks() {
        let diff = "--- a/foo.ts\n+++ b/foo.ts\n@@ -10,1 +10,0 @@\n-console.log(\"x\");\n";
        let hits = parse_unified_diff(diff);
        assert!(hits.is_empty());
    }

    #[test]
    fn touched_files_collects_distinct_paths() {
        let diff = "--- a/a.ts\n+++ b/a.ts\n@@ -1,0 +2,1 @@\n+x\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1,0 +2,1 @@\n+y\n";
        let files = touched_files(diff);
        assert!(files.contains("a.ts"));
        assert!(files.contains("b.ts"));
    }

    #[test]
    fn module_id_ts_index_uses_parent_dir() {
        let ids = module_id_candidates(Path::new("processors/index.ts"));
        assert_eq!(ids, vec!["processors".to_string()]);
    }

    #[test]
    fn module_id_ts_uses_stem() {
        let ids = module_id_candidates(Path::new("processors/MyProcessor.ts"));
        assert_eq!(ids, vec!["MyProcessor".to_string()]);
    }

    #[test]
    fn module_id_rust_mod_rs_uses_parent() {
        let ids = module_id_candidates(Path::new("processors/mod.rs"));
        assert_eq!(ids, vec!["processors".to_string()]);
    }

    #[test]
    fn module_id_rust_uses_stem() {
        let ids = module_id_candidates(Path::new("processors/my_processor.rs"));
        assert_eq!(ids, vec!["my_processor".to_string()]);
    }

    #[test]
    fn module_id_java_uses_class_name() {
        let ids = module_id_candidates(Path::new("com/example/MyProcessor.java"));
        assert_eq!(ids, vec!["MyProcessor".to_string()]);
    }

    #[test]
    fn extract_imports_ts_finds_module_ids() {
        let src = r#"
import { Foo } from "./Foo";
import Bar from "../Bar";
const Baz = require("./Baz");
import("./Qux");
"#;
        let ids = extract_imports(src, Lang::TsJs);
        assert!(ids.contains("Foo"));
        assert!(ids.contains("Bar"));
        assert!(ids.contains("Baz"));
        assert!(ids.contains("Qux"));
    }

    #[test]
    fn extract_imports_rust_finds_last_segment() {
        let src = r#"
use crate::processors::my_processor;
use super::utils;
mod sub_mod;
"#;
        let ids = extract_imports(src, Lang::Rust);
        assert!(ids.contains("my_processor"));
        assert!(ids.contains("utils"));
        assert!(ids.contains("sub_mod"));
    }

    #[test]
    fn extract_imports_java_finds_class() {
        let src = r#"
package com.example;
import com.example.processors.MyProcessor;
import static java.util.Map.entry;
"#;
        let ids = extract_imports(src, Lang::Java);
        assert!(ids.contains("MyProcessor"));
        assert!(ids.contains("entry"));
    }

    #[test]
    fn compile_combined_matches_multiple_patterns() {
        let patterns = vec![
            LogPattern {
                regex: "loaded.*?items".into(),
                source: "s".into(),
                rel_path: "a.ts".into(),
                line: 1,
                raw_call: "".into(),
                kind: PatternKind::Direct,
            },
            LogPattern {
                regex: "connection.*?refused".into(),
                source: "s".into(),
                rel_path: "b.ts".into(),
                line: 1,
                raw_call: "".into(),
                kind: PatternKind::Direct,
            },
        ];
        let re = compile_combined(&patterns).unwrap();
        let caps = re.captures("loaded 7 items").unwrap();
        assert!(caps.get(1).is_some());
        assert!(caps.get(2).is_none());

        let caps2 = re.captures("connection refused").unwrap();
        assert!(caps2.get(2).is_some());
    }
}
