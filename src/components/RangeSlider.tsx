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

/// Auto-detect numeric facets from a sample of events.
export function detectNumericFacets(events: LogEvent[]): string[] {
  const sample = events.slice(-200);
  if (sample.length < 5) return [];
  const counts = new Map<string, { numeric: number; total: number }>();
  for (const e of sample) {
    const f = e.fields as Record<string, unknown> | undefined;
    if (!f || typeof f !== "object") continue;
    walk(f, "", (path, value) => {
      const c = counts.get(path) ?? { numeric: 0, total: 0 };
      c.total++;
      if (typeof value === "number" && !Number.isNaN(value)) c.numeric++;
      else if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value)))
        c.numeric++;
      counts.set(path, c);
    });
  }
  const out: string[] = [];
  for (const [k, c] of counts) {
    if (c.total >= 5 && c.numeric / c.total >= 0.8) out.push(k);
  }
  return out;
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
      <div className="ecdf">
        <svg viewBox="0 0 100 24" preserveAspectRatio="none">
          <polyline
            fill="none"
            stroke="var(--brand)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
            points={ecdfPoints(sorted)}
          />
          {PERCENTILES.map((p, i) => (
            <line
              key={p}
              x1={p}
              x2={p}
              y1="0"
              y2="24"
              stroke="var(--line-strong)"
              strokeDasharray="2 2"
              vectorEffect="non-scaling-stroke"
              opacity={activeStop === i ? 0.8 : 0.3}
            />
          ))}
        </svg>
      </div>
      <div className="pct-chips">
        {PERCENTILES.map((p, i) => (
          <button
            key={p}
            type="button"
            className={`pct-chip${activeStop === i ? " active" : ""}`}
            onClick={() => apply(stops[i]!)}
            title={`${fmt(stops[i]!)} (${p}th percentile)`}
          >
            ≥ p{p}
          </button>
        ))}
        {pinned.lo != null && (
          <button type="button" className="pct-chip clear" onClick={clear}>
            clear
          </button>
        )}
      </div>
    </div>
  );
}

function ecdfPoints(sorted: number[]): string {
  if (sorted.length === 0) return "";
  const n = sorted.length;
  const min = sorted[0]!;
  const max = sorted[n - 1]!;
  if (max === min) return "0,12 100,12";
  // Sample at percentile positions for smooth curve.
  const out: string[] = [];
  const steps = 50;
  for (let i = 0; i <= steps; i++) {
    const p = (i / steps) * 100;
    const v = percentile(sorted, p);
    const x = p;
    const y = 24 - ((v - min) / (max - min)) * 24;
    out.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return out.join(" ");
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
