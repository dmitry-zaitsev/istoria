import { useEffect, useRef } from "react";

import type { Level, LogEvent } from "../lib/ipc";
import { INSPECTOR_MAX, INSPECTOR_MIN, useStore } from "../store";
import { JsonView } from "./JsonView";

interface InspectorProps {
  event: LogEvent;
  onClose: () => void;
}

export function Inspector({ event, onClose }: InspectorProps) {
  const height = useStore((s) => s.inspectorHeight);
  const setHeight = useStore((s) => s.setInspectorHeight);
  const drawerRef = useRef<HTMLDivElement | null>(null);

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
        <button className="inspector-tab active" type="button">
          JSON<span className="ct">{fieldsCount}</span>
        </button>
        <button className="inspector-tab" type="button" disabled>
          Stack
        </button>
        <button className="inspector-tab" type="button" disabled>
          Related
        </button>
        <button className="inspector-tab" type="button" disabled>
          Raw
        </button>
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
        <div className="json">
          <div
            style={{
              marginBottom: 12,
              fontSize: 13,
              color: "var(--ink)",
              fontWeight: 500,
            }}
          >
            {event.msg || event.raw}
          </div>
          <JsonView value={fields} />
        </div>
      </div>
    </aside>
  );
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
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
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
  navigator.clipboard?.writeText(txt).catch(() => {});
}
