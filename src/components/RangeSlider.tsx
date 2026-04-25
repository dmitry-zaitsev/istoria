import { useMemo } from "react";

import {
  activeBuckets,
  toggleFacetRange,
  type RangeBucket,
} from "../lib/facets";
import type { LogEvent } from "../lib/ipc";

interface RangeSliderProps {
  events: LogEvent[];
  fieldKey: string;
  label: string;
  filter: string;
  onFilterChange: (q: string) => void;
}

const PERCENTILES = [50, 90, 99] as const;
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
  if (values.size <= 10) return true;
  return false;
}

function isDurationLike(key: string, values: Set<number>): boolean {
  if (DURATION_KEYWORDS.some((kw) => key.toLowerCase().includes(kw))) return true;
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

  if (sorted.length < MIN_VALUES_FOR_PERCENTILES) return null;

  const buckets = useMemo(() => percentileBuckets(sorted), [sorted]);
  const active = useMemo(
    () => activeBuckets(filter, fieldKey, buckets),
    [filter, fieldKey, buckets],
  );
  const counts = useMemo(() => bucketCounts(sorted, buckets), [sorted, buckets]);

  return (
    <div className="facet-group">
      <div className="facet-h">{label}</div>
      {buckets.map((b) => {
        const checked = active.has(b.label);
        return (
          <div
            key={b.label}
            className={`facet-row${checked ? " checked" : ""}`}
            onClick={() => onFilterChange(toggleFacetRange(filter, fieldKey, b))}
            role="button"
            title={b.label}
          >
            <span
              className={`facet-check${checked ? " on" : ""}`}
              aria-hidden
            >
              {checked ? "✓" : ""}
            </span>
            <span className="facet-value">{b.label}</span>
            <span className="facet-count">
              {counts.get(b.label)!.toLocaleString()}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function percentileBuckets(sorted: number[]): RangeBucket[] {
  if (sorted.length === 0) return [];
  const max = sorted[sorted.length - 1]!;
  const stops = PERCENTILES.map((p) => percentile(sorted, p));
  // Build [0,p50), [p50,p90), [p90,p99), [p99,max]
  const out: RangeBucket[] = [];
  let prev = 0;
  for (let i = 0; i < PERCENTILES.length; i++) {
    out.push({
      lo: prev,
      hi: stops[i]!,
      label: `< p${PERCENTILES[i]} (≤ ${fmt(stops[i]!)})`,
    });
    prev = stops[i]!;
  }
  out.push({
    lo: prev,
    hi: Number.POSITIVE_INFINITY,
    label: `≥ p${PERCENTILES[PERCENTILES.length - 1]} (> ${fmt(prev)}, max ${fmt(max)})`,
  });
  return out;
}

function bucketCounts(
  sorted: number[],
  buckets: RangeBucket[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const b of buckets) counts.set(b.label, 0);
  for (const v of sorted) {
    for (const b of buckets) {
      if (v >= b.lo && v < b.hi) {
        counts.set(b.label, (counts.get(b.label) ?? 0) + 1);
        break;
      }
    }
  }
  return counts;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * sorted.length)),
  );
  return sorted[idx]!;
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return "∞";
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
