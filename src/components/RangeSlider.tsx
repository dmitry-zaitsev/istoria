import { useEffect, useMemo, useRef, useState } from "react";

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

const BUCKETS = 24;

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
      else if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) c.numeric++;
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
  const values = useMemo(() => extractValues(events, fieldKey), [events, fieldKey]);
  const min = values.length > 0 ? Math.min(...values) : 0;
  const max = values.length > 0 ? Math.max(...values) : 1;

  const isStatus = fieldKey === "status_code";

  // Existing range pinned in query (parsed AST → numeric bounds).
  const ast = useMemo(() => {
    const r = parse(filter);
    return isError(r) ? null : r;
  }, [filter]);
  const pinned = useMemo(() => collectRange(ast, fieldKey), [ast, fieldKey]);

  const [lo, setLo] = useState<number>(pinned.lo ?? min);
  const [hi, setHi] = useState<number>(pinned.hi ?? max);

  useEffect(() => {
    setLo(pinned.lo ?? min);
    setHi(pinned.hi ?? max);
  }, [pinned.lo, pinned.hi, min, max]);

  const trackRef = useRef<HTMLDivElement | null>(null);

  if (values.length < 5 || max === min) return null;

  const buckets = bucketize(values, min, max, BUCKETS);
  const peak = Math.max(1, ...buckets);

  const apply = (newLo: number, newHi: number) => {
    const lo2 = isStatus ? snapStatus(newLo, "lo") : newLo;
    const hi2 = isStatus ? snapStatus(newHi, "hi") : newHi;
    onFilterChange(applyRange(filter, fieldKey, lo2, hi2, min, max));
  };

  return (
    <div className="facet-group range-group">
      <div className="facet-h">{label}</div>
      <div className="range-spark">
        {buckets.map((b, i) => (
          <span
            key={i}
            className="bar"
            style={{ height: `${(b / peak) * 100}%` }}
          />
        ))}
      </div>
      <div
        className="range-track"
        ref={trackRef}
        onMouseDown={(e) => {
          if (!trackRef.current) return;
          const rect = trackRef.current.getBoundingClientRect();
          const onMove = (ev: MouseEvent) => {
            const ratio = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
            const v = min + ratio * (max - min);
            const center = (lo + hi) / 2;
            if (v < center) setLo(Math.min(v, hi));
            else setHi(Math.max(v, lo));
          };
          const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            apply(lo, hi);
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
          // immediate
          onMove(e.nativeEvent);
        }}
      >
        <div
          className="range-fill"
          style={{
            left: `${pct(lo, min, max)}%`,
            right: `${100 - pct(hi, min, max)}%`,
          }}
        />
        <Thumb pos={pct(lo, min, max)} />
        <Thumb pos={pct(hi, min, max)} />
      </div>
      <div className="range-labels">
        <span>{fmt(lo, isStatus)}</span>
        <span>{fmt(hi, isStatus)}</span>
      </div>
    </div>
  );
}

function Thumb({ pos }: { pos: number }) {
  return <span className="range-thumb" style={{ left: `${pos}%` }} />;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function pct(v: number, min: number, max: number): number {
  if (max === min) return 0;
  return ((v - min) / (max - min)) * 100;
}

function fmt(v: number, isStatus: boolean): string {
  if (isStatus) return Math.round(v).toString();
  return Number.isInteger(v) ? v.toString() : v.toFixed(1);
}

function snapStatus(v: number, edge: "lo" | "hi"): number {
  const groups = [100, 200, 300, 400, 500, 600];
  if (edge === "lo") {
    let best = groups[0]!;
    for (const g of groups) if (g <= v) best = g;
    return best;
  }
  // hi: snap to next group up
  for (const g of groups) if (g >= v) return g;
  return groups[groups.length - 1]!;
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

function bucketize(values: number[], min: number, max: number, n: number): number[] {
  const out = new Array(n).fill(0);
  if (max === min) return out;
  for (const v of values) {
    let i = Math.floor(((v - min) / (max - min)) * n);
    if (i >= n) i = n - 1;
    out[i]++;
  }
  return out;
}

function collectRange(ast: Ast | null, key: string): { lo: number | null; hi: number | null } {
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
  lo: number,
  hi: number,
  min: number,
  max: number,
): string {
  // Strip any existing key:>=N / key:<N / key:>N / key:<=N clauses.
  const pat = new RegExp(`(\\s+AND\\s+|^)${escapeRe(key)}:(>|>=|<|<=)[\\d.\\-]+`, "g");
  let q = query.replace(pat, (_, prefix) => (prefix.startsWith(" AND") ? "" : ""));
  q = q.replace(new RegExp(`${escapeRe(key)}:(>|>=|<|<=)[\\d.\\-]+\\s+AND\\s+`, "g"), "");
  q = q.trim();
  const clauses: string[] = [];
  if (lo > min) clauses.push(`${key}:>=${lo}`);
  if (hi < max) clauses.push(`${key}:<=${hi}`);
  if (clauses.length === 0) return q;
  if (!q) return clauses.join(" AND ");
  return `${q} AND ${clauses.join(" AND ")}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
