type Listener = (initialQuery: string | null) => void;

const listeners = new Set<Listener>();

export function fireAlertsModalOpen(initialQuery: string | null = null): void {
  for (const l of listeners) l(initialQuery);
}

export function onAlertsModalOpen(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
