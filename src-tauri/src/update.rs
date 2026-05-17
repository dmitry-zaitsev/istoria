use std::time::Duration;

use serde::Serialize;

const RELEASES_API: &str =
    "https://api.github.com/repos/dmitry-zaitsev/istoria-releases/releases/latest";
const RELEASES_PAGE: &str =
    "https://github.com/dmitry-zaitsev/istoria-releases/releases/latest";
const BREW_FORMULA: &str = "dmitry-zaitsev/tap/istoria";

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum InstallMethod {
    Homebrew,
    Other,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub has_update: bool,
    pub install_method: InstallMethod,
    pub release_url: String,
    pub brew_formula: &'static str,
}

pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Heuristic: a Homebrew formula extracts the bundle into the cellar
/// (`/opt/homebrew/Cellar/...` on Apple Silicon, `/usr/local/Cellar/...`
/// on Intel) and symlinks `bin/istoria` from `/opt/homebrew/bin`.
/// `current_exe` resolves through the symlink, so the canonicalized
/// path lands inside `/Cellar/` for any brew install. Anything else
/// (a local `cargo run`, a copied `.app`) falls through to `Other` —
/// for those we can't `brew upgrade`, so we point at the release page.
#[tauri::command]
pub fn detect_install_method() -> InstallMethod {
    let exe = match std::env::current_exe()
        .ok()
        .and_then(|p| p.canonicalize().ok())
    {
        Some(p) => p,
        None => return InstallMethod::Other,
    };
    let s = exe.to_string_lossy();
    if s.contains("/Cellar/")
        || s.starts_with("/opt/homebrew/")
        || s.starts_with("/usr/local/Cellar/")
    {
        InstallMethod::Homebrew
    } else {
        InstallMethod::Other
    }
}

#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateInfo, String> {
    let current = current_version().to_string();
    let install_method = detect_install_method();

    let client = reqwest::Client::builder()
        .user_agent(format!("istoria/{current} update-check"))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("github responded {}", resp.status()));
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let tag = body
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or("no tag_name in response")?;
    let latest = tag.trim_start_matches('v').to_string();
    let html_url = body
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or(RELEASES_PAGE)
        .to_string();

    let has_update = is_newer(&latest, &current);

    Ok(UpdateInfo {
        current,
        latest,
        has_update,
        install_method,
        release_url: html_url,
        brew_formula: BREW_FORMULA,
    })
}

fn is_newer(latest: &str, current: &str) -> bool {
    parse_version(latest) > parse_version(current)
}

fn parse_version(s: &str) -> (u32, u32, u32) {
    let s = s.trim().trim_start_matches('v');
    let mut parts = s.split('.').map(|p| {
        p.chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse::<u32>()
            .unwrap_or(0)
    });
    let a = parts.next().unwrap_or(0);
    let b = parts.next().unwrap_or(0);
    let c = parts.next().unwrap_or(0);
    (a, b, c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_versions() {
        assert_eq!(parse_version("1.2.3"), (1, 2, 3));
        assert_eq!(parse_version("v1.2.3"), (1, 2, 3));
        assert_eq!(parse_version("1.2"), (1, 2, 0));
        assert_eq!(parse_version("1.2.3-rc1"), (1, 2, 3));
        assert_eq!(parse_version(""), (0, 0, 0));
    }

    #[test]
    fn newer_compares() {
        assert!(is_newer("1.2.3", "1.2.2"));
        assert!(is_newer("2.0.0", "1.99.99"));
        assert!(is_newer("1.3.0", "1.2.99"));
        assert!(!is_newer("1.2.2", "1.2.2"));
        assert!(!is_newer("1.2.1", "1.2.2"));
    }
}
