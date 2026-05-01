use std::path::Path;

use parking_lot::Mutex;

/// Resolve the source name for this istoria invocation.
///
/// Two paths only:
///  1. `--name <X>` override (with collision counter against `existing`)
///  2. `pipe-N` counter
///
/// Earlier rounds tried to infer a name from the parent process or the
/// upstream pipe peer. Every heuristic ended up wrong somewhere — ppid
/// gets fooled by recipe-level wrappers, fd-pair detection picked up
/// orphan kernel pipes — so it's gone. If you want a meaningful source
/// name, pass `--name`.
pub fn resolve(name_override: Option<&str>, existing: &[String]) -> String {
    if let Some(n) = name_override {
        let trimmed = n.trim();
        if !trimmed.is_empty() {
            return suffix_if_clash(trimmed, existing);
        }
    }
    suffix_with_counter("pipe", existing)
}

fn suffix_if_clash(base: &str, existing: &[String]) -> String {
    if !existing.iter().any(|e| e == base) {
        return base.into();
    }
    suffix_with_counter(base, existing)
}

fn suffix_with_counter(base: &str, existing: &[String]) -> String {
    for n in 1.. {
        let cand = format!("{base}-{n}");
        if !existing.iter().any(|e| e == &cand) {
            return cand;
        }
    }
    unreachable!()
}

/// Derive the branch label for the cwd: current git branch, or the
/// folder name as fallback. `None` only if cwd is unreadable / has no
/// usable name (root path with no git ancestor).
///
/// Pure file reads — no `git` subprocess. Walks up looking for `.git`
/// (dir or worktree pointer file) and parses `HEAD`. Detached HEAD
/// (no `ref: refs/heads/…`) falls back to the folder name.
pub fn derive_branch(cwd: &Path) -> Option<String> {
    if let Some(branch) = git_branch(cwd) {
        return Some(branch);
    }
    cwd.file_name().and_then(|s| s.to_str()).map(String::from)
}

fn git_branch(start: &Path) -> Option<String> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        let dot_git = d.join(".git");
        if dot_git.is_dir() {
            return read_head_branch(&dot_git.join("HEAD"));
        }
        if dot_git.is_file() {
            let content = std::fs::read_to_string(&dot_git).ok()?;
            let gitdir = content.trim().strip_prefix("gitdir: ")?.trim();
            let head_path = Path::new(gitdir).join("HEAD");
            return read_head_branch(&head_path);
        }
        dir = d.parent();
    }
    None
}

fn read_head_branch(head: &Path) -> Option<String> {
    let content = std::fs::read_to_string(head).ok()?;
    parse_head_branch(&content)
}

fn parse_head_branch(content: &str) -> Option<String> {
    content
        .trim()
        .strip_prefix("ref: refs/heads/")
        .map(String::from)
}

/// Owner-side registry of source names allocated this session. Each
/// new pipe (stdin or forwarder) calls `allocate` so `pipe-N` counters
/// keep incrementing instead of every forwarder picking `pipe-1`.
///
/// Names are kept for the whole session — even after a forwarder
/// disconnects, its events still live in the ring under that name, so
/// reusing it would conflate streams. `reset` is for `clear_session`.
pub struct Registry {
    inner: Mutex<Vec<String>>,
}

impl Registry {
    pub fn new() -> Self {
        Self { inner: Mutex::new(Vec::new()) }
    }

    pub fn allocate(&self, name_override: Option<&str>) -> String {
        let mut g = self.inner.lock();
        let name = resolve(name_override, &g);
        g.push(name.clone());
        name
    }

    pub fn reset(&self) {
        self.inner.lock().clear();
    }
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn override_no_clash() {
        assert_eq!(resolve(Some("api"), &[]), "api");
    }

    #[test]
    fn override_clashes_gets_counter() {
        let existing = vec!["api".into()];
        assert_eq!(resolve(Some("api"), &existing), "api-1");
    }

    #[test]
    fn no_override_returns_pipe_with_counter() {
        assert_eq!(resolve(None, &[]), "pipe-1");
        assert_eq!(resolve(None, &["pipe-1".into()]), "pipe-2");
    }

    #[test]
    fn empty_override_falls_through_to_pipe() {
        assert_eq!(resolve(Some(""), &[]), "pipe-1");
        assert_eq!(resolve(Some("   "), &[]), "pipe-1");
    }

    #[test]
    fn registry_allocates_distinct_pipes() {
        let r = Registry::new();
        assert_eq!(r.allocate(None), "pipe-1");
        assert_eq!(r.allocate(None), "pipe-2");
        assert_eq!(r.allocate(None), "pipe-3");
    }

    #[test]
    fn registry_mixes_overrides_and_pipes() {
        let r = Registry::new();
        assert_eq!(r.allocate(Some("api")), "api");
        assert_eq!(r.allocate(None), "pipe-1");
        assert_eq!(r.allocate(Some("api")), "api-1");
        assert_eq!(r.allocate(None), "pipe-2");
    }

    #[test]
    fn registry_reset_restarts_counter() {
        let r = Registry::new();
        r.allocate(None);
        r.allocate(None);
        r.reset();
        assert_eq!(r.allocate(None), "pipe-1");
    }

    #[test]
    fn parse_head_branch_ref() {
        assert_eq!(
            parse_head_branch("ref: refs/heads/main\n").as_deref(),
            Some("main")
        );
        assert_eq!(
            parse_head_branch("ref: refs/heads/feature/x").as_deref(),
            Some("feature/x")
        );
    }

    #[test]
    fn parse_head_branch_detached_returns_none() {
        // Detached HEAD: HEAD holds a raw SHA, not a `ref: …` line.
        assert_eq!(parse_head_branch("a1b2c3d4e5f6\n"), None);
    }

    #[test]
    fn derive_branch_falls_back_to_folder() {
        let base = std::env::temp_dir().join(format!(
            "istoria-source-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let cwd = base.join("my-project");
        std::fs::create_dir_all(&cwd).unwrap();
        let got = derive_branch(&cwd);
        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(got.as_deref(), Some("my-project"));
    }

    #[test]
    fn derive_branch_reads_git_head() {
        let base = std::env::temp_dir().join(format!(
            "istoria-source-git-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let cwd = base.join("repo");
        let dot_git = cwd.join(".git");
        std::fs::create_dir_all(&dot_git).unwrap();
        std::fs::write(dot_git.join("HEAD"), "ref: refs/heads/feature/login\n").unwrap();
        let got = derive_branch(&cwd);
        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(got.as_deref(), Some("feature/login"));
    }

    #[test]
    fn derive_branch_follows_worktree_gitdir() {
        let base = std::env::temp_dir().join(format!(
            "istoria-source-worktree-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let real_gitdir = base.join("main-repo/.git/worktrees/wt");
        std::fs::create_dir_all(&real_gitdir).unwrap();
        std::fs::write(real_gitdir.join("HEAD"), "ref: refs/heads/wt-branch\n").unwrap();
        let cwd = base.join("worktree");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::write(
            cwd.join(".git"),
            format!("gitdir: {}\n", real_gitdir.display()),
        )
        .unwrap();
        let got = derive_branch(&cwd);
        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(got.as_deref(), Some("wt-branch"));
    }
}
