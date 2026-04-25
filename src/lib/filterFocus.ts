// Tiny pub/sub so non-adjacent components (e.g. Inspector) can ask
// the FilterBar input to grab focus without lifting a ref through
// many layers of JSX.

let focusFn: (() => void) | null = null;

export function registerFilterFocus(fn: (() => void) | null): void {
  focusFn = fn;
}

export function focusFilterInput(): void {
  focusFn?.();
}
