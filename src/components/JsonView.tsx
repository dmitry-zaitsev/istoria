import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { highlight, type HighlightTerm } from "../lib/highlight";

interface JsonViewProps {
  value: unknown;
  onFilter?: (path: string, value: unknown) => void;
  onKeyFilter?: (path: string) => void;
  onExclude?: (path: string, value: unknown) => void;
  onExcludeKey?: (path: string) => void;
  onToggleColumn?: (path: string) => void;
  isColumn?: (path: string) => boolean;
  highlightTerms?: HighlightTerm[];
}

const TS_KEYS = new Set([
  "ts",
  "timestamp",
  "time",
  "created_at",
  "updated_at",
  "ended_at",
  "started_at",
]);
const TS_MS_FLOOR = 1_000_000_000_000; // 2001-09-09 — anything above this is plausibly Unix-ms.

type PopoverState =
  | {
      kind: "value";
      path: string;
      value: unknown;
      anchor: DOMRect;
    }
  | {
      kind: "key";
      path: string;
      anchor: DOMRect;
    };

interface OpenPopover {
  (state: PopoverState): void;
}

export function JsonView({
  value,
  onFilter,
  onKeyFilter,
  onExclude,
  onExcludeKey,
  onToggleColumn,
  isColumn,
  highlightTerms,
}: JsonViewProps) {
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const closePopover = () => setPopover(null);
  const canOpen = !!onFilter || !!onKeyFilter || !!onToggleColumn;

  return (
    <>
      <Node
        value={value}
        indent={0}
        path=""
        openPopover={canOpen ? setPopover : undefined}
        canFilterValue={!!onFilter || !!onToggleColumn}
        canFilterKey={!!onKeyFilter || !!onToggleColumn}
        highlightTerms={highlightTerms}
      />
      {popover && (
        <ValuePopover
          state={popover}
          onClose={closePopover}
          onFilter={onFilter}
          onKeyFilter={onKeyFilter}
          onExclude={onExclude}
          onExcludeKey={onExcludeKey}
          onToggleColumn={onToggleColumn}
          isColumn={isColumn}
        />
      )}
    </>
  );
}

interface NodeProps {
  value: unknown;
  indent: number;
  keyName?: string;
  path: string;
  openPopover?: OpenPopover;
  canFilterValue: boolean;
  canFilterKey: boolean;
  highlightTerms?: HighlightTerm[];
}

function Node({
  value,
  indent,
  keyName,
  path,
  openPopover,
  canFilterValue,
  canFilterKey,
  highlightTerms,
}: NodeProps) {
  if (value === null) return <span className="p">null</span>;
  if (typeof value === "string")
    return (
      <Filterable
        path={path}
        value={value}
        openPopover={openPopover}
        canFilter={canFilterValue}
      >
        <span className="s">
          "{highlightTerms && highlightTerms.length > 0
            ? highlight(escape(value), highlightTerms)
            : escape(value)}"
        </span>
      </Filterable>
    );
  if (typeof value === "number") {
    return (
      <Filterable
        path={path}
        value={value}
        openPopover={openPopover}
        canFilter={canFilterValue}
      >
        <NumberNode value={value} keyName={keyName} />
      </Filterable>
    );
  }
  if (typeof value === "boolean")
    return (
      <Filterable
        path={path}
        value={value}
        openPopover={openPopover}
        canFilter={canFilterValue}
      >
        <span className="b">{String(value)}</span>
      </Filterable>
    );
  if (Array.isArray(value))
    return (
      <Arr
        items={value}
        indent={indent}
        path={path}
        openPopover={openPopover}
        canFilterValue={canFilterValue}
        canFilterKey={canFilterKey}
        highlightTerms={highlightTerms}
      />
    );
  if (typeof value === "object")
    return (
      <Obj
        obj={value as Record<string, unknown>}
        indent={indent}
        path={path}
        openPopover={openPopover}
        canFilterValue={canFilterValue}
        canFilterKey={canFilterKey}
        highlightTerms={highlightTerms}
      />
    );
  return <span>{String(value)}</span>;
}

function Filterable({
  path,
  value,
  openPopover,
  canFilter,
  children,
}: {
  path: string;
  value: unknown;
  openPopover?: OpenPopover;
  canFilter: boolean;
  children: React.ReactNode;
}) {
  if (!canFilter || !openPopover || !path) return <>{children}</>;
  return (
    <span
      className="filterable"
      title={`Click for options on ${path}`}
      onClick={(e) => {
        e.stopPropagation();
        openPopover({
          kind: "value",
          path,
          value,
          anchor: e.currentTarget.getBoundingClientRect(),
        });
      }}
    >
      {children}
    </span>
  );
}

function NumberNode({ value, keyName }: { value: number; keyName?: string }) {
  const isTs =
    keyName != null &&
    TS_KEYS.has(keyName) &&
    Number.isFinite(value) &&
    value >= TS_MS_FLOOR;
  if (!isTs) return <span className="n">{String(value)}</span>;
  return (
    <>
      <span className="n">{String(value)}</span>
      <span className="p" title="ISO local time">
        {" · "}
        {formatIso(value)}
      </span>
    </>
  );
}

