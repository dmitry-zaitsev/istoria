use std::sync::Arc;

use crate::persistence::Store;
use crate::ring::Ring;

pub struct AppState {
    pub ring: Arc<Ring>,
    pub store: Option<Arc<Store>>,
}
