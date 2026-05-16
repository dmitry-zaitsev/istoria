use std::path::PathBuf;
use std::sync::Arc;

use crate::code::CodeCache;
use crate::ring::Ring;
use crate::source;

pub struct AppState {
    pub ring: Arc<Ring>,
    /// Canonical absolute path to the user's project root, captured
    /// once from the working directory at istoria startup. None if the
    /// CWD couldn't be resolved.
    pub project_root: Option<PathBuf>,
    pub code_cache: Arc<CodeCache>,
    pub source_registry: Arc<source::Registry>,
}
