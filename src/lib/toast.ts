// Tiny event-bus toast — single slot, no library. Components subscribe
// to changes via the Toast component; callers fire `toast(message)`.

type Listener = (msg: string | null) => void;

const listeners = new Set<Listener>();
let timer: number | null = null;

export function toast(message: string, durationMs = 1500): void {
  for (const l of listeners) l(message);
  if (timer != null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    for (const l of listeners) l(null);
    timer = null;
  }, durationMs);
}

export function subscribeToast(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
