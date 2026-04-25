import { useEffect, useRef, useState } from "react";

import type { LogEvent } from "../lib/ipc";
import {
  INSPECTOR_MAX,
  INSPECTOR_MIN,
  useStore,
} from "../store";
import { JsonView } from "./JsonView";

interface InspectorProps {
  event: LogEvent;
  onClose: () => void;
}

type Tab = "json" | "stack" | "related" | "raw";

export function Inspector({ event, onClose }: InspectorProps) {
  const height = useStore((s) => s.inspectorHeight);
  const setHeight = useStore((s) => s.setInspectorHeight);
  const [tab] = useState<Tab>("json");
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

  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    document.body.style.cursor = "ns-resize";
    const move = (ev: PointerEvent) => {
      const next = startH + (startY - ev.clientY);
      setHeight(Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, next)));
    };
    const up = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      document.body.style.cursor = "";
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };

  const fields =
    (event.fields as Record<string, unknown> | undefined) ??
    fieldsFromPlain(event);

  return (
    <aside
      ref={drawerRef}
      className="inspector"
      style={{ height }}
      role="complementary"
      aria-label="Event inspector"
    >
      <div
        className="inspector-handle"
        onPointerDown={onHandlePointerDown}
        title="Drag to resize"
      />
      <div className="inspector-tabs">
        <button
          className={`inspector-tab${tab === "json" ? " active" : ""}`}
          type="button"
        >
          JSON
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
        <div className="inspector-tabs-spacer" />
        <button
          className="inspector-close"
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
        >
          ×
        </button>
      </div>
      <div className="inspector-body">
        <JsonView value={fields} />
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
