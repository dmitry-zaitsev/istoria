import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useRef } from "react";

import type { Level, LogEvent } from "../lib/ipc";
import { useStore } from "../store";

interface LogStreamProps {
  events: LogEvent[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  bottomInset: number;
}

const ROW_PX = 26;
const STICK_THRESHOLD = 50;

export function LogStream({
  events,
  selectedId,
  onSelect,
  bottomInset,
}: LogStreamProps) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const paused = useStore((s) => s.paused);
  const setPaused = useStore((s) => s.setPaused);
  const pausedBaseline = useStore((s) => s.pausedBaseline);

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
      const atBottom = distanceFromBottom < STICK_THRESHOLD;
      stickToBottom.current = atBottom;
      if (!atBottom && !useStore.getState().paused) {
        setPaused(true, events.length);
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [events.length, setPaused]);

  useLayoutEffect(() => {
    if (paused) return;
    if (!stickToBottom.current || events.length === 0) return;
    virtualizer.scrollToIndex(events.length - 1, { align: "end" });
  }, [events.length, virtualizer, paused]);

  const onSelectInternal = (id: number | null) => {
    if (id != null && !paused) setPaused(true, events.length);
    onSelect(id);
  };

  const resume = () => {
    setPaused(false);
    stickToBottom.current = true;
    if (events.length > 0)
      virtualizer.scrollToIndex(events.length - 1, { align: "end" });
  };

  const newCount = paused ? Math.max(0, events.length - pausedBaseline) : 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " " && paused) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
        e.preventDefault();
        resume();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div
      className="stream"
      ref={parentRef}
      style={{ paddingBottom: bottomInset }}
      tabIndex={0}
    >
      {paused && (
        <div className="pause-pill" role="button" onClick={resume}>
          paused
          <span style={{ color: "var(--ink)" }}> · {newCount.toLocaleString()} new</span>
          <span className="resume">resume ▶</span>
        </div>
      )}
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const ev = events[vi.index];
          if (!ev) return null;
          const cls = levelClass(ev.level);
          const isSel = ev.id === selectedId;
          return (
            <div
              key={ev.id}
              className={`logrow lvl-${cls}${isSel ? " sel" : ""}`}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${vi.start}px)`,
                height: vi.size,
              }}
              onClick={() => onSelectInternal(isSel ? null : ev.id)}
            >
              <span className="ts">{formatTs(ev.ts)}</span>
              <span>
                <span className={`lvl ${cls}`} style={{ display: "block" }}>
                  {cls}
                </span>
              </span>
              <span className="src" title={ev.source}>
                {ev.source}
              </span>
              <span className="msg">{ev.msg || ev.raw}</span>
            </div>
          );
        })}
      </div>
      {!paused && (
        <div className="stream-foot">
          ▼ tailing — newest at bottom · scroll up to pause
        </div>
      )}
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
