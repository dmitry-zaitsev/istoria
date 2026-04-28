use parking_lot::Mutex;

/// Resolve the source name for this istoria invocation.
///
/// Two paths only:
///  1. `--name <X>` override (with collision counter against `existing`)
///  2. `pipe-N` counter
///
/// Earlier rounds tried to infer a name from the parent process or the
/// upstream pipe peer. Every heuristic ended up wrong somewhere — ppid
/// gets fooled by recipe-level wrappers, fd-pair detection picked up
/// orphan kernel pipes — so it's gone. If you want a meaningful source
/// name, pass `--name`.
pub fn resolve(name_override: Option<&str>, existing: &[String]) -> String {
    if let Some(n) = name_override {
        let trimmed = n.trim();
        if !trimmed.is_empty() {
            return suffix_if_clash(trimmed, existing);
        }
    }
    suffix_with_counter("pipe", existing)
}

fn suffix_if_clash(base: &str, existing: &[String]) -> String {
    if !existing.iter().any(|e| e == base) {
        return base.into();
    }
    suffix_with_counter(base, existing)
}

fn suffix_with_counter(base: &str, existing: &[String]) -> String {
    for n in 1.. {
        let cand = format!("{base}-{n}");
        if !existing.iter().any(|e| e == &cand) {
            return cand;
        }
    }
    unreachable!()
}

/// Owner-side registry of source names allocated this session. Each
/// new pipe (stdin or forwarder) calls `allocate` so `pipe-N` counters
/// keep incrementing instead of every forwarder picking `pipe-1`.
///
/// Names are kept for the whole session — even after a forwarder
/// disconnects, its events still live in the ring under that name, so
/// reusing it would conflate streams. `reset` is for `clear_session`.
pub struct Registry {
    inner: Mutex<Vec<String>>,
}

impl Registry {
    pub fn new() -> Self {
        Self { inner: Mutex::new(Vec::new()) }
    }

    pub fn allocate(&self, name_override: Option<&str>) -> String {
        let mut g = self.inner.lock();
        let name = resolve(name_override, &g);
        g.push(name.clone());
        name
    }

    pub fn reset(&self) {
        self.inner.lock().clear();
    }
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn override_no_clash() {
        assert_eq!(resolve(Some("api"), &[]), "api");
    }

    #[test]
    fn override_clashes_gets_counter() {
        let existing = vec!["api".into()];
        assert_eq!(resolve(Some("api"), &existing), "api-1");
    }

    #[test]
    fn no_override_returns_pipe_with_counter() {
        assert_eq!(resolve(None, &[]), "pipe-1");
        assert_eq!(resolve(None, &["pipe-1".into()]), "pipe-2");
    }

    #[test]
    fn empty_override_falls_through_to_pipe() {
        assert_eq!(resolve(Some(""), &[]), "pipe-1");
        assert_eq!(resolve(Some("   "), &[]), "pipe-1");
    }

    #[test]
    fn registry_allocates_distinct_pipes() {
        let r = Registry::new();
        assert_eq!(r.allocate(None), "pipe-1");
        assert_eq!(r.allocate(None), "pipe-2");
        assert_eq!(r.allocate(None), "pipe-3");
    }

    #[test]
    fn registry_mixes_overrides_and_pipes() {
        let r = Registry::new();
        assert_eq!(r.allocate(Some("api")), "api");
        assert_eq!(r.allocate(None), "pipe-1");
        assert_eq!(r.allocate(Some("api")), "api-1");
        assert_eq!(r.allocate(None), "pipe-2");
    }

    #[test]
    fn registry_reset_restarts_counter() {
        let r = Registry::new();
        r.allocate(None);
        r.allocate(None);
        r.reset();
        assert_eq!(r.allocate(None), "pipe-1");
    }
}
