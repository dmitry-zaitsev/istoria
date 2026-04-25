use std::sync::Arc;

use crate::ring::Ring;

pub struct AppState {
    pub ring: Arc<Ring>,
}
