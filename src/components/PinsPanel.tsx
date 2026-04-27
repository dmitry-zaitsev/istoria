import { useEffect, useRef } from "react";

import { unpinEvent, type LogEvent } from "../lib/ipc";
import { toast } from "../lib/toast";
import { useStore } from "../store";

interface PinsPanelProps {
  events: LogEvent[];
  open: boolean;
  onClose: () => void;
}

export function PinsPanel({ events, open, onClose }: PinsPanelProps) {
  const pinnedIds = useStore((s) => s.pinnedIds);
  const togglePinLocal = useStore((s) => s.togglePinLocal);
  const setSelected = useStore((s) => s.setSelected);
  const setScrollTarget = useStore((s) => s.setScrollTarget);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const byId = new Map(events.map((e) => [e.id, e]));
  const orderedIds = [...pinnedIds];
  const present = orderedIds.filter((id) => byId.has(id));
  const absent = orderedIds.filter((id) => !byId.has(id));

  const goTo = (id: number) => {
    setSelected(id);
    setScrollTarget(id);
    onClose();
  };

  const unpin = (id: number) => {
    togglePinLocal(id);
    unpinEvent(id)
      .then(() => toast("Unpinned"))
      .catch((e) => {
        togglePinLocal(id);
        toast(`Unpin failed: ${String(e)}`);
      });
  };

  return (
    <div className="pins-panel" ref={ref} role="dialog" aria-label="Pinned events">
      <div className="pins-panel-h">
        Pinned
        <span style={{ color: "var(--muted-2)" }}>{pinnedIds.size}</span>
      </div>
      {pinnedIds.size === 0 && (
        <div className="pins-empty">No pins yet. Click ☆ on a row, or press <kbd>p</kbd> on the selected row.</div>
      )}
      {present.length > 0 && (
        <div className="pins-list">
          {present.map((id) => {
            const e = byId.get(id)!;
            return (
              <div
                key={id}
                className={`pins-row lvl-${levelClass(e.level)}`}
                onClick={() => goTo(id)}
              >
                <span className="ts">{formatTs(e.ts)}</span>
                <span className={`lvl ${levelClass(e.level)}`}>{levelClass(e.level)}</span>
                <span className="msg">{e.msg || e.raw}</span>
                <button
                  type="button"
                  className="pin-btn on"
                  title="Unpin"
                  aria-label="Unpin"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    unpin(id);
                  }}
                >
                  ★
                </button>
              </div>
            );
          })}
        </div>
      )}
      {absent.length > 0 && (
        <div className="pins-absent">
          {absent.length} pinned event{absent.length === 1 ? "" : "s"} not in current view (cleared from buffer or filtered out).
        </div>
      )}
    </div>
  );
}

function levelClass(level: LogEvent["level"]): "err" | "warn" | "info" | "dbg" {
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

function formatTs(unixMs: number): string {
  const d = new Date(unixMs);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
