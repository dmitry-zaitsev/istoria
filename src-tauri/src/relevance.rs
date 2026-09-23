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

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::future::Future;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, OnceLock,
};
use std::time::{Duration, Instant, SystemTime};

use parking_lot::Mutex;
use regex::Regex;
use serde::Serialize;
use tokio::sync::watch;

use crate::event::Event;
use crate::ring::Ring;

const SCAN_FILE_MAX_BYTES: u64 = 1_000_000;
const SCAN_DIR_BUDGET: usize = 20_000;
const RECOMPUTE_INTERVAL_SECS: u64 = 15;
const EMIT_DEBOUNCE_MS: u64 = 100;

async fn refresh_loop<F, Work>(
    mut requests: watch::Receiver<()>,
    debounce: Duration,
    poll: Duration,
    mut refresh: F,
) where
    F: FnMut() -> Work,
    Work: Future<Output = ()>,
{
    requests.mark_changed();
    loop {
        tokio::select! {
            result = requests.changed() => { if result.is_err() { return; } },
            _ = tokio::time::sleep(poll) => {},
        }
        // A fixed window avoids starving analysis under a continuous stream
        // of requests. Everything arriving in the window shares one refresh.
        tokio::time::sleep(debounce).await;
        requests.borrow_and_update();
        refresh().await;
    }
}

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

pub struct SourceRoots {
    inner: Mutex<HashMap<String, PathBuf>>,
    refresh: watch::Sender<()>,
}

impl Default for SourceRoots {
    fn default() -> Self {
        Self { inner: Mutex::new(HashMap::new()), refresh: watch::channel(()).0 }
    }
}

impl SourceRoots {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, source: &str, cwd: PathBuf) {
        let cwd = cwd.canonicalize().unwrap_or(cwd);
        // Git reports paths relative to the worktree. Normalize subdirectory
        // producers to that root too, without spawning a discovery command.
        let root = cwd.ancestors().find(|p| p.join(".git").exists())
            .unwrap_or(&cwd).to_path_buf();
        self.inner.lock().insert(source.to_string(), root);
        self.refresh.send_replace(());
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
    /// Subset of `imports` re-exported by this file (`export ... from`
    /// in TS/JS, `pub use` in Rust). Used for barrel transparency: if
    /// a file re-exports a touched module, treat the file itself as a
    /// stand-in target so its callers count as indirect referrers.
    re_exports: HashSet<String>,
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
            let re_exports = extract_re_exports(&content, lang);
            let log_calls = extract_log_calls(&content);
            self.replace_file(
                path,
                FileEntry { mtime, lang, imports, re_exports, log_calls },
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

/// Fixed-point walk: any file whose `re_exports` overlap `id_origin`
/// inherits its origins under the barrel's own module-id, so callers
/// of the barrel become candidate referrers of the original touched
/// file. Capped at 3 iterations to bound work on chained barrels;
/// duplicates are filtered so a cycle in re-exports terminates.
fn expand_through_barrels(
    id_origin: &mut HashMap<String, Vec<String>>,
    index: &ProjectIndex,
    root: &Path,
) {
    for _ in 0..3 {
        let mut additions: Vec<(String, String)> = Vec::new();
        for (path, entry) in &index.files {
            if entry.re_exports.is_empty() {
                continue;
            }
            let mut inherited: Vec<String> = Vec::new();
            for rex in &entry.re_exports {
                if let Some(origins) = id_origin.get(rex) {
                    for o in origins {
                        if !inherited.contains(o) {
                            inherited.push(o.clone());
                        }
                    }
                }
            }
            if inherited.is_empty() {
                continue;
            }
            let rel = path.strip_prefix(root).unwrap_or(path);
            for mid in module_id_candidates(rel) {
                for o in &inherited {
                    additions.push((mid.clone(), o.clone()));
                }
            }
        }
        let mut grew = false;
        for (id, origin) in additions {
            let v = id_origin.entry(id).or_default();
            if !v.contains(&origin) {
                v.push(origin);
                grew = true;
            }
        }
        if !grew {
            break;
        }
    }
}

// --------------------------------------------------------------------
// Import line extraction (per-language)
// --------------------------------------------------------------------

fn import_re_ts() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        // Alternatives:
        //   1) `from "x"`             — named/default/namespace imports + re-exports
        //   2) `require("x")`         — CommonJS
        //   3) `import("x")`          — dynamic ESM
        //   4) `^import "x"`          — side-effect imports (multiline anchor)
        Regex::new(
            r#"(?m)(?:from\s+["']([^"']+)["']|require\(\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']|^\s*import\s+["']([^"']+)["'])"#,
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

fn import_grouped_re_rust() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        // `use path::{a, b as c, d::e};` — also matches `pub use ...::{...}`.
        Regex::new(r"\b(?:pub(?:\s*\([^)]+\))?\s+)?use\s+([\w:]+)::\{([^}]+)\}").unwrap()
    })
}

