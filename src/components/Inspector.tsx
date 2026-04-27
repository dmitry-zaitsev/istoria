import { useEffect, useMemo, useRef, useState } from "react";

import { addClause, removeClause } from "../lib/facets";
import { focusFilterInput } from "../lib/filterFocus";
import { highlight, type HighlightTerm } from "../lib/highlight";
import {
  getCodePreview,
  getEmissionSite,
  type CodeLine,
  type EmissionSite,
  type Level,
  type LogEvent,
} from "../lib/ipc";
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
  highlightTerms: HighlightTerm[];
}

type Tab = "json" | "stack" | "related" | "code" | "raw";

const CORR_KEYS = [
  "request_id",
  "trace_id",
  "correlation_id",
  "span_id",
  "session_id",
];

export function Inspector({
  event,
  events,
  onSelect,
  onClose,
  highlightTerms,
}: InspectorProps) {
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
        <TabButton active={tab === "code"} onClick={() => setTab("code")}>
          Code
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
            <div className="msg-headline">
              {highlight(event.msg || event.raw, highlightTerms)}
            </div>
            <JsonView
              value={fields}
              onFilter={onAddFilter}
              onKeyFilter={onAddKeyFilter}
              highlightTerms={highlightTerms}
            />
          </div>
        )}
        {tab === "stack" && (
          <div className="stack">
            {stackFrames.length === 0 ? (
              <div className="empty-tab">No stack trace.</div>
            ) : (
              stackFrames.map((f, i) => (
                <StackFrame key={i} frame={f} index={i} />
              ))
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
                    <span className="msg">
                      {highlight(e.msg || e.raw, highlightTerms)}
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
        {tab === "code" && <CodeTab event={event} />}
        {tab === "raw" && (
          <pre className="raw">{event.raw}</pre>
        )}
      </div>
    </aside>
  );
}

function CodeTab({ event }: { event: LogEvent }) {
  const [site, setSite] = useState<EmissionSite | null | "loading">("loading");
  useEffect(() => {
    let cancelled = false;
    setSite("loading");
    const msg = event.msg || event.raw;
    getEmissionSite(msg)
      .then((s) => {
        if (!cancelled) setSite(s);
      })
      .catch((e) => {
        if (!cancelled) {
          console.warn("getEmissionSite failed", e);
          setSite(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [event.id, event.msg, event.raw]);

  if (site === "loading") {
    return <div className="empty-tab">Searching project for emission site…</div>;
  }
  if (!site) {
    return (
      <div className="empty-tab">
        Source not found. Either the message wasn't grep-able in the project tree, or this log came from a dependency.
      </div>
    );
  }
  return (
    <div className="code-tab">
      <div className="code-h">
        <span className="code-path">
          {site.rel_path}
          <span className="code-line-no">:{site.line}</span>
        </span>
        {site.is_local && (
          <span className="code-local-badge" title="Commit not on default branch">
            local change
          </span>
        )}
      </div>
      <CodePreview preview={site.preview} highlightLine={site.line} />
    </div>
  );
}

function CodePreview({
  preview,
  highlightLine,
}: {
  preview: CodeLine[];
  highlightLine: number;
}) {
  if (preview.length === 0) {
    return <div className="empty-tab">No preview available.</div>;
  }
  return (
    <pre className="code-preview">
      {preview.map((ln) => (
        <div
          key={ln.line}
          className={`code-row${ln.line === highlightLine ? " hit" : ""}`}
        >
          <span className="code-row-no">{ln.line}</span>
          <span className="code-row-text">{ln.text}</span>
        </div>
      ))}
    </pre>
  );
}

interface ParsedFrame {
  raw: string;
  fn?: string;
  file?: string;
  line?: number;
  col?: number;
}

function parseFrame(raw: string): ParsedFrame {
  const trimmed = raw.replace(/^\s*at\s+/, "").trim();
  // `<fn> (<file>:<line>:<col>)`
  const m1 = trimmed.match(/^(.+?)\s+\((.+?):(\d+)(?::(\d+))?\)$/);
  if (m1) {
    return {
      raw,
      fn: m1[1],
      file: m1[2],
      line: Number(m1[3]),
      col: m1[4] ? Number(m1[4]) : undefined,
    };
  }
  // `<file>:<line>:<col>`
  const m2 = trimmed.match(/^(.+?):(\d+)(?::(\d+))?$/);
  if (m2) {
    return {
      raw,
      file: m2[1],
      line: Number(m2[2]),
      col: m2[3] ? Number(m2[3]) : undefined,
    };
  }
  return { raw, fn: trimmed };
}

function StackFrame({ frame, index }: { frame: string; index: number }) {
  const p = parseFrame(frame);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<CodeLine[] | null | "loading">(null);
  const canExpand = p.file != null && p.line != null;

  useEffect(() => {
    if (!open || preview != null) return;
    if (p.file == null || p.line == null) return;
    setPreview("loading");
    getCodePreview(p.file, p.line, 2)
      .then((rows) => setPreview(rows))
      .catch((e) => {
        console.warn("getCodePreview failed", e);
        setPreview([]);
      });
  }, [open, p.file, p.line, preview]);

  return (
    <div className="frame">
      <div
        className={`frame-h${canExpand ? " clickable" : ""}`}
        onClick={() => canExpand && setOpen((o) => !o)}
      >
        <span className="frame-idx">#{index}</span>
        {p.fn && <span className="frame-fn">{p.fn}</span>}
        {p.file && (
          <span className="frame-loc">
            <span className="frame-file">{p.file}</span>
            {p.line != null && (
              <>
                <span className="frame-sep">:</span>
                <span className="frame-line">{p.line}</span>
                {p.col != null && (
                  <>
                    <span className="frame-sep">:</span>
                    <span className="frame-col">{p.col}</span>
                  </>
                )}
              </>
            )}
          </span>
        )}
        {canExpand && (
          <span className="frame-chevron">{open ? "▾" : "▸"}</span>
        )}
      </div>
      {open && p.line != null && (
        <div className="frame-preview">
          {preview === "loading" && (
            <div className="empty-tab small">Loading…</div>
          )}
          {Array.isArray(preview) && (
            <CodePreview preview={preview} highlightLine={p.line} />
          )}
        </div>
      )}
    </div>
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
