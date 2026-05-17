use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use serde::Serialize;

const SCAN_FILE_MAX_BYTES: u64 = 1_000_000; // 1 MB per file
const SCAN_DIR_BUDGET: usize = 5_000; // total files visited per query
const PREVIEW_CONTEXT_MAX: u32 = 20;
const SCAN_EXTENSIONS: &[&str] = &[
    "rs", "go", "py", "js", "ts", "jsx", "tsx", "java", "kt", "rb",
    "c", "cc", "cpp", "h", "hpp", "swift", "scala", "php", "cs", "ex",
    "exs", "elm", "lua", "sh", "bash", "zsh",
];
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

#[derive(Clone, Debug, Serialize)]
pub struct CodeLine {
    pub line: u32,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct EmissionSite {
    pub path: String,
    pub rel_path: String,
    pub line: u32,
    pub preview: Vec<CodeLine>,
    pub is_local: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct EditorEntry {
    pub id: String,
    pub name: String,
    /// URL template with `{path}` and `{line}` placeholders. Frontend
    /// substitutes per-event before invoking `open_url`.
    pub url_template: String,
}

/// Per-product list of known macOS .app bundle names + display name +
/// URL scheme template. Tested against /Applications,
/// /System/Applications, and ~/Applications. Linux/Windows return
/// empty for now — file:// URLs would be the fallback.
const KNOWN_EDITORS: &[(&str, &[&str], &str, &str)] = &[
    (
        "vscode",
        &["Visual Studio Code"],
        "VSCode",
        "vscode://file/{path}:{line}",
    ),
    (
        "cursor",
        &["Cursor"],
        "Cursor",
        "cursor://file/{path}:{line}",
    ),
    (
        "zed",
        &["Zed", "Zed Preview"],
        "Zed",
        "zed://{path}:{line}",
    ),
    (
        "idea",
        &[
            "IntelliJ IDEA",
            "IntelliJ IDEA CE",
            "IntelliJ IDEA Community Edition",
            "IntelliJ IDEA Ultimate",
        ],
        "IntelliJ IDEA",
        "idea://open?file={path}&line={line}",
    ),
    (
        "pycharm",
        &[
            "PyCharm",
            "PyCharm CE",
            "PyCharm Community Edition",
            "PyCharm Professional Edition",
        ],
        "PyCharm",
        "pycharm://open?file={path}&line={line}",
    ),
    (
        "webstorm",
        &["WebStorm"],
        "WebStorm",
        "webstorm://open?file={path}&line={line}",
    ),
    (
        "goland",
        &["GoLand"],
        "GoLand",
        "goland://open?file={path}&line={line}",
    ),
    (
        "rubymine",
        &["RubyMine"],
        "RubyMine",
        "rubymine://open?file={path}&line={line}",
    ),
    (
        "clion",
        &["CLion"],
        "CLion",
        "clion://open?file={path}&line={line}",
    ),
    (
        "phpstorm",
        &["PhpStorm"],
        "PhpStorm",
        "phpstorm://open?file={path}&line={line}",
    ),
    (
        "rustrover",
        &["RustRover"],
        "RustRover",
        "rustrover://open?file={path}&line={line}",
    ),
    (
        "rider",
        &["Rider", "JetBrains Rider"],
        "Rider",
        "rider://open?file={path}&line={line}",
    ),
    (
        "datagrip",
        &["DataGrip"],
        "DataGrip",
        "datagrip://open?file={path}&line={line}",
    ),
    (
        "android-studio",
        &["Android Studio"],
        "Android Studio",
        "studio://open?file={path}&line={line}",
    ),
];

pub fn list_installed_editors() -> Vec<EditorEntry> {
    if !cfg!(target_os = "macos") {
        return Vec::new();
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let prefixes = [
        "/Applications".to_string(),
        "/System/Applications".to_string(),
        format!("{home}/Applications"),
    ];
    let mut out = Vec::new();
    for (id, names, display, template) in KNOWN_EDITORS {
        let installed = names.iter().any(|n| {
            prefixes
                .iter()
                .any(|p| std::path::Path::new(&format!("{p}/{n}.app")).exists())
        });
        if installed {
            out.push(EditorEntry {
                id: (*id).to_string(),
                name: (*display).to_string(),
                url_template: (*template).to_string(),
            });
        }
    }
    out
}

/// Schemes accepted by `open_url` — derived from KNOWN_EDITORS so a
/// single source of truth governs which URL schemes the IPC will
/// launch.
pub fn allowed_schemes() -> Vec<&'static str> {
    let mut out = Vec::new();
    for (_, _, _, template) in KNOWN_EDITORS {
        if let Some(idx) = template.find("://") {
            out.push(&template[..idx + 3]);
        }
    }
    out
}

/// In-memory caches: shared across IPC calls. Bounded by use:
/// emission-site grep is bounded per call, and the cache means a repeat
/// click on the same row is free. Keys include the project root so the
/// same message text from two different repos doesn't collide.
pub struct CodeCache {
    emission: Mutex<HashMap<(PathBuf, String), Option<(PathBuf, u32)>>>,
    blame: Mutex<HashMap<(PathBuf, PathBuf, u32), bool>>,
    default_branch: Mutex<HashMap<PathBuf, String>>,
}

impl CodeCache {
    pub fn new() -> Self {
        Self {
            emission: Mutex::new(HashMap::new()),
            blame: Mutex::new(HashMap::new()),
            default_branch: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for CodeCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Resolve `path` (which may be relative) into an absolute path that is
/// strictly inside `project_root`. Rejects path-traversal attempts.
pub fn resolve_inside(project_root: &Path, path: &str) -> Result<PathBuf, String> {
    let raw = Path::new(path);
    let candidate = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        project_root.join(raw)
    };
    let canon = candidate
        .canonicalize()
        .map_err(|e| format!("canonicalize failed: {e}"))?;
    if !canon.starts_with(project_root) {
        return Err("path is outside project root".into());
    }
    Ok(canon)
}

pub fn read_slice(
    project_root: &Path,
    path: &str,
    line: u32,
    context: u32,
) -> Result<Vec<CodeLine>, String> {
    let abs = resolve_inside(project_root, path)?;
    let context = context.min(PREVIEW_CONTEXT_MAX);
    let lo = line.saturating_sub(context);
    let hi = line.saturating_add(context);
    let f = fs::File::open(&abs).map_err(|e| format!("open: {e}"))?;
    let r = BufReader::new(f);
    let mut out = Vec::new();
    for (idx, ln) in r.lines().enumerate() {
        let n = idx as u32 + 1;
        if n < lo {
            continue;
        }
        if n > hi {
            break;
        }
        let text = ln.unwrap_or_default();
        out.push(CodeLine { line: n, text });
    }
    Ok(out)
}

const MIN_NEEDLE_CHARS: usize = 8;

/// Strip dynamic tokens (digits, paths, hex IDs, URLs) from `msg` and
/// return the longest contiguous run of static tokens. Source code holds
/// the format string, not the rendered message — matching the static
/// portion of the rendered text gives the best chance of a literal hit
/// in the source. Returns None if nothing static is long enough.
pub fn extract_needle(msg: &str) -> Option<String> {
    let mut best: Option<&str> = None;
    let mut run_start: Option<usize> = None;
    let mut idx = 0;
    while idx < msg.len() {
        let rest = &msg[idx..];
        let ws_len = rest
            .char_indices()
            .find(|(_, c)| !c.is_whitespace())
            .map(|(i, _)| i)
            .unwrap_or(rest.len());
        idx += ws_len;
        if idx >= msg.len() {
            break;
        }
        let rest = &msg[idx..];
        let tok_len = rest
            .char_indices()
            .find(|(_, c)| c.is_whitespace())
            .map(|(i, _)| i)
            .unwrap_or(rest.len());
        let tok_start = idx;
        let tok_end = idx + tok_len;
        let tok = &msg[tok_start..tok_end];
        if is_dynamic_token(tok) {
            run_start = None;
        } else {
            let start = *run_start.get_or_insert(tok_start);
            let run = &msg[start..tok_end];
            if best.map(|b| run.len() > b.len()).unwrap_or(true) {
                best = Some(run);
            }
        }
        idx = tok_end;
    }
    let needle = best?.trim_matches(|c: char| !c.is_alphanumeric());
    if needle.len() < MIN_NEEDLE_CHARS {
        return None;
    }
    Some(needle.to_string())
}

fn is_dynamic_token(tok: &str) -> bool {
    if tok.is_empty() {
        return true;
    }
    if tok.chars().any(|c| c.is_ascii_digit()) {
        return true;
    }
    if tok.contains('/') || tok.contains('\\') {
        return true;
    }
    if tok.contains("://") {
        return true;
    }
    // Long all-hex token (UUID without dashes, sha, etc.)
    if tok.len() >= 8 && tok.chars().all(|c| c.is_ascii_hexdigit()) {
        return true;
    }
    false
}

/// True if `needle` appears inside a `"..."`, `'...'`, or `` `...` ``
/// string literal on `line`. Anchoring matches to string literals filters
/// out hits in comments, identifiers, and unrelated prose, which is where
/// most false positives came from.
pub fn line_has_needle_in_string(line: &str, needle: &str) -> bool {
    if !line.contains(needle) {
        return false;
    }
    for delim in ['"', '\'', '`'] {
        let mut chars = line.char_indices();
        let mut start: Option<usize> = None;
        while let Some((i, c)) = chars.next() {
            if c == '\\' {
                chars.next();
                continue;
            }
            if c == delim {
                if let Some(s) = start {
                    let inner = &line[s + c.len_utf8()..i];
                    if inner.contains(needle) {
                        return true;
                    }
                    start = None;
                } else {
                    start = Some(i);
                }
            }
        }
    }
    false
}

/// Best-effort scan for the file:line where `msg` was emitted. Walks
/// the project tree (skipping vendor/build dirs), reads each candidate
/// file up to a size limit, and returns the first match where the
/// static portion of the message appears inside a string literal.
/// Cached by msg.
pub fn find_emission_site(
    project_root: &Path,
    cache: &CodeCache,
    msg: &str,
) -> Result<Option<(PathBuf, u32)>, String> {
    if msg.trim().is_empty() {
        return Ok(None);
    }
    let key = (project_root.to_path_buf(), msg.to_string());
    {
        let g = cache.emission.lock().unwrap();
        if let Some(hit) = g.get(&key) {
            return Ok(hit.clone());
        }
    }
    let Some(needle) = extract_needle(msg) else {
        cache.emission.lock().unwrap().insert(key, None);
        return Ok(None);
    };
    let mut budget = SCAN_DIR_BUDGET;
    let result = scan_dir(project_root, &needle, &mut budget);
    cache.emission.lock().unwrap().insert(key, result.clone());
    Ok(result)
}

fn scan_dir(dir: &Path, needle: &str, budget: &mut usize) -> Option<(PathBuf, u32)> {
    if *budget == 0 {
        return None;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return None,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if name.starts_with('.') && SKIP_DIRS.iter().any(|d| *d == name) {
            continue;
        }
        if SKIP_DIRS.iter().any(|d| *d == name) {
            continue;
        }
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            if let Some(hit) = scan_dir(&path, needle, budget) {
                return Some(hit);
            }
            continue;
        }
        if !ft.is_file() {
            continue;
        }
        *budget = budget.saturating_sub(1);
        if *budget == 0 {
            return None;
        }
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        if !SCAN_EXTENSIONS.iter().any(|e| *e == ext) {
            continue;
        }
        let meta = match path.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.len() > SCAN_FILE_MAX_BYTES {
            continue;
        }
        if let Some(line) = grep_first(&path, needle) {
            return Some((path, line));
        }
    }
    None
}

fn grep_first(path: &Path, needle: &str) -> Option<u32> {
    let f = fs::File::open(path).ok()?;
    let r = BufReader::new(f);
    for (idx, ln) in r.lines().enumerate() {
        let s = ln.ok()?;
        if line_has_needle_in_string(&s, needle) {
            return Some(idx as u32 + 1);
        }
    }
    None
}

pub fn default_branch(project_root: &Path, cache: &CodeCache) -> String {
    {
        let g = cache.default_branch.lock().unwrap();
        if let Some(b) = g.get(project_root) {
            return b.clone();
        }
    }
    let out = Command::new("git")
        .arg("symbolic-ref")
        .arg("--short")
        .arg("refs/remotes/origin/HEAD")
        .current_dir(project_root)
        .output();
    let branch = match out {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            s.strip_prefix("origin/").map(|x| x.to_string()).unwrap_or(s)
        }
        _ => "main".into(),
    };
    cache
        .default_branch
        .lock()
        .unwrap()
        .insert(project_root.to_path_buf(), branch.clone());
    branch
}

pub fn is_local_change(
    project_root: &Path,
    cache: &CodeCache,
    file: &Path,
    line: u32,
) -> bool {
    let key = (project_root.to_path_buf(), file.to_path_buf(), line);
    {
        let g = cache.blame.lock().unwrap();
        if let Some(v) = g.get(&key) {
            return *v;
        }
    }
    let val = compute_is_local(project_root, cache, file, line).unwrap_or(false);
    cache.blame.lock().unwrap().insert(key, val);
    val
}

fn compute_is_local(
    project_root: &Path,
    cache: &CodeCache,
    file: &Path,
    line: u32,
) -> Option<bool> {
    let blame = Command::new("git")
        .arg("blame")
        .arg(format!("-L{line},{line}"))
        .arg("--porcelain")
        .arg(file)
        .current_dir(project_root)
        .output()
        .ok()?;
    if !blame.status.success() {
        return Some(false);
    }
    let s = String::from_utf8_lossy(&blame.stdout);
    let first_line = s.lines().next()?;
    let hash = first_line.split_whitespace().next()?;
    if hash.starts_with('0') && hash.chars().all(|c| c == '0') {
        // Uncommitted change → treat as local.
        return Some(true);
    }
    let branch = default_branch(project_root, cache);
    let target = format!("origin/{branch}");
    let ancestor = Command::new("git")
        .arg("merge-base")
        .arg("--is-ancestor")
        .arg(hash)
        .arg(&target)
        .current_dir(project_root)
        .output()
        .ok()?;
    // Exit 0 → ancestor (commit is on default branch) → NOT local.
    // Exit 1 → not ancestor → local. Other → uncertain → false.
    Some(matches!(ancestor.status.code(), Some(1)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_traversal() {
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let err = resolve_inside(&tmp, "../../etc/passwd");
        assert!(err.is_err());
    }

    #[test]
    fn extract_needle_strips_dynamic_tokens() {
        // "user 42 signed in to dashboard" → drop "42", longest static
        // run is "signed in to dashboard".
        let n = extract_needle("user 42 signed in to dashboard").unwrap();
        assert_eq!(n, "signed in to dashboard");
    }

    #[test]
    fn extract_needle_handles_paths_and_hex() {
        // Path and 8-hex SHA both treated as dynamic.
        let n = extract_needle("loaded module from /usr/lib/foo deadbeef").unwrap();
        assert_eq!(n, "loaded module from");
    }

    #[test]
    fn extract_needle_returns_none_when_too_short() {
        // Each static run is < MIN_NEEDLE_CHARS (8 chars).
        assert!(extract_needle("user 1 ok").is_none());
        assert!(extract_needle("ok").is_none());
    }

    #[test]
    fn extract_needle_uses_full_msg_when_all_static() {
        let n = extract_needle("connection refused").unwrap();
        assert_eq!(n, "connection refused");
    }

    #[test]
    fn line_has_needle_in_string_matches_quoted() {
        assert!(line_has_needle_in_string(
            r#"log.info("connection refused")"#,
            "connection refused",
        ));
        assert!(line_has_needle_in_string(
            r#"println!('connection refused');"#,
            "connection refused",
        ));
        assert!(line_has_needle_in_string(
            "tracing::info!(`connection refused`)",
            "connection refused",
        ));
    }

    #[test]
    fn line_has_needle_in_string_rejects_comment_and_ident() {
        // Outside a string literal — must not count.
        assert!(!line_has_needle_in_string(
            "// connection refused — handled by retry loop",
            "connection refused",
        ));
        assert!(!line_has_needle_in_string(
            "fn connection_refused_handler() {}",
            "connection_refused",
        ));
    }
}