fn import_re_java() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"import\s+(?:static\s+)?([\w.]+)\s*;").unwrap())
}

fn re_export_re_ts() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        // `export * from "x"`, `export * as ns from "x"`, `export { a, b } from "x"`,
        // `export type { a } from "x"`, `export type * from "x"`.
        Regex::new(
            r#"(?m)^\s*export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+["']([^"']+)["']"#,
        )
        .unwrap()
    })
}

fn re_export_re_rust() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\bpub(?:\s*\([^)]+\))?\s+use\s+([\w:]+)").unwrap())
}

fn re_export_grouped_re_rust() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"\bpub(?:\s*\([^)]+\))?\s+use\s+([\w:]+)::\{([^}]+)\}").unwrap()
    })
}

fn extract_imports(content: &str, lang: Lang) -> HashSet<String> {
    let mut out = HashSet::new();
    match lang {
        Lang::TsJs => {
            for cap in import_re_ts().captures_iter(content) {
                for i in 1..=4 {
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
            for cap in import_grouped_re_rust().captures_iter(content) {
                let (Some(path_m), Some(body_m)) = (cap.get(1), cap.get(2)) else { continue };
                for item in body_m.as_str().split(',') {
                    let item = item.trim();
                    if item.is_empty() {
                        continue;
                    }
                    let head = item.split_whitespace().next().unwrap_or("");
                    if head == "self" {
                        if let Some(last) = path_m.as_str().rsplit("::").next() {
                            if !last.is_empty() && last != "crate" && last != "super" {
                                out.insert(last.to_string());
                            }
                        }
                        continue;
                    }
                    if let Some(last) = head.rsplit("::").next() {
                        let id = last
                            .trim_matches(|c: char| !c.is_alphanumeric() && c != '_');
                        if !id.is_empty() && id != "*" && id != "super" {
                            out.insert(id.to_string());
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

/// Module ids re-exported by this file. Empty for non-barrel files and
/// for languages without re-export syntax (Java).
fn extract_re_exports(content: &str, lang: Lang) -> HashSet<String> {
    let mut out = HashSet::new();
    match lang {
        Lang::TsJs => {
            for cap in re_export_re_ts().captures_iter(content) {
                if let Some(m) = cap.get(1) {
                    if let Some(id) = ts_module_id_from_path(m.as_str()) {
                        out.insert(id);
                    }
                }
            }
        }
        Lang::Rust => {
            for cap in re_export_re_rust().captures_iter(content) {
                if let Some(m) = cap.get(1) {
                    if let Some(last) = m.as_str().rsplit("::").next() {
                        if !last.is_empty()
                            && last != "self"
                            && last != "super"
                            && last != "crate"
                        {
                            out.insert(last.to_string());
                        }
                    }
                }
            }
            for cap in re_export_grouped_re_rust().captures_iter(content) {
                let (Some(path_m), Some(body_m)) = (cap.get(1), cap.get(2)) else { continue };
                for item in body_m.as_str().split(',') {
                    let item = item.trim();
                    if item.is_empty() {
                        continue;
                    }
                    let head = item.split_whitespace().next().unwrap_or("");
                    if head == "self" {
                        if let Some(last) = path_m.as_str().rsplit("::").next() {
                            if !last.is_empty() && last != "crate" && last != "super" {
                                out.insert(last.to_string());
                            }
                        }
                        continue;
                    }
                    if let Some(last) = head.rsplit("::").next() {
                        let id = last
                            .trim_matches(|c: char| !c.is_alphanumeric() && c != '_');
                        if !id.is_empty() && id != "*" && id != "super" {
                            out.insert(id.to_string());
                        }
                    }
                }
            }
        }
        Lang::Java => {}
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
            r"(?i)\b(?:console\.\w+|log\.\w+|logger\.\w+|tracing::\w+!|println!|eprintln!|info!|warn!|error!|debug!|trace!|logging\.\w+|fmt\.Println|fmt\.Printf|slog\.\w+|printf|fprintf|System\.out\.print(?:ln|f)?)\s*\(",
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
    let out = crate::git::run(root, args)
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
    match crate::git::run(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
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
    let committed = run_git(root, &["diff", "--no-ext-diff", "--no-textconv", "--unified=0", &upstream])
        .or_else(|_| run_git(root, &["diff", "--no-ext-diff", "--no-textconv", "--unified=0", &local]))
        .unwrap_or_default();
    let uncommitted = run_git(root, &["diff", "--no-ext-diff", "--no-textconv", "--unified=0", "HEAD"]).unwrap_or_default();
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

/// Analysis is shared per worktree. Source attribution is applied when matching
/// an event, so multiple forwarders never duplicate Git or filesystem work.
#[derive(Default)]
pub struct PatternCache {
    inner: Mutex<HashMap<PathBuf, RootState>>,
}

impl PatternCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Recompute patterns for one worktree. Only the refresh worker calls this.
    /// Returns `true`
    /// if the pattern set actually changed (so callers can rescan the
    /// ring) and `false` if nothing moved.
    fn recompute(
        &self,
        root: &Path,
    ) -> Result<bool, String> {
        let head = head_sha(root)?;
        let diff = collect_diff(root);
        let dh = quick_hash(&diff);

        self.update(root, head, &diff, dh)
    }

    fn update(&self, root: &Path, head: String, diff: &str, dh: u64) -> Result<bool, String> {
        let mut guard = self.inner.lock();
        let entry = guard.entry(root.to_path_buf()).or_insert_with(RootState::default);

        if entry.head_sha == head && entry.diff_hash == dh {
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
                    source: String::new(),
                    rel_path: tf_rel.clone(),
                    line: call.line,
                    raw_call: call.raw_call,
                    kind: PatternKind::Direct,
                });
            }
        }

        // Indirect (1-hop): for each touched file's module_ids, find
        // referrers; emit log calls in each referrer with via_files.
        // Barrel transparency: a file with `export ... from "T"` (TS)
        // or `pub use ...::T` (Rust) inherits T's origins, so its own
        // module-id is folded into the lookup. via_files keeps pointing
        // at the actually-touched file so the user sees the real cause,
        // not the intermediate barrel.
        let mut id_origin: HashMap<String, Vec<String>> = HashMap::new();
        for tf_rel in &touched {
            let tf_path = Path::new(tf_rel);
            for id in module_id_candidates(tf_path) {
                let v = id_origin.entry(id).or_default();
                if !v.contains(tf_rel) {
                    v.push(tf_rel.clone());
                }
            }
        }
        expand_through_barrels(&mut id_origin, &entry.index, root);

        let mut via_map: HashMap<PathBuf, Vec<String>> = HashMap::new();
        for (id, origins) in &id_origin {
            let Some(refs) = entry.index.referring_files(id) else { continue };
            for r in refs {
                if touched_abs.contains(r) {
                    continue;
                }
                let v = via_map.entry(r.clone()).or_default();
                for o in origins {
                    if !v.contains(o) {
                        v.push(o.clone());
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
                    source: String::new(),
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
        let entry = guard.get(root)?;
        let re = entry.compiled.as_ref()?;
        let caps = re.captures(msg)?;
        for i in 1..caps.len() {
            if caps.get(i).is_some() {
                let mut p = entry.patterns.get(i - 1)?.clone();
                p.source = source.to_string();
                return Some(MatchedPattern { pattern: p });
            }
        }
        None
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
    // Ordered by event ID so eviction visits only expired matches, rather
    // than scanning the entire cache on every new log line. Site keys are
    // shared: each retained event stores an Arc, not another pair of strings.
    ids: BTreeMap<u64, Arc<(String, String, u32)>>,
    /// Keyed by (source, rel_path, line) so per-site emitted_count is
    /// accurate even when the same path appears from multiple sources.
    sites: HashMap<Arc<(String, String, u32)>, SiteAccum>,
    /// Set true when state changed since last emit; the debounce task
    /// reads and clears this.
    dirty: bool,
}

impl EngineState {
    fn record(&mut self, id: u64, pattern: LogPattern) -> bool {
        if self.ids.contains_key(&id) {
            return false;
        }
        let key = (
            pattern.source.clone(),
            pattern.rel_path.clone(),
            pattern.line,
        );
        let key = self
            .sites
            .get_key_value(&key)
            .map(|(key, _)| Arc::clone(key))
            .unwrap_or_else(|| Arc::new(key));
        let acc = self
            .sites
            .entry(Arc::clone(&key))
            .or_insert_with(|| SiteAccum {
                source: pattern.source,
                rel_path: pattern.rel_path,
                line: pattern.line,
                raw_call: pattern.raw_call,
                emitted_count: 0,
                kind: pattern.kind,
            });
        acc.emitted_count += 1;
        self.ids.insert(id, key);
        self.dirty = true;
        true
    }

    /// Keep exactly the matches that can still belong to the ring. No live
    /// minimum means the ring was cleared, so all matches must be discarded.
    fn prune(&mut self, min_id: Option<u64>) -> bool {
        let mut changed = false;
        while self
            .ids
            .first_key_value()
            .is_some_and(|(&id, _)| min_id.map_or(true, |min| id < min))
        {
            let (_, key) = self.ids.pop_first().expect("first entry exists");
            let remove_site = if let Some(site) = self.sites.get_mut(&key) {
                site.emitted_count -= 1;
                site.emitted_count == 0
            } else {
                false
            };
            if remove_site {
                self.sites.remove(&key);
            }
            changed = true;
        }
        self.dirty |= changed;
        changed
    }
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
    worker_started: AtomicBool,
    // A rescan and an incoming-event update must not overwrite one another.
    scan: Mutex<()>,
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
            worker_started: AtomicBool::new(false),
            scan: Mutex::new(()),
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
        let _scan = self.scan.lock();
        let mut state = self.state.lock();
        let min_id = self.ring.min_id();
        // Unmatched logs and unregistered sources evict old matches too.
        let mut changed = state.prune(min_id);
        // A queued batch may have been evicted or cleared while waiting for
        // the worker. It must never restore IDs that have left the ring.
        if min_id.is_some_and(|min| ev.id >= min) {
            if let Some(root) = self.source_roots.get(&ev.source) {
                // Matching is strictly in-memory. Git belongs to the worker.
                if let Some(matched) = self
                    .patterns
                    .match_event(&root, &ev.source, &ev.msg)
                    .or_else(|| self.patterns.match_event(&root, &ev.source, &ev.raw))
                {
                    changed |= state.record(ev.id, matched.pattern);
                }
            }
        }
        drop(state);
        if changed {
            self.mark_dirty();
        }
    }

    /// Coalesce refresh requests without spawning or queueing individual jobs.
    pub fn request_refresh(&self) {
        self.source_roots.refresh.send_replace(());
    }

    /// One worker for both shells. Debounce bursts for five seconds and await
    /// each analysis before accepting more work. Requests during an analysis
    /// occupy one watch-channel slot, regardless of how many callers send them.
    pub async fn run_refresh_worker(self: Arc<Self>) {
        if self.worker_started.swap(true, Ordering::SeqCst) {
            return;
        }
        refresh_loop(
            self.source_roots.refresh.subscribe(),
            crate::git::DEBOUNCE,
            recompute_interval(),
            || {
                let engine = Arc::clone(&self);
                async move {
                    let _ = tokio::task::spawn_blocking(move || engine.recompute_all()).await;
                }
            },
        )
        .await;
    }

    fn recompute_all(&self) {
        let sources = self.source_roots.snapshot();
        // Historical registrations with no retained logs need no analysis.
        // This also makes clearing a session stop obsolete background work.
        let retained = self.ring.retained_sources();
        let roots: HashSet<_> = sources
            .into_iter()
            .filter(|(source, _)| retained.contains(source))
            .map(|(_, root)| root)
            .collect();
        self.patterns
            .inner
            .lock()
            .retain(|root, _| roots.contains(root));
        let mut any_changed = false;
        for root in roots {
            match self.patterns.recompute(&root) {
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
        let _scan = self.scan.lock();
        // Replace state with a fresh scan over the entire ring under
        // the current patterns. Cheap: combined regex test per event.
        let events = self.ring.snapshot_since(0, usize::MAX);
        let mut new_state = EngineState::default();
        let cache = self.patterns.clone();
        for ev in &events {
            let Some(root) = self.source_roots.get(&ev.source) else {
                continue;
            };
            let Some(matched) = cache
                .match_event(&root, &ev.source, &ev.msg)
                .or_else(|| cache.match_event(&root, &ev.source, &ev.raw))
            else {
                continue;
            };
            new_state.record(ev.id, matched.pattern);
        }
        // Ingestion continues during the scan; don't publish matches from
        // the cloned snapshot that have since left the ring.
        new_state.prune(self.ring.min_id());
        new_state.dirty = true;
        *self.state.lock() = new_state;
    }

    /// IPC: take the current state as a wire snapshot.
    pub fn snapshot(&self) -> RelevanceSnapshot {
        let (ids, sites, pruned) = {
            let mut state = self.state.lock();
            let pruned = state.prune(self.ring.min_id());
            let ids = state.ids.keys().copied().collect();
            let sites: Vec<_> = state.sites.values().cloned().collect();
            (ids, sites, pruned)
        };
        if pruned {
            self.mark_dirty();
        }
        let mut sites: Vec<RelevanceSite> = sites
            .iter()
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
        let _scan = self.scan.lock();
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

    #[tokio::test(start_paused = true)]
    async fn bursts_coalesce_and_slow_refreshes_never_overlap() {
        use std::sync::atomic::AtomicUsize;
        let (tx, rx) = watch::channel(());
        let calls = Arc::new(AtomicUsize::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let calls2 = calls.clone();
        let active2 = active.clone();
        let worker = tokio::spawn(refresh_loop(
            rx,
            Duration::from_secs(5),
            Duration::from_secs(15),
            move || {
                let calls = calls2.clone();
                let active = active2.clone();
                async move {
                    assert_eq!(active.fetch_add(1, Ordering::SeqCst), 0);
                    calls.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_secs(10)).await;
                    active.fetch_sub(1, Ordering::SeqCst);
                }
            },
        ));
        tokio::task::yield_now().await;
        for _ in 0..1000 {
            tx.send_replace(());
        }
        tokio::time::advance(Duration::from_secs(4)).await;
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        for _ in 0..1000 {
            tx.send_replace(());
        }
        tokio::time::advance(Duration::from_secs(9)).await;
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(4)).await;
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        worker.abort();
    }

    #[test]
    fn empty_analysis_is_cached_and_event_ingestion_never_initializes_it() {
        let root = std::env::temp_dir().join("istoria-nonexistent-relevance-root");
        let roots = Arc::new(SourceRoots::new());
        roots.register("source", root.clone());
        let cache = Arc::new(PatternCache::new());
        let engine = RelevanceEngine::new(roots, cache.clone(), Arc::new(Ring::new(100)));
        for id in 1..=1000 {
            engine.consider(&Event::from_plain_line(id, "source", "anything".into()));
        }
        assert!(cache.inner.lock().is_empty());
        assert!(cache
            .update(&root, "head".into(), "", quick_hash(""))
            .unwrap());
        assert!(!cache
            .update(&root, "head".into(), "", quick_hash(""))
            .unwrap());
        assert!(cache.inner.lock()[&root].patterns.is_empty());
    }

    #[test]
    fn shared_patterns_keep_source_attribution_and_rescans_do_not_double_count() {
        let root = std::env::temp_dir().canonicalize().unwrap();
        let roots = Arc::new(SourceRoots::new());
        roots.register("api", root.clone());
        roots.register("worker", root.clone());
        let cache = Arc::new(PatternCache::new());
        let pattern = LogPattern {
            regex: "request complete".into(),
            source: String::new(),
            rel_path: "app.ts".into(),
            line: 1,
            raw_call: String::new(),
            kind: PatternKind::Direct,
        };
        cache.inner.lock().insert(
            root,
            RootState {
                compiled: compile_combined(std::slice::from_ref(&pattern)),
                patterns: vec![pattern],
                ..RootState::default()
            },
        );
        let ring = Arc::new(Ring::new(100));
        for source in ["api", "worker"] {
            ring.append(Event::from_plain_line(0, source, "request complete".into()));
        }
        let engine = RelevanceEngine::new(roots, cache.clone(), ring.clone());
        engine.rescan_ring();
        for event in ring.snapshot_since(0, 100) {
            engine.consider(&event);
        }
        let snapshot = engine.snapshot();
        assert_eq!(snapshot.ids, vec![1, 2]);
        assert_eq!(snapshot.sites.len(), 2);
        assert_eq!(snapshot.sites[0].source, "api");
        assert_eq!(snapshot.sites[1].source, "worker");
        assert!(snapshot.sites.iter().all(|site| site.emitted_count == 1));
        assert_eq!(cache.inner.lock().len(), 1);
        ring.clear();
        engine.clear_all();
        engine.recompute_all(); // No retained events => no Git and no cache.
        assert!(engine.snapshot().ids.is_empty());
        assert!(cache.inner.lock().is_empty());
    }

    fn retention_engine(capacity: usize) -> (Arc<Ring>, RelevanceEngine) {
        let root = std::env::temp_dir().canonicalize().unwrap();
        let roots = Arc::new(SourceRoots::new());
        for source in ["api", "worker"] {
            roots.register(source, root.clone());
        }
        let pattern = LogPattern {
            regex: "request complete".into(),
            source: String::new(),
            rel_path: "app.rs".into(),
            line: 1,
            raw_call: String::new(),
            kind: PatternKind::Direct,
        };
        let cache = Arc::new(PatternCache::new());
        cache.inner.lock().insert(
            root,
            RootState {
                compiled: compile_combined(std::slice::from_ref(&pattern)),
                patterns: vec![pattern],
                ..RootState::default()
            },
        );
        let ring = Arc::new(Ring::new(capacity));
        let engine = RelevanceEngine::new(roots, cache, ring.clone());
        (ring, engine)
    }

    fn append_and_consider(ring: &Ring, engine: &RelevanceEngine, source: &str, msg: &str) {
        ring.append(Event::from_plain_line(0, source, msg.into()));
        engine.consider(&ring.snapshot(1, None)[0]);
    }

    #[test]
    fn eviction_decrements_site_counts_even_for_unmatched_and_unknown_sources() {
        let (ring, engine) = retention_engine(3);
        let emitted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let emitted2 = emitted.clone();
        engine.set_emit(move || {
            emitted2.fetch_add(1, Ordering::SeqCst);
        });
        for source in ["api", "worker", "api"] {
            append_and_consider(&ring, &engine, source, "request complete");
        }
        append_and_consider(&ring, &engine, "api", "unrelated");
        let snap = engine.snapshot();
        assert_eq!(snap.ids, vec![2, 3]);
        assert_eq!(snap.sites.len(), 2);
        assert!(snap.sites.iter().all(|site| site.emitted_count == 1));
        append_and_consider(&ring, &engine, "browser", "unrelated");
        let snap = engine.snapshot();
        assert_eq!(snap.ids, vec![3]);
        assert_eq!(snap.sites.len(), 1);
        assert_eq!(snap.sites[0].source, "api");
        append_and_consider(&ring, &engine, "browser", "unrelated");
        let snap = engine.snapshot();
        assert!(snap.ids.is_empty());
        assert!(snap.sites.is_empty());
        assert_eq!(emitted.load(Ordering::SeqCst), 6);
    }

    #[test]
    fn snapshot_prunes_evictions_and_delayed_events_cannot_restore_them() {
        let (ring, engine) = retention_engine(2);
        append_and_consider(&ring, &engine, "api", "request complete");
        let delayed = ring.snapshot(1, None)[0].clone();
        // Simulate ingestion outpacing the relevance worker.
        for _ in 0..2 {
            ring.append(Event::from_plain_line(0, "browser", "unrelated".into()));
        }
        let snap = engine.snapshot();
        assert!(snap.ids.is_empty());
        assert!(snap.sites.is_empty());
        engine.consider(&delayed);
        assert!(engine.state.lock().ids.is_empty());
        assert!(engine.state.lock().sites.is_empty());
    }

    #[test]
    fn relevance_storage_stays_bounded_without_snapshot_requests_or_git_refreshes() {
        let (ring, engine) = retention_engine(128);
        for id in 0..10_000 {
            let source = if id % 2 == 0 { "api" } else { "worker" };
            append_and_consider(&ring, &engine, source, "request complete");
            assert!(engine.state.lock().ids.len() <= ring.capacity());
        }
        let snap = engine.snapshot();
        assert_eq!(snap.ids.len(), 128);
        assert_eq!(snap.ids[0], 9873);
        assert_eq!(snap.ids[127], 10000);
        assert_eq!(snap.sites.len(), 2);
        assert!(snap.sites.iter().all(|site| site.emitted_count == 64));
    }

    #[test]
    fn delayed_events_cannot_restore_a_cleared_session() {
        let (ring, engine) = retention_engine(2);
        append_and_consider(&ring, &engine, "api", "request complete");
        let delayed = ring.snapshot(1, None)[0].clone();
        ring.clear();
        engine.clear_all();
        engine.consider(&delayed);
        assert!(engine.snapshot().ids.is_empty());
        append_and_consider(&ring, &engine, "worker", "request complete");
        engine.consider(&delayed);
        engine.rescan_ring();
        let snap = engine.snapshot();
        assert_eq!(snap.ids, vec![2]);
        assert_eq!(snap.sites.len(), 1);
        assert_eq!(snap.sites[0].source, "worker");
        assert_eq!(snap.sites[0].emitted_count, 1);
    }

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
    fn capitalized_logger_matches() {
        assert!(check_match(
            r#"Logger.info("loaded", count, "items")"#,
            "loaded 7 items"
        ));
    }

    #[test]
    fn capitalized_log_matches() {
        assert!(check_match(
            r#"Log.warn("disk", pct, "percent full")"#,
            "disk 92 percent full"
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
    fn extract_imports_ts_side_effect_import() {
        let src = r#"
import "@linear/models/MyModel";
import './polyfills';
"#;
        let ids = extract_imports(src, Lang::TsJs);
        assert!(ids.contains("MyModel"), "ids: {ids:?}");
        assert!(ids.contains("polyfills"), "ids: {ids:?}");
    }

    #[test]
    fn extract_imports_ts_scoped_path() {
        let src = r#"import { thing } from "@linear/models/MyModel";"#;
        let ids = extract_imports(src, Lang::TsJs);
        assert!(ids.contains("MyModel"), "ids: {ids:?}");
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
    fn extract_imports_rust_grouped_use() {
        let src = r#"
use crate::foo::{Bar, Baz};
use crate::services::{Alpha as A, Beta};
"#;
        let ids = extract_imports(src, Lang::Rust);
        assert!(ids.contains("Bar"), "ids: {ids:?}");
        assert!(ids.contains("Baz"), "ids: {ids:?}");
        assert!(ids.contains("Alpha"), "ids: {ids:?}");
        assert!(ids.contains("Beta"), "ids: {ids:?}");
    }

    #[test]
    fn extract_imports_rust_grouped_self_resolves_parent() {
        let src = r#"use crate::widgets::{self, Knob};"#;
        let ids = extract_imports(src, Lang::Rust);
        // `self` means the parent module: `widgets`.
        assert!(ids.contains("widgets"), "ids: {ids:?}");
        assert!(ids.contains("Knob"), "ids: {ids:?}");
    }

    #[test]
    fn extract_re_exports_ts_named_and_star() {
        let src = r#"
export { MyModel } from "./MyModel";
export * from "./helpers";
export type { Settings } from "./Settings";
export * as ns from "./Namespace";
"#;
        let ids = extract_re_exports(src, Lang::TsJs);
        assert!(ids.contains("MyModel"), "ids: {ids:?}");
        assert!(ids.contains("helpers"), "ids: {ids:?}");
        assert!(ids.contains("Settings"), "ids: {ids:?}");
        assert!(ids.contains("Namespace"), "ids: {ids:?}");
    }

    #[test]
    fn extract_re_exports_ts_ignores_plain_imports() {
        let src = r#"
import { Foo } from "./Foo";
const x = something.from("inline");
"#;
        let ids = extract_re_exports(src, Lang::TsJs);
        assert!(ids.is_empty(), "ids: {ids:?}");
    }

    #[test]
    fn extract_re_exports_rust_pub_use() {
        let src = r#"
pub use crate::widgets::Knob;
pub(crate) use crate::services::{Alpha, Beta as B};
use crate::internal::Plain;
"#;
        let ids = extract_re_exports(src, Lang::Rust);
        assert!(ids.contains("Knob"), "ids: {ids:?}");
        assert!(ids.contains("Alpha"), "ids: {ids:?}");
        assert!(ids.contains("Beta"), "ids: {ids:?}");
        assert!(!ids.contains("Plain"), "ids: {ids:?}");
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

    fn mk_entry(
        lang: Lang,
        imports: &[&str],
        re_exports: &[&str],
    ) -> FileEntry {
        FileEntry {
            mtime: SystemTime::UNIX_EPOCH,
            lang,
            imports: imports.iter().map(|s| s.to_string()).collect(),
            re_exports: re_exports.iter().map(|s| s.to_string()).collect(),
            log_calls: Vec::new(),
        }
    }

    #[test]
    fn barrel_expansion_adds_barrel_module_id_with_origin() {
        let root = Path::new("/tmp/proj");
        let mut index = ProjectIndex::default();
        // Barrel `models/index.ts` re-exports MyModel.
        index.files.insert(
            root.join("models/index.ts"),
            mk_entry(Lang::TsJs, &["MyModel"], &["MyModel"]),
        );

        let mut id_origin: HashMap<String, Vec<String>> = HashMap::new();
        id_origin
            .entry("MyModel".to_string())
            .or_default()
            .push("models/MyModel.ts".to_string());

        expand_through_barrels(&mut id_origin, &index, root);

        let models_origins = id_origin.get("models").expect("models id added");
        assert_eq!(models_origins, &vec!["models/MyModel.ts".to_string()]);
    }

    #[test]
    fn barrel_expansion_chains_through_nested_barrels() {
        let root = Path::new("/tmp/proj");
        let mut index = ProjectIndex::default();
        // Inner barrel: models/index.ts re-exports MyModel.
        index.files.insert(
            root.join("models/index.ts"),
            mk_entry(Lang::TsJs, &["MyModel"], &["MyModel"]),
        );
        // Outer barrel: packages/index.ts re-exports "models".
        index.files.insert(
            root.join("packages/index.ts"),
            mk_entry(Lang::TsJs, &["models"], &["models"]),
        );

        let mut id_origin: HashMap<String, Vec<String>> = HashMap::new();
        id_origin
            .entry("MyModel".to_string())
            .or_default()
            .push("models/MyModel.ts".to_string());

        expand_through_barrels(&mut id_origin, &index, root);

        assert!(id_origin.contains_key("models"));
        let pkg_origins = id_origin.get("packages").expect("packages id added");
        assert_eq!(pkg_origins, &vec!["models/MyModel.ts".to_string()]);
    }

    #[test]
    fn barrel_expansion_skips_files_without_re_exports() {
        let root = Path::new("/tmp/proj");
        let mut index = ProjectIndex::default();
        // Regular caller that imports MyModel but does not re-export it.
        index.files.insert(
            root.join("services/MyService.ts"),
            mk_entry(Lang::TsJs, &["MyModel"], &[]),
        );

        let mut id_origin: HashMap<String, Vec<String>> = HashMap::new();
        id_origin
            .entry("MyModel".to_string())
            .or_default()
            .push("models/MyModel.ts".to_string());

        expand_through_barrels(&mut id_origin, &index, root);

        // MyService is a caller, not a barrel, so no extra id was added.
        assert!(!id_origin.contains_key("MyService"), "id_origin: {id_origin:?}");
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