function formatIso(unixMs: number): string {
  const d = new Date(unixMs);
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(
      d.getMilliseconds(),
      3,
    )}`
  );
}

function Obj({
  obj,
  indent,
  path,
  openPopover,
  canFilterValue,
  canFilterKey,
  highlightTerms,
}: {
  obj: Record<string, unknown>;
  indent: number;
  path: string;
  openPopover?: OpenPopover;
  canFilterValue: boolean;
  canFilterKey: boolean;
  highlightTerms?: HighlightTerm[];
}) {
  const entries = Object.entries(obj);
  if (entries.length === 0) return <span className="p">{"{}"}</span>;
  return (
    <>
      <span className="p">{"{"}</span>
      {entries.map(([k, v], i) => {
        const childPath = path ? `${path}.${k}` : k;
        const keyClickable = canFilterKey && openPopover != null;
        return (
          <div key={k} className="row indent">
            {keyClickable ? (
              <span
                className="k filterable filterable-key"
                title={`Click for options on ${childPath}`}
                onClick={(e) => {
                  e.stopPropagation();
                  openPopover!({
                    kind: "key",
                    path: childPath,
                    anchor: e.currentTarget.getBoundingClientRect(),
                  });
                }}
              >
                "{k}"
              </span>
            ) : (
              <span className="k">"{k}"</span>
            )}
            <span className="p">: </span>
            <Node
              value={v}
              indent={indent + 1}
              keyName={k}
              path={childPath}
              openPopover={openPopover}
              canFilterValue={canFilterValue}
              canFilterKey={canFilterKey}
              highlightTerms={highlightTerms}
            />
            {i < entries.length - 1 && <span className="p">,</span>}
          </div>
        );
      })}
      <span className="p">{"}"}</span>
    </>
  );
}

function Arr({
  items,
  indent,
  path,
  openPopover,
  canFilterValue,
  canFilterKey,
  highlightTerms,
}: {
  items: unknown[];
  indent: number;
  path: string;
  openPopover?: OpenPopover;
  canFilterValue: boolean;
  canFilterKey: boolean;
  highlightTerms?: HighlightTerm[];
}) {
  if (items.length === 0) return <span className="p">[]</span>;
  return (
    <>
      <span className="p">{"["}</span>
      {items.map((v, i) => (
        <div key={i} className="row indent">
          <Node
            value={v}
            indent={indent + 1}
            path={`${path}.${i}`}
            openPopover={openPopover}
            canFilterValue={canFilterValue}
            canFilterKey={canFilterKey}
            highlightTerms={highlightTerms}
          />
          {i < items.length - 1 && <span className="p">,</span>}
        </div>
      ))}
      <span className="p">{"]"}</span>
    </>
  );
}

function ValuePopover({
  state,
  onClose,
  onFilter,
  onKeyFilter,
  onExclude,
  onExcludeKey,
  onToggleColumn,
  isColumn,
}: {
  state: PopoverState;
  onClose: () => void;
  onFilter?: (path: string, value: unknown) => void;
  onKeyFilter?: (path: string) => void;
  onExclude?: (path: string, value: unknown) => void;
  onExcludeKey?: (path: string) => void;
  onToggleColumn?: (path: string) => void;
  isColumn?: (path: string) => boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({
    top: state.anchor.bottom + 4,
    left: state.anchor.left,
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let top = state.anchor.bottom + 4;
    let left = state.anchor.left;
    if (left + rect.width > window.innerWidth - pad) {
      left = Math.max(pad, window.innerWidth - rect.width - pad);
    }
    if (top + rect.height > window.innerHeight - pad) {
      // Flip above the anchor.
      top = Math.max(pad, state.anchor.top - rect.height - 4);
    }
    setPos({ top, left });
  }, [state.anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [onClose]);

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
  };

  const items: { label: string; onClick: () => void; danger?: boolean }[] = [];
  const display =
    state.kind === "value"
      ? formatValuePreview(state.value)
      : state.path;

  const columnLabel =
    onToggleColumn != null
      ? isColumn?.(state.path)
        ? "Hide column"
        : "Show as column"
      : null;

  if (state.kind === "value") {
    if (onFilter) {
      items.push({
        label: "Filter by value",
        onClick: () => onFilter(state.path, state.value),
      });
    }
    if (onExclude) {
      items.push({
        label: "Exclude value",
        onClick: () => onExclude(state.path, state.value),
      });
    }
    if (columnLabel) {
      items.push({
        label: columnLabel,
        onClick: () => onToggleColumn!(state.path),
      });
    }
    items.push({
      label: "Copy value",
      onClick: () => copy(stringifyValue(state.value)),
    });
    items.push({
      label: "Copy key path",
      onClick: () => copy(state.path),
    });
  } else {
    if (onKeyFilter) {
      items.push({
        label: "Filter by key",
        onClick: () => onKeyFilter(state.path),
      });
    }
    if (onExcludeKey) {
      items.push({
        label: "Exclude key",
        onClick: () => onExcludeKey(state.path),
      });
    }
    if (columnLabel) {
      items.push({
        label: columnLabel,
        onClick: () => onToggleColumn!(state.path),
      });
    }
    items.push({
      label: "Copy key path",
      onClick: () => copy(state.path),
    });
  }

  return (
    <div
      ref={ref}
      className="json-popover"
      role="menu"
      style={{ top: pos.top, left: pos.left }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="json-popover-header" title={display}>
        <span className="json-popover-path">{state.path}</span>
        {state.kind === "value" && (
          <span className="json-popover-value">{display}</span>
        )}
      </div>
      {items.map((it, i) => (
        <button
          key={i}
          type="button"
          className={`json-popover-item${it.danger ? " danger" : ""}`}
          role="menuitem"
          onClick={() => {
            it.onClick();
            onClose();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

function stringifyValue(v: unknown): string {
  if (typeof v === "string") return v;
  return String(v);
}

function formatValuePreview(v: unknown): string {
  const s = stringifyValue(v);
  if (s.length > 80) return s.slice(0, 77) + "…";
  return s;
}

function escape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}
