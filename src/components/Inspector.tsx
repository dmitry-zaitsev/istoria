import { useEffect, useMemo, useRef, useState } from "react";

import { addClause, addNotClause, removeClause } from "../lib/facets";
import { focusFilterInput } from "../lib/filterFocus";
import { highlight, type HighlightTerm } from "../lib/highlight";
import {
  getCodePreview,
  getEmissionSite,
  listEditors,
  openUrl,
  type CodeLine,
  type EditorEntry,
  type EmissionSite,
  type Level,
  type LogEvent,
} from "../lib/ipc";
import { highlightLine, languageForPath } from "../lib/syntax";
import { isError, parse, renderValue } from "../lib/query";
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

  // Pre-fetch emission site so the Code tab can be disabled with a
  // tooltip when there's no match in the project tree. Re-fetched per
  // event; cached server-side by msg.
  const [emissionSite, setEmissionSite] = useState<
    EmissionSite | null | "loading"
  >("loading");
  useEffect(() => {
    let cancelled = false;
    setEmissionSite("loading");
    if (!event.msg) {
      setEmissionSite(null);
      return;
    }
    getEmissionSite(event.msg)
      .then((s) => {
        if (!cancelled) setEmissionSite(s);
      })
      .catch((e) => {
        if (!cancelled) {
          console.warn("getEmissionSite failed", e);
          setEmissionSite(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [event.id, event.msg]);

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

  const onExcludeFilter = (path: string, value: unknown) => {
    if (typeof value === "object" || value == null) return;
    const v = String(value);
    const clause = `${path}:${renderValue(v)}`;
    setFilter(addNotClause(filter, clause));
    toast(`Excluded ${path}:${v}`);
  };

  const onExcludeKeyFilter = (path: string) => {
    setFilter(addNotClause(filter, `${path}:*`));
    toast(`Excluded ${path}`);
  };

  const fieldColumns = useStore((s) => s.fieldColumns);
  const toggleFieldColumn = useStore((s) => s.toggleFieldColumn);
  const onToggleColumn = (path: string) => {
    const exists = fieldColumns.some((c) => c.path === path);
    toggleFieldColumn(path);
    toast(exists ? `Hid column ${path}` : `Added column ${path}`);
  };
  const isColumn = (path: string) =>
    fieldColumns.some((c) => c.path === path);

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

  const fields = (() => {
    const base =
      (event.fields as Record<string, unknown> | undefined) ??
      fieldsFromPlain(event);
    // Surface top-level event metadata in the JSON view so users can
    // see (and filter on) `branch` / `source` even when the producer's
    // payload omits them. JSON payload values win on key conflict.
    const augmented: Record<string, unknown> = {};
    if (event.branch) augmented.branch = event.branch;
    return { ...augmented, ...base };
  })();
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
        <TabButton
          active={tab === "code"}
          onClick={() => setTab("code")}
          disabled={emissionSite === null}
          title={
            emissionSite === null
              ? "Source not found in project — message could not be located in any source file"
              : undefined
          }
        >
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
              onExclude={onExcludeFilter}
              onExcludeKey={onExcludeKeyFilter}
              onToggleColumn={onToggleColumn}
              isColumn={isColumn}
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
        {tab === "code" && <CodeTab site={emissionSite} />}
        {tab === "raw" && (
          <pre className="raw">{event.raw}</pre>
        )}
      </div>
    </aside>
  );
}

function CodeTab({ site }: { site: EmissionSite | null | "loading" }) {
  if (site === "loading") {
    return <div className="empty-tab">Searching project for emission site…</div>;
  }
  if (!site) {
    // Tab is disabled when site is null, but if a saved tab state lands
    // here defensively render the same explanation text.
    return (
      <div className="empty-tab">
        Source not found in project.
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
        <OpenInIde absPath={site.path} line={site.line} />
      </div>
      <CodePreview
        preview={site.preview}
        highlightLine={site.line}
        path={site.rel_path}
      />
    </div>
  );
}

const LAST_EDITOR_KEY = "last_editor_id";

function buildOpenUrl(template: string, path: string, line: number): string {
  return template
    .replace("{path}", encodeURI(path))
    .replace("{line}", String(line));
}

function OpenInIde({ absPath, line }: { absPath: string; line: number }) {
  const [editors, setEditors] = useState<EditorEntry[]>([]);
  const [lastId, setLastId] = useState<string | null>(() =>
    localStorage.getItem(LAST_EDITOR_KEY),
  );
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    listEditors()
      .then((list) => {
        if (!cancelled) setEditors(list);
      })
      .catch((e) => console.warn("listEditors failed", e));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (editors.length === 0) {
    return (
      <span className="open-in-ide-empty" title="No supported editors detected in /Applications">
        no editor detected
      </span>
    );
  }

  const primary =
    editors.find((e) => e.id === lastId) ?? editors[0]!;
  const others = editors.filter((e) => e.id !== primary.id);

  const launch = (e: EditorEntry) => {
    setLastId(e.id);
    localStorage.setItem(LAST_EDITOR_KEY, e.id);
    setOpen(false);
    openUrl(buildOpenUrl(e.url_template, absPath, line)).catch((err) =>
      toast(`open failed: ${String(err)}`),
    );
  };

  return (
    <div className="open-in-ide" ref={ref}>
      <div className="open-in-ide-split">
        <button
          type="button"
          className="open-in-ide-primary"
          onClick={() => launch(primary)}
          title={`Open in ${primary.name}`}
        >
          open in {primary.name}
        </button>
        {others.length > 0 && (
          <button
            type="button"
            className="open-in-ide-caret"
            onClick={() => setOpen((x) => !x)}
            aria-label="More editors"
          >
            ▾
          </button>
        )}
      </div>
      {open && others.length > 0 && (
        <div className="open-in-ide-menu">
          {others.map((e) => (
            <div
              key={e.id}
              className="open-in-ide-item"
              onClick={() => launch(e)}
            >
              {e.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CodePreview({
  preview,
  highlightLine: hitLine,
  path,
}: {
  preview: CodeLine[];
  highlightLine: number;
  path?: string;
}) {
  if (preview.length === 0) {
    return <div className="empty-tab">No preview available.</div>;
  }
  const lang = path ? languageForPath(path) : null;
  return (
    <pre className="code-preview hljs">
      {preview.map((ln) => (
        <div
          key={ln.line}
          className={`code-row${ln.line === hitLine ? " hit" : ""}`}
        >
          <span className="code-row-no">{ln.line}</span>
          <span
            className="code-row-text"
            dangerouslySetInnerHTML={{ __html: highlightLine(ln.text, lang) }}
          />
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
            <CodePreview preview={preview} highlightLine={p.line} path={p.file} />
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
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`inspector-tab${active ? " active" : ""}`}
      type="button"
      disabled={disabled}
      title={title}
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
  const out: Record<string, unknown> = {
    id: event.id,
    ts: event.ts,
    source: event.source,
    level: event.level,
    msg: event.msg,
    raw: event.raw,
  };
  if (event.branch) out.branch = event.branch;
  return out;
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
