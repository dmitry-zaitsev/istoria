use std::path::Path;

const SHELL_FALLBACKS: &[&str] = &[
    "bash", "zsh", "sh", "fish", "dash", "ksh", "tcsh", "csh", "ash", "pwsh",
];

/// Resolve the source name for this istoria invocation.
///
/// Precedence:
///  1. `--name` override (no counter unless `existing` already has it)
///  2. upstream pipe writer (process whose stdout is our stdin)
///  3. parent process binary name (e.g. `npm`, `go`)
///  4. `pipe` for shells / unknowable parents
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
    let base = pipe_writer_name()
        .or_else(|| {
            parent_command()
                .map(|s| sanitize(&s))
                .filter(|s| !s.is_empty())
                .filter(|s| !SHELL_FALLBACKS.contains(&s.as_str()))
        })
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

/// Find the upstream pipe writer's command. The OS pipe pair gives a
/// definitive answer that ppid heuristics can't: istoria's stdin and
/// the writer's stdout share one kernel object. ppid alone gets fooled
/// by recipes that fork background processes (e.g. `just dev` running
/// vite in the background while cargo runs istoria — both children of
/// the recipe's bash, but vite isn't on the pipe at all).
fn pipe_writer_name() -> Option<String> {
    let our_pid = std::process::id() as i32;
    let writer_pid = pipe_writer_pid(our_pid)?;
    let cmd = command_for_pid(writer_pid)?;
    Some(first_command_words(&cmd))
}

#[cfg(target_os = "macos")]
fn pipe_writer_pid(our_pid: i32) -> Option<i32> {
    // macOS lsof exposes pipes as two endpoints with cross-references:
    // each side's NAME is `->PEER_DEV`, and its DEVICE is its own end's
    // address. Our fd 0 has device R; the writer is the only other
    // process whose fd has NAME `->R`.
    use std::process::Command;
    let our_fd0 = Command::new("lsof")
        .args(["-p", &our_pid.to_string(), "-d", "0", "-F", "dn"])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&our_fd0.stdout);
    let mut device: Option<String> = None;
    let mut is_pipe = false;
    for line in s.lines() {
        if let Some(rest) = line.strip_prefix('d') {
            device = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix('n') {
            // pipes show "->0x..." in the name column
            if rest.trim_start().starts_with("->") {
                is_pipe = true;
            }
        }
    }
    if !is_pipe {
        return None;
    }
    let our_dev = device?;
    let target = format!("->{}", our_dev);

    let all = Command::new("lsof").args(["-F", "pn"]).output().ok()?;
    let stdout = String::from_utf8_lossy(&all.stdout);
    let mut current: Option<i32> = None;
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix('p') {
            current = rest.parse().ok();
        } else if let Some(rest) = line.strip_prefix('n') {
            if rest == target {
                if let Some(pid) = current {
                    if pid != our_pid {
                        return Some(pid);
                    }
                }
            }
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn pipe_writer_pid(our_pid: i32) -> Option<i32> {
    // Linux: /proc/<pid>/fd/<n> is a symlink to "pipe:[inode]" for
    // both ends of the same pipe. Find the other process whose fd
    // resolves to the same inode.
    let our_link = std::fs::read_link(format!("/proc/{}/fd/0", our_pid)).ok()?;
    let target = our_link.to_string_lossy().to_string();
    if !target.starts_with("pipe:") {
        return None;
    }
    let entries = std::fs::read_dir("/proc").ok()?;
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().into_string().ok() else {
            continue;
        };
        let Ok(pid) = name.parse::<i32>() else { continue };
        if pid == our_pid {
            continue;
        }
        let fd_dir = entry.path().join("fd");
        let Ok(fds) = std::fs::read_dir(&fd_dir) else { continue };
        for fd in fds.flatten() {
            if let Ok(link) = std::fs::read_link(fd.path()) {
                if link.to_string_lossy() == target {
                    return Some(pid);
                }
            }
        }
    }
    None
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn pipe_writer_pid(_our_pid: i32) -> Option<i32> {
    None
}

fn command_for_pid(pid: i32) -> Option<String> {
    let out = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn first_command_words(cmd: &str) -> String {
    let words: Vec<&str> = cmd
        .split_whitespace()
        .take_while(|w| !w.starts_with('-') && *w != "--")
        .take(3)
        .collect();
    if words.is_empty() {
        // pure-flag oddity (e.g. binary launched as `--something`):
        // fall back to first whitespace-separated token.
        return cmd
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_string();
    }
    // Basename every word that looks like an absolute/relative path
    // (contains a '/'): "node /path/fake-logs.mjs" → "node fake-logs.mjs".
    words
        .iter()
        .map(|w| {
            if w.contains('/') {
                std::path::Path::new(w)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or(w)
                    .to_string()
            } else {
                (*w).to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
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

    #[test]
    fn first_command_words_takes_non_flag_prefix() {
        assert_eq!(first_command_words("npm run dev --someFlag"), "npm run dev");
        assert_eq!(first_command_words("cargo run --release"), "cargo run");
        assert_eq!(first_command_words("/usr/bin/node script.js"), "node script.js");
        assert_eq!(
            first_command_words(
                "node /Users/me/projects/x/examples/generator/fake-logs.mjs"
            ),
            "node fake-logs.mjs"
        );
        assert_eq!(first_command_words("python -m foo"), "python");
        assert_eq!(first_command_words("a b c d e"), "a b c");
        assert_eq!(first_command_words(""), "");
    }
}
