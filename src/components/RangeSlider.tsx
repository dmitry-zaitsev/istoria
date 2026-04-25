import { useMemo } from "react";

import type { LogEvent } from "../lib/ipc";
import type { Ast } from "../lib/query";
import { isError, parse } from "../lib/query";

interface RangeSliderProps {
  events: LogEvent[];
  fieldKey: string;
  label: string;
  filter: string;
  onFilterChange: (q: string) => void;
}

const PERCENTILES = [50, 75, 90, 95, 99] as const;
const DURATION_KEYWORDS = ["dur", "latency", "elapsed", "ms", "_us", "time_"];
const MIN_VALUES_FOR_PERCENTILES = 30;
const MIN_DISTINCT_FOR_PERCENTILES = 10;

/// Auto-detect numeric facets that look like durations / continuous
/// distributions. Status codes, ids, and tiny enums are excluded —
/// percentile chips on those are nonsense.
export function detectNumericFacets(events: LogEvent[]): string[] {
  const sample = events.slice(-200);
  if (sample.length < MIN_VALUES_FOR_PERCENTILES) return [];
  const stats = new Map<
    string,
    { numeric: number; total: number; values: Set<number> }
  >();
  for (const e of sample) {
    const f = e.fields as Record<string, unknown> | undefined;
    if (!f || typeof f !== "object") continue;
    walk(f, "", (path, value) => {
      const c =
        stats.get(path) ?? { numeric: 0, total: 0, values: new Set<number>() };
      c.total++;
      const n =
        typeof value === "number"
          ? value
          : typeof value === "string" && value.trim() !== ""
          ? Number(value)
          : NaN;
      if (!Number.isNaN(n)) {
        c.numeric++;
        c.values.add(n);
      }
      stats.set(path, c);
    });
  }
  const out: string[] = [];
  for (const [k, c] of stats) {
    if (c.total < MIN_VALUES_FOR_PERCENTILES) continue;
    if (c.numeric / c.total < 0.8) continue;
    if (c.values.size < MIN_DISTINCT_FOR_PERCENTILES) continue;
    if (looksLikeStatusOrId(k, c.values)) continue;
    if (!isDurationLike(k, c.values)) continue;
    out.push(k);
  }
  return out;
}

function looksLikeStatusOrId(key: string, values: Set<number>): boolean {
  if (/(^|\.|_)(status|status_code|code|id|pid|port)$/i.test(key)) return true;
  // Mostly small integers in a tight band → enum-ish.
  if (values.size <= 10) return true;
  return false;
}

function isDurationLike(key: string, values: Set<number>): boolean {
  if (DURATION_KEYWORDS.some((kw) => key.toLowerCase().includes(kw))) return true;
  // Continuous distribution heuristic: spread > 100× across at least
  // 20 distinct values.
  const arr = [...values];
  const lo = Math.min(...arr);
  const hi = Math.max(...arr);
  return values.size >= 20 && lo > 0 && hi / lo >= 100;
}

function walk(
  obj: Record<string, unknown>,
  prefix: string,
  emit: (p: string, v: unknown) => void,
): void {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      walk(v as Record<string, unknown>, path, emit);
    } else {
      emit(path, v);
    }
  }
}

export function RangeSlider({
  events,
  fieldKey,
  label,
  filter,
  onFilterChange,
}: RangeSliderProps) {
  const sorted = useMemo(() => {
    const out = extractValues(events, fieldKey);
    out.sort((a, b) => a - b);
    return out;
  }, [events, fieldKey]);

  const ast = useMemo(() => {
    const r = parse(filter);
    return isError(r) ? null : r;
  }, [filter]);
  const pinned = useMemo(() => collectRange(ast, fieldKey), [ast, fieldKey]);

  if (sorted.length < 5) return null;

  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  const stops = PERCENTILES.map((p) => percentile(sorted, p));

  const activeStop = pinned.lo != null ? findActiveStop(pinned.lo, stops) : null;

  const apply = (threshold: number) => {
    onFilterChange(applyRange(filter, fieldKey, threshold, null));
  };
  const clear = () => onFilterChange(applyRange(filter, fieldKey, null, null));

  return (
    <div className="facet-group range-group">
      <div className="facet-h">
        {label}
        <span className="range-extent">
          {fmt(min)} – {fmt(max)}
        </span>
      </div>
      <div className="pct-list">
        {PERCENTILES.map((p, i) => (
          <div
            key={p}
            className={`pct-row${activeStop === i ? " active" : ""}`}
            onClick={() => apply(stops[i]!)}
            role="button"
            title={`Filter ≥ p${p}`}
          >
            <span className="pct-label">≥ p{p}</span>
            <span className="pct-value">{fmt(stops[i]!)}</span>
          </div>
        ))}
        {pinned.lo != null && (
          <div className="pct-row clear" onClick={clear} role="button">
            <span className="pct-label">clear</span>
          </div>
        )}
      </div>
    </div>
  );
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * sorted.length)),
  );
  return sorted[idx]!;
}

function findActiveStop(lo: number, stops: number[]): number | null {
  for (let i = stops.length - 1; i >= 0; i--) {
    if (Math.abs(stops[i]! - lo) < 0.001) return i;
  }
  return null;
}

function fmt(v: number): string {
  if (Number.isInteger(v)) return v.toString();
  if (v >= 100) return v.toFixed(0);
  return v.toFixed(1);
}

function extractValues(events: LogEvent[], key: string): number[] {
  const out: number[] = [];
  for (const e of events) {
    const v = lookup(e.fields, key);
    if (typeof v === "number" && !Number.isNaN(v)) out.push(v);
    else if (typeof v === "string") {
      const n = Number(v);
      if (!Number.isNaN(n)) out.push(n);
    }
  }
  return out;
}

function lookup(fields: unknown, path: string): unknown {
  let cur = fields;
  for (const part of path.split(".")) {
    if (cur && typeof cur === "object")
      cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

function collectRange(
  ast: Ast | null,
  key: string,
): { lo: number | null; hi: number | null } {
  if (!ast) return { lo: null, hi: null };
  let lo: number | null = null;
  let hi: number | null = null;
  const walk = (a: Ast) => {
    switch (a.kind) {
      case "key_cmp":
        if (a.key === key) {
          if (a.op === "gte" || a.op === "gt") lo = Math.max(lo ?? a.value, a.value);
          if (a.op === "lte" || a.op === "lt") hi = Math.min(hi ?? a.value, a.value);
        }
        break;
      case "and":
      case "or":
        walk(a.left);
        walk(a.right);
        break;
      case "not":
        walk(a.expr);
        break;
      default:
        break;
    }
  };
  walk(ast);
  return { lo, hi };
}

function applyRange(
  query: string,
  key: string,
  lo: number | null,
  hi: number | null,
): string {
  const pat = new RegExp(
    `(\\s+AND\\s+|^)${escapeRe(key)}:(>|>=|<|<=)[\\d.\\-]+`,
    "g",
  );
  let q = query.replace(pat, (_, prefix) =>
    prefix.startsWith(" AND") ? "" : "",
  );
  q = q.replace(
    new RegExp(`${escapeRe(key)}:(>|>=|<|<=)[\\d.\\-]+\\s+AND\\s+`, "g"),
    "",
  );
  q = q.trim();
  const clauses: string[] = [];
  if (lo != null) clauses.push(`${key}:>=${lo}`);
  if (hi != null) clauses.push(`${key}:<=${hi}`);
  if (clauses.length === 0) return q;
  if (!q) return clauses.join(" AND ");
  return `${q} AND ${clauses.join(" AND ")}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
