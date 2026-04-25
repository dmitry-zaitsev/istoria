import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useRef } from "react";

import type { LogEvent } from "../lib/ipc";

interface LogStreamProps {
  events: LogEvent[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}

const ROW_PX = 24;

export function LogStream({ events, selectedId, onSelect }: LogStreamProps) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_PX,
    overscan: 12,
  });

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const onScroll = () => {
      const distanceFromBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottom.current = distanceFromBottom < 4;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    if (!stickToBottom.current || events.length === 0) return;
    virtualizer.scrollToIndex(events.length - 1, { align: "end" });
  }, [events.length, virtualizer]);

  return (
    <div className="stream" ref={parentRef}>
      <div
        className="stream-spacer"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const ev = events[vi.index];
          const isSel = ev.id === selectedId;
          const levelClass = `lvl-row-${ev.level === "error" ? "err" : ev.level === "warn" ? "warn" : ev.level === "debug" ? "dbg" : "info"}`;
          const lvlChip = `lvl-${ev.level === "error" ? "err" : ev.level === "warn" ? "warn" : ev.level === "debug" ? "dbg" : "info"}`;
          return (
            <div
              key={ev.id}
              className={`logrow ${levelClass}${isSel ? " sel" : ""}`}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${vi.start}px)`,
                height: vi.size,
              }}
              onClick={() => onSelect(isSel ? null : ev.id)}
            >
              <span className="ts">{formatTs(ev.ts)}</span>
              <span className="src" title={ev.source}>
                {ev.source}
              </span>
              <span className={`lvl ${lvlChip}`}>
                {labelForLevel(ev.level)}
              </span>
              <span className="msg">{ev.msg || ev.raw}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatTs(unixMs: number): string {
  const d = new Date(unixMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function labelForLevel(level: LogEvent["level"]): string {
  switch (level) {
    case "error":
      return "ERR";
    case "warn":
      return "WARN";
    case "debug":
      return "DBG";
    case "trace":
      return "TRC";
    default:
      return "INFO";
  }
}
