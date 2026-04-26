// Tiny pub/sub for session-wide reset events. Lets the clear-
// session button and palette command tell App to wipe its local
// snapshots immediately, instead of waiting for the next throttled
// queryRecent refresh — which never lands when the user is paused.

const listeners = new Set<() => void>();

export function onSessionCleared(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function fireSessionCleared(): void {
  for (const cb of listeners) cb();
}
