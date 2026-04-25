use serde::Serialize;

use crate::event::Event;
use crate::query::{self, Ast};
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
