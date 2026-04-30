use std::path::PathBuf;

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct ClaudeStatus {
    pub installed: bool,
    pub path: Option<String>,
}

fn well_known_paths() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        out.push(home.join(".claude/local/claude"));
        out.push(home.join(".npm-global/bin/claude"));
        out.push(home.join(".bun/bin/claude"));
    }
    out.push(PathBuf::from("/opt/homebrew/bin/claude"));
    out.push(PathBuf::from("/usr/local/bin/claude"));
    out.push(PathBuf::from("/usr/bin/claude"));
    out
}

fn find_on_path() -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for name in ["claude", "claude.exe"] {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

pub fn detect() -> ClaudeStatus {
    if let Some(p) = find_on_path() {
        return ClaudeStatus {
            installed: true,
            path: Some(p.to_string_lossy().into_owned()),
        };
    }
    for p in well_known_paths() {
        if p.is_file() {
            return ClaudeStatus {
                installed: true,
                path: Some(p.to_string_lossy().into_owned()),
            };
        }
    }
    ClaudeStatus {
        installed: false,
        path: None,
    }
}

#[tauri::command]
pub async fn claude_status() -> Result<ClaudeStatus, String> {
    Ok(detect())
}
