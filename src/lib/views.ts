/// localStorage-backed saved views. The DuckDB-backed alternative
/// turned out to be too fragile across migration churn — a half-failed
/// schema migration would take the whole store down and silently kill
/// "+ new view", "save filter", etc. Views are tiny configuration so
/// localStorage is fine.

export interface View {
  id: number;
  name: string;
  query: string;
  sort_order: number;
}

const VIEWS_KEY = "views.v1";
const ACTIVE_KEY = "active_view.v1";

export function loadViews(): View[] {
  try {
    const raw = localStorage.getItem(VIEWS_KEY);
    if (!raw) return seed();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return seed();
    const valid = parsed.filter(
      (v): v is View =>
        v != null &&
        typeof v.id === "number" &&
        typeof v.name === "string" &&
        typeof v.query === "string" &&
        typeof v.sort_order === "number",
    );
    return valid.length > 0 ? valid : seed();
  } catch {
    return seed();
  }
}

function saveViews(views: View[]): void {
  try {
    localStorage.setItem(VIEWS_KEY, JSON.stringify(views));
  } catch (e) {
    console.warn("views persist failed", e);
  }
}

function seed(): View[] {
  const all: View = { id: 1, name: "All", query: "", sort_order: 0 };
  saveViews([all]);
  return [all];
}

export function createViewLocal(name: string, query: string): View {
  const all = loadViews();
  const id = (all.reduce((m, v) => Math.max(m, v.id), 0) || 0) + 1;
  const sort_order =
    (all.reduce((m, v) => Math.max(m, v.sort_order), -1) || -1) + 1;
  const next: View = { id, name, query, sort_order };
  saveViews([...all, next]);
  return next;
}

export function updateViewLocal(id: number, name: string, query: string): void {
  const all = loadViews();
  const idx = all.findIndex((v) => v.id === id);
  if (idx < 0) return;
  all[idx] = { ...all[idx]!, name, query };
  saveViews(all);
}

export function deleteViewLocal(id: number): void {
  // Default seeded view (id=1, "All") is permanent — guard against
  // accidental deletion via stale UI / palette commands.
  if (id === 1) return;
  const all = loadViews().filter((v) => v.id !== id);
  saveViews(all);
}

export function duplicateViewLocal(id: number): View | null {
  const all = loadViews();
  const src = all.find((v) => v.id === id);
  if (!src) return null;
  return createViewLocal(`${src.name} (copy)`, src.query);
}

export function loadActiveViewId(): number | null {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    return raw ? Number(raw) || null : null;
  } catch {
    return null;
  }
}

export function saveActiveViewId(id: number): void {
  try {
    localStorage.setItem(ACTIVE_KEY, String(id));
  } catch (e) {
    console.warn("active view persist failed", e);
  }
}
