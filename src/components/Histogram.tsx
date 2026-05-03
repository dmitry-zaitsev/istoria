import { useMemo, useRef, useState } from "react";

import type { LogEvent } from "../lib/ipc";
import { formatSmartDate, isError, parse } from "../lib/query";

interface HistogramProps {
  events: LogEvent[];
  filter: string;
  onFilterChange: (q: string) => void;
}

const BUCKET_TARGET = 60;
const BUCKET_MIN_COUNT = 24;
const BUCKET_SIZES_MS = [
  1,
  10,
  100,
  1_000,
  10_000,
  60_000,
  5 * 60_000,
  60 * 60_000,
  24 * 60 * 60_000,
];

interface Bucket {
  ts: number;
  err: number;
  warn: number;
  rest: number;
  total: number;
}

export function Histogram({ events, filter, onFilterChange }: HistogramProps) {
  const [expanded, setExpanded] = useState(true);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [brush, setBrush] = useState<{ start: number; end: number } | null>(null);
  const brushRef = useRef<{ start: number; end: number } | null>(null);
  brushRef.current = brush;

  const { buckets, bucketMs, tMin, tMax } = useMemo(() => bucketize(events), [events]);

  const peak = Math.max(1, ...buckets.map((b) => b.total));

  // Pinned ts range from query
  const pinned = useMemo(() => {
    const r = parse(filter);
    if (isError(r)) return { lo: null as number | null, hi: null as number | null };
    return collectTs(r);
  }, [filter]);

  const onBrushDown = (e: React.MouseEvent) => {
    if (!expanded || !trackRef.current) return;
    e.preventDefault();
    const rect = trackRef.current.getBoundingClientRect();
    const startX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const init = { start: startX, end: startX };
    brushRef.current = init;
    setBrush(init);
    const onMove = (ev: MouseEvent) => {
      const x = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
      const next = { start: brushRef.current!.start, end: x };
      brushRef.current = next;
      setBrush(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const b = brushRef.current;
      brushRef.current = null;
      setBrush(null);
      if (!b) return;
      const lo = Math.min(b.start, b.end) / rect.width;
      const hi = Math.max(b.start, b.end) / rect.width;
      if (hi - lo < 0.005) return;
      const tLo = Math.round(tMin + lo * (tMax - tMin));
      const tHi = Math.round(tMin + hi * (tMax - tMin));
      applyTsRange(filter, tLo, tHi, onFilterChange);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const tickFmt = bucketLabel(bucketMs);
  const ticks = expanded ? makeTicks(tMin, tMax, 5) : [];

  return (
    <div className={`histo-shell${expanded ? " expanded" : " compact"}`}>
      <div className="histo-header">
        <span className="histo-title">events over time</span>
        {expanded && (
          <span className="histo-legend">
            <span className="lg lg-err" /> error
            <span className="lg lg-warn" /> warn
            <span className="lg lg-info" /> info / debug
          </span>
        )}
        <button
          className="histo-toggle"
          type="button"
          onClick={() => setExpanded((x) => !x)}
          aria-label={expanded ? "Collapse histogram" : "Expand histogram"}
        >
          {expanded ? "collapse ▴" : "expand ▾"}
        </button>
      </div>
      <div
        className="histo-canvas"
        ref={trackRef}
        onMouseDown={(e) => {
          if (!expanded) {
            setExpanded(true);
            return;
          }
          onBrushDown(e);
        }}
      >
        {buckets.map((b, i) => {
          const total = b.total || 1;
          const errH = (b.err / peak) * 100;
          const warnH = (b.warn / peak) * 100;
          const restH = (b.rest / peak) * 100;
          const visible = b.total > 0;
          return (
            <div key={i} className="histo-col" title={`${tickFmt(b.ts)} · ${b.total}`}>
              {visible && (
                <>
                  <span className="seg seg-err" style={{ height: `${errH}%` }} />
                  <span className="seg seg-warn" style={{ height: `${warnH}%` }} />
                  <span className="seg seg-info" style={{ height: `${restH}%` }} />
                </>
              )}
              {/* unused total to avoid lint */}
              <span style={{ display: "none" }}>{total}</span>
            </div>
          );
        })}
        {brush &&
          trackRef.current &&
          (() => {
            const rectW = trackRef.current.clientWidth || 1;
            const lo = Math.min(brush.start, brush.end);
            const hi = Math.max(brush.start, brush.end);
            const tLo = Math.round(tMin + (lo / rectW) * (tMax - tMin));
            const tHi = Math.round(tMin + (hi / rectW) * (tMax - tMin));
            const dur = tHi - tLo;
            return (
              <>
                <div className="histo-brush" style={{ left: lo, width: Math.max(2, hi - lo) }} />
                <div className="histo-brush-tip" style={{ left: (lo + hi) / 2 }}>
                  {formatSmartDate(tLo)} → {formatSmartDate(tHi)} · {formatDuration(dur)}
                </div>
              </>
            );
          })()}
        {pinned.lo != null && pinned.hi != null && (
          <div
            className="histo-brush pinned"
            style={{
              left: `${pct(pinned.lo, tMin, tMax)}%`,
              right: `${100 - pct(pinned.hi, tMin, tMax)}%`,
              width: "auto",
            }}
          />
        )}
      </div>
      {expanded && (
        <div className="histo-axis">
          {ticks.map((t, i) => (
            <span key={i} style={{ left: `${pct(t, tMin, tMax)}%` }} className="tick">
              {tickFmt(t)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function bucketize(events: LogEvent[]): {
  buckets: Bucket[];
  bucketMs: number;
  tMin: number;
  tMax: number;
} {
  if (events.length === 0) {
    const now = Date.now();
    return { buckets: [], bucketMs: 1000, tMin: now - 60_000, tMax: now };
  }
  let tMin = events[0]!.ts;
  let tMax = events[0]!.ts;
  for (const e of events) {
    if (e.ts < tMin) tMin = e.ts;
    if (e.ts > tMax) tMax = e.ts;
  }
  if (tMax === tMin) tMax = tMin + 1;
  const range = tMax - tMin;
  const bucketMs = pickBucket(range);
  let start = Math.floor(tMin / bucketMs) * bucketMs;
  let end = Math.ceil((tMax + 1) / bucketMs) * bucketMs;
  let n = Math.max(1, Math.round((end - start) / bucketMs));
  // Pad to a minimum column count so a tightly-clustered band still
  // renders as columns instead of a single slab. Centre the populated
  // band by adding empty buckets on both sides.
  if (n < BUCKET_MIN_COUNT) {
    const extra = BUCKET_MIN_COUNT - n;
    const before = Math.floor(extra / 2);
    const after = extra - before;
    start -= before * bucketMs;
    end += after * bucketMs;
    n = BUCKET_MIN_COUNT;
  }
  const buckets: Bucket[] = Array.from({ length: n }, (_, i) => ({
    ts: start + i * bucketMs,
    err: 0,
    warn: 0,
    rest: 0,
    total: 0,
  }));
  for (const e of events) {
    const idx = Math.min(n - 1, Math.max(0, Math.floor((e.ts - start) / bucketMs)));
    const b = buckets[idx]!;
    if (e.level === "error") b.err++;
    else if (e.level === "warn") b.warn++;
    else b.rest++;
    b.total++;
  }
  return { buckets, bucketMs, tMin: start, tMax: end };
}

function pickBucket(rangeMs: number): number {
  for (const size of BUCKET_SIZES_MS) {
    if (rangeMs / size <= BUCKET_TARGET) return size;
  }
  return BUCKET_SIZES_MS[BUCKET_SIZES_MS.length - 1]!;
}

function bucketLabel(bucketMs: number): (ts: number) => string {
  return (ts) => {
    const d = new Date(ts);
    if (bucketMs >= 24 * 60 * 60_000) return `${d.getMonth() + 1}/${d.getDate()}`;
    if (bucketMs >= 60 * 60_000) return `${pad(d.getHours())}:00`;
    if (bucketMs >= 60_000) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function pct(v: number, min: number, max: number): number {
  if (max === min) return 0;
  return ((v - min) / (max - min)) * 100;
}

function makeTicks(tMin: number, tMax: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    out.push(tMin + ((tMax - tMin) * i) / n);
  }
  return out;
}

function collectTs(ast: ReturnType<typeof parse>): { lo: number | null; hi: number | null } {
  if (isError(ast)) return { lo: null, hi: null };
  let lo: number | null = null;
  let hi: number | null = null;
  const walk = (a: typeof ast) => {
    if (isError(a)) return;
    if (a.kind === "key_cmp" && a.key === "ts") {
      if (a.op === "gte" || a.op === "gt") lo = Math.max(lo ?? a.value, a.value);
      if (a.op === "lte" || a.op === "lt") hi = Math.min(hi ?? a.value, a.value);
    } else if (a.kind === "and" || a.kind === "or") {
      walk(a.left);
      walk(a.right);
    } else if (a.kind === "not") {
      walk(a.expr);
    }
  };
  walk(ast);
  return { lo, hi };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)} h`;
  return `${(ms / 86_400_000).toFixed(1)} d`;
}

function applyTsRange(
  query: string,
  lo: number,
  hi: number,
  onFilterChange: (q: string) => void
): void {
  // Strip any existing ts comparison clauses (numeric or quoted-ISO).
  const pat = /(\s+AND\s+|^)ts:(>|>=|<|<=)("(?:\\.|[^"])*"|[^\s)]+)/g;
  let q = query.replace(pat, (_, prefix) => (prefix.startsWith(" AND") ? "" : ""));
  q = q.replace(/ts:(>|>=|<|<=)("(?:\\.|[^"])*"|[^\s)]+)\s+AND\s+/g, "");
  q = q.trim();
  const clauses = [`ts:>="${formatSmartDate(lo)}"`, `ts:<="${formatSmartDate(hi)}"`];
  onFilterChange(q ? `${q} AND ${clauses.join(" AND ")}` : clauses.join(" AND "));
}
