use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;

const CLI_LINK_PATH: &str = "/usr/local/bin/istoria";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliLinkStatus {
    /// True when running from a real .app bundle outside Homebrew's
    /// Cellar — the only case we'd want to add a /usr/local/bin
    /// symlink. Brew users get the wrapper from their formula;
    /// `cargo run` and other dev paths are skipped.
    pub needed: bool,
    /// True when a symlink at CLI_LINK_PATH exists and resolves to
    /// the binary we're currently running. False if missing or stale
    /// (e.g. user moved the .app).
    pub installed: bool,
    pub link_path: &'static str,
    pub binary_path: Option<String>,
}

fn current_binary() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|p| p.canonicalize().ok())
}

fn is_app_bundle_binary(p: &PathBuf) -> bool {
    let s = p.to_string_lossy();
    // The Electron core ships in Contents/Resources; the legacy Tauri binary
    // lived in Contents/MacOS. Accept either.
    s.contains(".app/Contents/MacOS/") || s.contains(".app/Contents/Resources/")
}

fn is_brew_binary(p: &PathBuf) -> bool {
    let s = p.to_string_lossy();
    s.contains("/Cellar/") || s.starts_with("/usr/local/Cellar/")
}

#[tauri::command]
pub fn cli_link_status() -> CliLinkStatus {
    let binary = current_binary();
    let needed = match &binary {
        Some(p) => is_app_bundle_binary(p) && !is_brew_binary(p),
        None => false,
    };
    let installed = if needed {
        std::fs::canonicalize(CLI_LINK_PATH)
            .ok()
            .zip(binary.clone())
            .map(|(link, bin)| link == bin)
            .unwrap_or(false)
    } else {
        false
    };
    CliLinkStatus {
        needed,
        installed,
        link_path: CLI_LINK_PATH,
        binary_path: binary.map(|p| p.to_string_lossy().into_owned()),
    }
}

/// Create (or replace) /usr/local/bin/istoria as a symlink pointing
/// at our currently-running binary. Uses osascript so macOS shows
/// the native admin prompt; on user cancel the script returns
/// non-zero and we surface the error.
#[tauri::command]
pub async fn install_cli_link() -> Result<(), String> {
    let bin = current_binary().ok_or("cannot resolve current binary")?;
    let bin_str = bin.to_string_lossy();
    // /usr/local/bin doesn't exist on fresh Apple Silicon — create it.
    // -f replaces any existing symlink. -s creates a symbolic link.
    let shell_cmd = format!(
        "mkdir -p /usr/local/bin && ln -sfh {bin} /usr/local/bin/istoria",
        bin = shell_escape(&bin_str),
    );
    let applescript = format!(
        "do shell script {script} with administrator privileges with prompt \"istoria needs your password to install the command-line tool.\"",
        script = applescript_string(&shell_cmd),
    );
    let output = Command::new("osascript")
        .args(["-e", &applescript])
        .output()
        .map_err(|e| format!("failed to invoke osascript: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // macOS canceled prompt → "User canceled. (-128)" — surface as
        // a distinguishable error so the UI can keep the modal open.
        return Err(stderr.trim().to_string());
    }
    Ok(())
}

fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn applescript_string(s: &str) -> String {
    let escaped = s.replace('\\', r"\\").replace('"', r#"\""#);
    format!("\"{escaped}\"")
}
