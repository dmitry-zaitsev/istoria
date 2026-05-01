use std::path::PathBuf;

use serde::Serialize;

const MCP_SERVER_NAME: &str = "istoria";

#[derive(Clone, Debug, Serialize)]
pub struct ClaudeStatus {
    pub installed: bool,
    pub path: Option<String>,
    /// Whether the istoria MCP server is registered with this agent's config.
    #[serde(rename = "mcpAdded")]
    pub mcp_added: bool,
}

fn find_binary(name: &str, well_known_relative: &[&str]) -> Option<PathBuf> {
    let candidate_names: Vec<String> = if cfg!(target_os = "windows") {
        vec![name.to_string(), format!("{name}.exe")]
    } else {
        vec![name.to_string()]
    };

    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            for n in &candidate_names {
                let candidate = dir.join(n);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        for rel in well_known_relative {
            let p = home.join(rel);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    for prefix in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        let p = PathBuf::from(prefix).join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    // macOS GUI apps launched via Finder/Tauri don't inherit ~/.zshrc PATH
    // edits, so a binary installed at e.g. ~/.local/bin or via a custom
    // shell rc file may be missing from std::env::PATH. Fall back to a
    // login shell to get the user's full resolved PATH.
    #[cfg(unix)]
    {
        if let Some(p) = find_via_login_shell(name) {
            return Some(p);
        }
    }
    None
}

#[cfg(unix)]
fn find_via_login_shell(name: &str) -> Option<PathBuf> {
    // Hardcoded names ("claude", "codex") — no shell injection surface.
    let cmd = format!("command -v {name}");
    for shell in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
        if !std::path::Path::new(shell).exists() {
            continue;
        }
        let out = std::process::Command::new(shell)
            .args(["-lc", &cmd])
            .output()
            .ok()?;
        if !out.status.success() {
            continue;
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() {
            continue;
        }
        let p = PathBuf::from(s);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

pub fn detect() -> ClaudeStatus {
    let path = find_binary(
        "claude",
        &[
            ".claude/local/claude",
            ".npm-global/bin/claude",
            ".bun/bin/claude",
        ],
    );
    ClaudeStatus {
        installed: path.is_some(),
        path: path.map(|p| p.to_string_lossy().into_owned()),
        mcp_added: claude_has_mcp(MCP_SERVER_NAME),
    }
}

pub fn detect_codex() -> ClaudeStatus {
    let path = find_binary(
        "codex",
        &[
            ".codex/bin/codex",
            ".npm-global/bin/codex",
            ".bun/bin/codex",
        ],
    );
    ClaudeStatus {
        installed: path.is_some(),
        path: path.map(|p| p.to_string_lossy().into_owned()),
        mcp_added: codex_has_mcp(MCP_SERVER_NAME),
    }
}

/// Reads `~/.claude.json` and checks whether the named MCP server is
/// registered in any scope claude stores there. Three locations:
///   * `mcpServers.<name>`               (user scope: `--scope user`)
///   * `projects.<cwd>.mcpServers.<name>` (local scope: default)
/// Project scope (`.mcp.json` in repo) is not checked here.
/// Returns false on any I/O or parse error — the UI just shows an "add"
/// button instead.
fn claude_has_mcp(name: &str) -> bool {
    let Some(home) = std::env::var_os("HOME") else { return false };
    let path = PathBuf::from(home).join(".claude.json");
    let Ok(text) = std::fs::read_to_string(&path) else { return false };
    let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) else { return false };

    let has_in = |v: &serde_json::Value| {
        v.get("mcpServers")
            .and_then(|m| m.as_object())
            .map(|m| m.contains_key(name))
            .unwrap_or(false)
    };

    if has_in(&val) {
        return true;
    }
    if let Some(projects) = val.get("projects").and_then(|v| v.as_object()) {
        for proj in projects.values() {
            if has_in(proj) {
                return true;
            }
        }
    }
    false
}

/// Reads `~/.codex/config.toml` and looks for a `[mcp_servers.<name>]`
/// section. Crude line-match (no TOML parser) — adequate for the canonical
/// form `codex mcp add` writes, returns false otherwise.
fn codex_has_mcp(name: &str) -> bool {
    let Some(home) = std::env::var_os("HOME") else { return false };
    let path = PathBuf::from(home).join(".codex/config.toml");
    let Ok(text) = std::fs::read_to_string(&path) else { return false };
    let header_plain = format!("[mcp_servers.{name}]");
    let header_quoted = format!("[mcp_servers.\"{name}\"]");
    text.lines()
        .map(|l| l.trim())
        .any(|l| l == header_plain || l == header_quoted)
}

#[tauri::command]
pub async fn claude_status() -> Result<ClaudeStatus, String> {
    Ok(detect())
}

#[tauri::command]
pub async fn codex_status() -> Result<ClaudeStatus, String> {
    Ok(detect_codex())
}
