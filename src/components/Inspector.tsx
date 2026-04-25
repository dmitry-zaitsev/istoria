import { useEffect, useMemo, useRef, useState } from "react";

import { addClause, removeClause } from "../lib/facets";
import { focusFilterInput } from "../lib/filterFocus";
import type { Level, LogEvent } from "../lib/ipc";
import { isError, parse } from "../lib/query";
import { pinnedFromAst } from "../lib/facets";
import { toast } from "../lib/toast";
import { INSPECTOR_MAX, INSPECTOR_MIN, useStore } from "../store";
import { JsonView } from "./JsonView";

interface InspectorProps {
  event: LogEvent;
  events: LogEvent[];
  onSelect: (id: number) => void;
  onClose: () => void;
}

type Tab = "json" | "stack" | "related" | "raw";

const CORR_KEYS = [
  "request_id",
  "trace_id",
  "correlation_id",
  "span_id",
  "session_id",
];

export function Inspector({ event, events, onSelect, onClose }: InspectorProps) {
  const height = useStore((s) => s.inspectorHeight);
  const setHeight = useStore((s) => s.setInspectorHeight);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const [tab, setTab] = useState<Tab>("json");

  const stackFrames = useMemo(() => extractStack(event), [event]);
  const related = useMemo(() => findRelated(event, events), [event, events]);

  const onAddFilter = (path: string, value: unknown) => {
    if (typeof value === "object" || value == null) return;
    const v = String(value);
    const ast = parse(filter);
    if (!isError(ast)) {
      const pinned = pinnedFromAst(ast).get(path);
      if (pinned?.has(v)) {
        setFilter(removeClause(filter, path, v));
        toast(`Removed ${path}:${v}`);
        return;
      }
    }
    setFilter(addClause(filter, path, v));
    toast(`Added ${path}:${v}`);
  };

  const onAddKeyFilter = (path: string) => {
    const trimmed = filter.replace(/\s+$/, "");
    const next = trimmed ? `${trimmed} AND ${path}:*` : `${path}:*`;
    setFilter(next);
    focusFilterInput();
    toast(`Type a value for ${path}`);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (drawerRef.current?.contains(target)) return;
      if (target.closest(".logrow")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [onClose]);

  const startDrag = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const move = (ev: MouseEvent) => {
      const next = startH + (startY - ev.clientY);
      setHeight(Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, next)));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const fields =
    (event.fields as Record<string, unknown> | undefined) ??
    fieldsFromPlain(event);
  const fieldsCount = Object.keys(fields).length;
  const lvl = levelClass(event.level);

  return (
    <aside
      ref={drawerRef}
      className="inspector"
      style={{ height }}
      role="complementary"
      aria-label="Event inspector"
    >
      <div className="inspector-handle" onMouseDown={startDrag}>
        <i />
      </div>
      <div className="inspector-tabs">
        <TabButton active={tab === "json"} onClick={() => setTab("json")}>
          JSON<span className="ct">{fieldsCount}</span>
        </TabButton>
        <TabButton
          active={tab === "stack"}
          onClick={() => setTab("stack")}
          disabled={stackFrames.length === 0}
        >
          Stack
          {stackFrames.length > 0 && <span className="ct">{stackFrames.length}</span>}
        </TabButton>
        <TabButton
          active={tab === "related"}
          onClick={() => setTab("related")}
          disabled={related.events.length === 0}
        >
          Related
          {related.events.length > 0 && (
            <span className="ct">{related.events.length}</span>
          )}
        </TabButton>
        <TabButton active={tab === "raw"} onClick={() => setTab("raw")}>
          Raw
        </TabButton>
        <div className="inspector-meta">
          <span style={{ fontFamily: "var(--mono)", color: "var(--muted)" }}>
            {formatTsFull(event.ts)}
          </span>
          <span className={`lvl ${lvl}`} style={{ padding: "1px 5px" }}>
            {lvl}
          </span>
          <span
            className="btn sm ghost"
            onClick={() => copy(event)}
            role="button"
          >
            copy
          </span>
          <span
            className="btn sm ghost"
            onClick={onClose}
            role="button"
            aria-label="Close inspector"
          >
            ×
          </span>
        </div>
      </div>
      <div className="inspector-body">
        {tab === "json" && (
          <div className="json">
            <div className="msg-headline">{event.msg || event.raw}</div>
            <JsonView
              value={fields}
              onFilter={onAddFilter}
              onKeyFilter={onAddKeyFilter}
            />
          </div>
        )}
        {tab === "stack" && (
          <div className="stack">
            {stackFrames.length === 0 ? (
              <div className="empty-tab">No stack trace.</div>
            ) : (
              stackFrames.map((f, i) => <div key={i} className="frame">{f}</div>)
            )}
          </div>
        )}
        {tab === "related" && (
          <div className="related">
            {related.events.length === 0 ? (
              <div className="empty-tab">No related events.</div>
            ) : (
              <>
                <div className="related-h">
                  Sharing <code>{related.key}={related.value}</code>
                </div>
                {related.events.map((e) => (
                  <div
                    key={e.id}
                    className={`related-row lvl-${levelClass(e.level)}`}
                    onClick={() => onSelect(e.id)}
                  >
                    <span className="ts">{formatTsFull(e.ts)}</span>
                    <span className={`lvl ${levelClass(e.level)}`}>
                      {levelClass(e.level)}
                    </span>
                    <span className="src">{e.source}</span>
                    <span className="msg">{e.msg || e.raw}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
        {tab === "raw" && (
          <pre className="raw">{event.raw}</pre>
        )}
      </div>
    </aside>
  );
}

function TabButton({
  active,
  onClick,
  disabled,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`inspector-tab${active ? " active" : ""}`}
      type="button"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function extractStack(event: LogEvent): string[] {
  const fields = event.fields as Record<string, unknown> | undefined;
  if (fields) {
    for (const key of ["stack", "stacktrace", "stack_trace", "trace"]) {
      const v = fields[key];
      if (Array.isArray(v))
        return v.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
      if (typeof v === "string") return v.split(/\r?\n/).filter(Boolean);
    }
  }
  // Fallback: detect "at <fn> (<file>:<line>:<col>)" lines in raw/msg.
  const text = `${event.msg}\n${event.raw}`;
  const matches = [...text.matchAll(/\bat\s+\S.*?:\d+:\d+/g)].map((m) => m[0]);
  return matches;
}

function findRelated(
  event: LogEvent,
  all: LogEvent[],
): { key: string; value: string; events: LogEvent[] } {
  const fields = event.fields as Record<string, unknown> | undefined;
  if (!fields) return { key: "", value: "", events: [] };
  for (const key of CORR_KEYS) {
    const v = fields[key];
    if (typeof v !== "string" && typeof v !== "number") continue;
    const value = String(v);
    const matches = all.filter(
      (e) =>
        e.id !== event.id &&
        e.fields != null &&
        String((e.fields as Record<string, unknown>)[key]) === value,
    );
    if (matches.length > 0) return { key, value, events: matches };
  }
  return { key: "", value: "", events: [] };
}

function fieldsFromPlain(event: LogEvent): Record<string, unknown> {
  return {
    id: event.id,
    ts: event.ts,
    source: event.source,
    level: event.level,
    msg: event.msg,
    raw: event.raw,
  };
}

function levelClass(level: Level): "err" | "warn" | "info" | "dbg" {
  switch (level) {
    case "error":
      return "err";
    case "warn":
      return "warn";
    case "debug":
    case "trace":
      return "dbg";
    default:
      return "info";
  }
}

function formatTsFull(unixMs: number): string {
  const d = new Date(unixMs);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(
      d.getMilliseconds(),
      3,
    )}`
  );
}

function copy(event: LogEvent) {
  const txt = JSON.stringify(
    {
      ts: event.ts,
      level: event.level,
      source: event.source,
      msg: event.msg,
      ...(event.fields as Record<string, unknown> | undefined),
    },
    null,
    2,
  );
  navigator.clipboard
    ?.writeText(txt)
    .then(() => toast("Copied"))
    .catch(() => toast("Copy failed"));
}
