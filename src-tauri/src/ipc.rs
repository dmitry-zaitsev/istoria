use serde::Serialize;

use crate::claude;
use crate::code::{self, CodeLine, EditorEntry, EmissionSite};
use crate::event::Event;
use crate::pins;
use crate::query::{self, Ast};
use crate::relevance::{self, BranchState, RelevanceAnalysis};
use crate::state::AppState;

#[derive(Clone, Debug, Serialize)]
pub struct EventNewPayload {
    pub len: usize,
    pub dropped: u64,
}

#[tauri::command]
pub async fn query_recent(
    state: tauri::State<'_, AppState>,
    limit: usize,
    filter: Option<String>,
) -> Result<Vec<Event>, String> {
    Ok(state.ring.snapshot(limit, filter.as_deref()))
}

#[derive(Clone, Debug, Serialize)]
pub struct ParseResult {
    pub ast: Option<Ast>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn query_parse(input: String) -> Result<ParseResult, String> {
    Ok(match query::parse(&input) {
        Ok(ast) => ParseResult { ast: Some(ast), error: None },
        Err(e) => ParseResult { ast: None, error: Some(e.message) },
    })
}

fn store_or_err(state: &AppState) -> Result<&crate::persistence::Store, String> {
    state
        .store
        .as_deref()
        .ok_or_else(|| "persistent store unavailable".to_string())
}

fn project_root_or_err(state: &AppState) -> Result<&std::path::Path, String> {
    state
        .project_root
        .as_deref()
        .ok_or_else(|| "project root unavailable".to_string())
}

#[tauri::command]
pub async fn get_code_preview(
    state: tauri::State<'_, AppState>,
    path: String,
    line: u32,
    context: u32,
) -> Result<Vec<CodeLine>, String> {
    let root = project_root_or_err(&state)?;
    code::read_slice(root, &path, line, context)
}

#[tauri::command]
pub async fn get_emission_site(
    state: tauri::State<'_, AppState>,
    msg: String,
) -> Result<Option<EmissionSite>, String> {
    let root = project_root_or_err(&state)?;
    let cache = std::sync::Arc::clone(&state.code_cache);
    let Some((path, line)) = code::find_emission_site(root, &cache, &msg)? else {
        return Ok(None);
    };
    let preview = code::read_slice(
        root,
        path.to_str().unwrap_or_default(),
        line,
        2,
    )
    .unwrap_or_default();
    let is_local = code::is_local_change(root, &cache, &path, line);
    let rel_path = path
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string_lossy().into_owned());
    Ok(Some(EmissionSite {
        path: path.to_string_lossy().into_owned(),
        rel_path,
        line,
        preview,
        is_local,
    }))
}

#[tauri::command]
pub async fn pin_event(
    state: tauri::State<'_, AppState>,
    event_id: i64,
) -> Result<(), String> {
    let store = store_or_err(&state)?;
    pins::pin(store, event_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unpin_event(
    state: tauri::State<'_, AppState>,
    event_id: i64,
) -> Result<(), String> {
    let store = store_or_err(&state)?;
    pins::unpin(store, event_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_pins(state: tauri::State<'_, AppState>) -> Result<Vec<i64>, String> {
    let store = store_or_err(&state)?;
    pins::list(store).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_editors() -> Result<Vec<EditorEntry>, String> {
    Ok(code::list_installed_editors())
}

#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    // Whitelist schemes derived from the known-editors list so a
    // malicious payload (e.g. via a crafted log message that the user
    // clicks through) can't trigger arbitrary file:// or javascript:
    // opens.
    let allowed = code::allowed_schemes();
    if !allowed.iter().any(|p| url.starts_with(p)) {
        return Err(format!("scheme not allowed: {url}"));
    }
    let cmd = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "start"
    } else {
        "xdg-open"
    };
    std::process::Command::new(cmd)
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn branch_state(
    state: tauri::State<'_, AppState>,
) -> Result<BranchState, String> {
    let root = project_root_or_err(&state)?;
    let cache = std::sync::Arc::clone(&state.code_cache);
    relevance::branch_state(root, &cache)
}

#[tauri::command]
pub async fn analyze_branch_relevance(
    state: tauri::State<'_, AppState>,
) -> Result<RelevanceAnalysis, String> {
    let root = project_root_or_err(&state)?.to_path_buf();
    let cache = std::sync::Arc::clone(&state.code_cache);
    let claude_status = claude::detect();
    let claude_path = claude_status
        .path
        .ok_or_else(|| "claude code not installed".to_string())?;
    // Move heavy work (git + claude subprocess) off the tauri command
    // worker so the UI stays responsive while analysis runs.
    tauri::async_runtime::spawn_blocking(move || {
        let bs = relevance::branch_state(&root, &cache)?;
        relevance::analyze(&root, &claude_path, &bs)
    })
    .await
    .map_err(|e| format!("analysis task panicked: {e}"))?
}

#[tauri::command]
pub async fn clear_session(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.ring.clear();
    state.source_registry.reset();
    if let Some(store) = state.store.as_deref() {
        store.clear_session().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn mcp_port() -> Result<u16, String> {
    Ok(crate::mcp::DEFAULT_PORT)
}

/// Open a new Terminal/console window and run `command` in it. macOS uses
/// AppleScript via osascript; Linux walks a list of common emulators;
/// Windows shells out to cmd. The command string is constructed in-app
/// (e.g. `claude mcp add ...`), so no user-supplied shell input.
#[tauri::command]
pub async fn open_terminal(command: String) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("empty command".into());
    }
    #[cfg(target_os = "macos")]
    {
        let escaped = command.replace('\\', "\\\\").replace('"', "\\\"");
        let do_script = format!("tell application \"Terminal\" to do script \"{}\"", escaped);
        let activate = "tell application \"Terminal\" to activate".to_string();
        std::process::Command::new("osascript")
            .args(["-e", &do_script, "-e", &activate])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        let wrapped = format!("{}; exec $SHELL", command);
        for (term, args) in [
            ("gnome-terminal", vec!["--", "bash", "-c", &wrapped]),
            ("konsole", vec!["-e", "bash", "-c", &wrapped]),
            ("x-terminal-emulator", vec!["-e", "bash", "-c", &wrapped]),
            ("xterm", vec!["-e", "bash", "-c", &wrapped]),
        ] {
            if std::process::Command::new(term).args(args).spawn().is_ok() {
                return Ok(());
            }
        }
        return Err("no supported terminal emulator found".into());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "cmd", "/K", &command])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("unsupported platform".into())
}
