use serde::Serialize;

use crate::event::Event;
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
