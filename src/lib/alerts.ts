import type { Alert, LogEvent } from "./ipc";
import { evalAst, isError, parse, resolveAst, type Ast } from "./query";

export const ALERT_COLORS = ["red", "orange", "blue", "violet"] as const;
export type AlertColor = (typeof ALERT_COLORS)[number];

export interface CompiledAlert {
  alert: Alert;
  ast: Ast | null;
}

export function compileAlerts(alerts: Alert[]): CompiledAlert[] {
  return alerts.map((alert) => {
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
