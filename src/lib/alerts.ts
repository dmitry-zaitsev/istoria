import type { Alert, LogEvent } from "./ipc";
import { evalAst, isError, parse, resolveAst, type Ast } from "./query";

export const ALERT_COLORS = ["red", "orange", "blue", "violet"] as const;
export type AlertColor = (typeof ALERT_COLORS)[number];

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
): Map<number, number[]> {
  const out = new Map<number, number[]>();
  if (compiled.length === 0) return out;
  const usable = compiled.filter((c) => c.ast != null);
  if (usable.length === 0) return out;
  const resolved = usable.map((c) => ({
    alert: c.alert,
    ast: resolveAst(c.ast as Ast, events),
  }));
  for (const ev of events) {
    let hits: number[] | undefined;
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
