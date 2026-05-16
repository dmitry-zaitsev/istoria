import type { LogEvent } from "./ipc";
import { log } from "./logger";
import { evalAst, isError, parse, resolveAst, type Ast } from "./query";

export const ALERT_COLORS = ["red", "orange", "blue", "violet"] as const;
export type AlertColor = (typeof ALERT_COLORS)[number];

export interface Alert {
  id: string;
  name: string;
  query: string;
  color: string;
  notify: boolean;
  debounce_ms: number;
  enabled: boolean;
  created_at: number;
}

const STORAGE_KEY = "alerts.v1";

export const MIN_DEBOUNCE_MS = 5000;

export function loadAlerts(): Alert[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (a) =>
          a != null &&
          typeof a.id === "string" &&
          typeof a.name === "string" &&
          typeof a.query === "string"
      )
      .map(
        (a): Alert => ({
          id: a.id,
          name: a.name,
          query: a.query,
          color: typeof a.color === "string" ? a.color : "red",
          notify: a.notify === true,
          // Coerce + clamp: legacy entries pre-MIN_DEBOUNCE may have
          // debounce_ms missing or below the floor — those would
          // bypass the cooldown entirely (NaN compares yield false).
          debounce_ms: Math.max(
            typeof a.debounce_ms === "number" ? a.debounce_ms : 0,
            MIN_DEBOUNCE_MS
          ),
          enabled: a.enabled !== false,
          created_at: typeof a.created_at === "number" ? a.created_at : Date.now(),
        })
      );
  } catch {
    return [];
  }
}

function saveAlerts(alerts: Alert[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(alerts));
  } catch (e) {
    log.warn("alerts persist failed", e);
  }
}

export function addAlert(input: Omit<Alert, "id" | "enabled" | "created_at">): Alert {
  const id =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const next: Alert = {
    ...input,
    id,
    enabled: true,
    created_at: Date.now(),
  };
  const all = loadAlerts();
  all.push(next);
  saveAlerts(all);
  return next;
}

export function setAlertEnabledLocal(id: string, enabled: boolean): void {
  const all = loadAlerts();
  const idx = all.findIndex((a) => a.id === id);
  if (idx < 0) return;
  all[idx] = { ...all[idx]!, enabled };
  saveAlerts(all);
}

export function deleteAlertLocal(id: string): void {
  saveAlerts(loadAlerts().filter((a) => a.id !== id));
}

/// Deterministic FNV-1a → palette index. Same query string always
/// hashes to the same color so users mentally associate a color with
/// a saved query. Cheap, no deps.
export function hashColor(seed: string): AlertColor {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const idx = Math.abs(h) % ALERT_COLORS.length;
  return ALERT_COLORS[idx]!;
}

export interface CompiledAlert {
  alert: Alert;
  ast: Ast | null;
}

export function compileAlerts(alerts: Alert[]): CompiledAlert[] {
  return alerts
    .filter((a) => a.enabled)
    .map((alert) => {
      const parsed = parse(alert.query);
      return { alert, ast: isError(parsed) ? null : parsed };
    });
}

/// Returns Map<event.id, alertId[]> — first match wins for color, but
/// row gets all matched ids so the inspector can list them.
export function matchAlerts(events: LogEvent[], compiled: CompiledAlert[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  if (compiled.length === 0) return out;
  const usable = compiled.filter((c) => c.ast != null);
  if (usable.length === 0) return out;
  const resolved = usable.map((c) => ({
    alert: c.alert,
    ast: resolveAst(c.ast as Ast, events),
  }));
  for (const ev of events) {
    let hits: string[] | undefined;
    for (const r of resolved) {
      if (evalAst(r.ast, ev)) {
        if (!hits) hits = [];
        hits.push(r.alert.id);
      }
    }
    if (hits) out.set(ev.id, hits);
  }
  return out;
}

/// True iff any compiled alert references an aggregation function
/// (percentile, last, etc). Aggregation thresholds depend on the
/// full event distribution, so a delta-only match would be wrong —
/// caller must fall back to `matchAlerts(allEvents, compiled)`.
export function compiledHasAggregation(compiled: CompiledAlert[]): boolean {
  return compiled.some((c) => (c.ast ? astHasAggregation(c.ast) : false));
}

/// True iff the AST contains a `key_cmp_fn` node (percentile / last).
/// Used by alert + filter incremental paths to decide whether a
/// delta-only re-eval is safe.
export function astHasAggregation(ast: Ast): boolean {
  switch (ast.kind) {
    case "key_cmp_fn":
      return true;
    case "and":
    case "or":
      return astHasAggregation(ast.left) || astHasAggregation(ast.right);
    case "not":
      return astHasAggregation(ast.expr);
    default:
      return false;
  }
}

/// Incremental variant. Evaluates `compiled` against `deltaEvents` only
/// and merges hits into `existing`. Safe only when no compiled alert
/// uses an aggregation function — check via `compiledHasAggregation`
/// first; otherwise call `matchAlerts(allEvents, compiled)`.
export function matchAlertsDelta(
  deltaEvents: LogEvent[],
  compiled: CompiledAlert[],
  existing: Map<number, string[]>
): void {
  if (deltaEvents.length === 0 || compiled.length === 0) return;
  const usable = compiled.filter((c) => c.ast != null);
  if (usable.length === 0) return;
  // No aggregations → resolveAst is a no-op; pass [] to skip its scan.
  const resolved = usable.map((c) => ({
    alert: c.alert,
    ast: resolveAst(c.ast as Ast, []),
  }));
  for (const ev of deltaEvents) {
    let hits: string[] | undefined;
    for (const r of resolved) {
      if (evalAst(r.ast, ev)) {
        if (!hits) hits = [];
        hits.push(r.alert.id);
      }
    }
    if (hits) existing.set(ev.id, hits);
  }
}
