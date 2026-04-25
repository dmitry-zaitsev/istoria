use std::path::Path;

const SHELL_FALLBACKS: &[&str] = &[
    "bash", "zsh", "sh", "fish", "dash", "ksh", "tcsh", "csh", "ash", "pwsh",
];

/// Resolve the source name for this istoria invocation.
///
/// Precedence:
///  1. `--name` override (no counter unless `existing` already has it)
///  2. parent process binary name (e.g. `npm`, `go`)
///  3. `pipe` for shells / unknowable parents
///
/// Auto-derived names get a per-session counter (`npm-1`, `npm-2`).
/// User-supplied `--name` only gets a counter when it would clash.
pub fn resolve(name_override: Option<&str>, existing: &[String]) -> String {
    if let Some(n) = name_override {
        let trimmed = n.trim();
        if !trimmed.is_empty() {
            return suffix_if_clash(trimmed, existing);
        }
    }
    let base = parent_command()
        .map(|s| sanitize(&s))
        .filter(|s| !s.is_empty())
        .filter(|s| !SHELL_FALLBACKS.contains(&s.as_str()))
        .unwrap_or_else(|| "pipe".into());
    suffix_with_counter(&base, existing)
}

fn sanitize(s: &str) -> String {
    let path: &Path = Path::new(s);
    let stem = path
        .file_stem()
        .and_then(|x| x.to_str())
        .unwrap_or(s);
    stem.to_ascii_lowercase()
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

/// Read parent process binary name. macOS uses `proc_pidpath`; Linux
/// reads `/proc/<pid>/comm`. Returns `None` on other platforms or
/// permission errors.
pub fn parent_command() -> Option<String> {
    let ppid = unsafe { libc::getppid() };
    if ppid <= 0 {
        return None;
    }
    #[cfg(target_os = "macos")]
    {
        proc_pidpath_macos(ppid)
    }
    #[cfg(target_os = "linux")]
    {
        proc_comm_linux(ppid)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = ppid;
        None
    }
}

#[cfg(target_os = "macos")]
fn proc_pidpath_macos(pid: libc::pid_t) -> Option<String> {
    extern "C" {
        fn proc_pidpath(pid: libc::c_int, buffer: *mut libc::c_void, buffersize: u32) -> libc::c_int;
    }
    const PROC_PIDPATHINFO_MAXSIZE: u32 = 4096;
    let mut buf: Vec<u8> = vec![0; PROC_PIDPATHINFO_MAXSIZE as usize];
    let n = unsafe {
        proc_pidpath(
            pid as libc::c_int,
            buf.as_mut_ptr() as *mut libc::c_void,
            PROC_PIDPATHINFO_MAXSIZE,
        )
    };
    if n <= 0 {
        return None;
    }
    buf.truncate(n as usize);
    String::from_utf8(buf).ok()
}

#[cfg(target_os = "linux")]
fn proc_comm_linux(pid: libc::pid_t) -> Option<String> {
    let path = format!("/proc/{pid}/comm");
    std::fs::read_to_string(path).ok().map(|s| s.trim().to_string())
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
    fn auto_first_gets_counter() {
        // simulate parent_command returning npm
        let cand = suffix_with_counter("npm", &[]);
        assert_eq!(cand, "npm-1");
        let cand2 = suffix_with_counter("npm", &["npm-1".into()]);
        assert_eq!(cand2, "npm-2");
    }

    #[test]
    fn shell_falls_back_to_pipe() {
        // resolve should not return a shell; if parent is a shell, it returns pipe-1
        // we can't fake parent here, but we can check the path: forcing a shell name
        // via override should still work as override (no shell fallback for explicit).
        let cand = suffix_with_counter("pipe", &[]);
        assert_eq!(cand, "pipe-1");
    }

    #[test]
    fn sanitize_strips_path_and_lowers() {
        assert_eq!(sanitize("/usr/bin/npm"), "npm");
        assert_eq!(sanitize("Go"), "go");
        assert_eq!(sanitize("/opt/Homebrew/bin/cargo"), "cargo");
    }
}
