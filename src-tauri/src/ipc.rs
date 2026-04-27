use serde::Serialize;

use crate::event::Event;
use crate::pins;
use crate::query::{self, Ast};
use crate::state::AppState;
use crate::views::{self, View};

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

#[tauri::command]
pub async fn views_list(state: tauri::State<'_, AppState>) -> Result<Vec<View>, String> {
    let store = store_or_err(&state)?;
    views::list(store).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn views_create(
    state: tauri::State<'_, AppState>,
    name: String,
    query: String,
) -> Result<View, String> {
    let store = store_or_err(&state)?;
    views::create(store, name, query).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn views_update(
    state: tauri::State<'_, AppState>,
    id: i64,
    name: String,
    query: String,
) -> Result<(), String> {
    let store = store_or_err(&state)?;
    views::update(store, id, name, query).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn views_delete(
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    let store = store_or_err(&state)?;
    views::delete(store, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn views_duplicate(
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<View, String> {
    let store = store_or_err(&state)?;
    views::duplicate(store, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn meta_get(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<Option<String>, String> {
    let store = store_or_err(&state)?;
    Ok(views::get_meta(store, &key))
}

#[tauri::command]
pub async fn meta_set(
    state: tauri::State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    let store = store_or_err(&state)?;
    views::set_meta(store, &key, &value).map_err(|e| e.to_string())
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
pub async fn clear_session(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.ring.clear();
    if let Some(store) = state.store.as_deref() {
        store.clear_session().map_err(|e| e.to_string())?;
    }
    Ok(())
}
