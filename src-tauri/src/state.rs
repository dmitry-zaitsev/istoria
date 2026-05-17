use std::path::PathBuf;
use std::sync::Arc;

use crate::code::CodeCache;
use crate::relevance::{PatternCache, RelevanceEngine, SourceRoots};
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
    /// source_name → cwd of that source (forwarder's working dir, or
    /// the owner's startup cwd for the stdin-piped owner source).
    /// Drives per-source git-diff lookups for branch relevance.
    pub source_roots: Arc<SourceRoots>,
    pub pattern_cache: Arc<PatternCache>,
    pub relevance: Arc<RelevanceEngine>,
}
