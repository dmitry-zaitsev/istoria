import type { LogEvent } from "./ipc";
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

export function loadAlerts(): Alert[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a): a is Alert =>
        a != null &&
        typeof a.id === "string" &&
        typeof a.name === "string" &&
        typeof a.query === "string",
    );
  } catch {
    return [];
  }
}

function saveAlerts(alerts: Alert[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(alerts));
  } catch (e) {
    console.warn("alerts persist failed", e);
  }
}

export function addAlert(
  input: Omit<Alert, "id" | "enabled" | "created_at">,
): Alert {
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
export function matchAlerts(
  events: LogEvent[],
  compiled: CompiledAlert[],
): Map<number, string[]> {
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
