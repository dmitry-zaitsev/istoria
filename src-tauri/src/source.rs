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
}
