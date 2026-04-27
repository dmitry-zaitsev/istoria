import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useRef } from "react";

import type { Level, LogEvent } from "../lib/ipc";
import { toast } from "../lib/toast";
import { useStore } from "../store";

interface LogStreamProps {
  events: LogEvent[];
  selectedId: number | null;
  selectedIds: number[];
  onSelect: (id: number | null) => void;
  onSelectIds: (ids: number[]) => void;
  bottomInset: number;
  showSource: boolean;
  alertMatches: Map<number, number[]>;
}

const ROW_PX = 26;
// Tight: any meaningful scroll motion away from the newest end
// flips into pause. 5px tolerates rounding / sub-pixel drift but
// catches a slow finger swipe immediately.
const STICK_THRESHOLD = 5;

export function LogStream({
  events,
  selectedId,
  selectedIds,
  onSelect,
  onSelectIds,
  bottomInset,
  showSource,
  alertMatches,
}: LogStreamProps) {
  const selectedSet = new Set(selectedIds);
  const alerts = useStore((s) => s.alerts);
  const alertColorById = new Map(alerts.map((a) => [a.id, a.color]));
  const parentRef = useRef<HTMLDivElement | null>(null);
  const stickToNewest = useRef(true);
  const paused = useStore((s) => s.paused);
  const setPaused = useStore((s) => s.setPaused);
  const newCount = useStore((s) => s.newCount);
  const sort = useStore((s) => s.sort);
  const liveTail = true;
  const newestAtTop = sort === "newest-top";

  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_PX,
    overscan: 12,
  });

  const isAtNewestEnd = (el: HTMLDivElement) => {
    if (newestAtTop) return el.scrollTop < STICK_THRESHOLD;
    return el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
  };

  const scrollToNewest = () => {
    if (events.length === 0) return;
    if (newestAtTop) virtualizer.scrollToIndex(0, { align: "start" });
    else virtualizer.scrollToIndex(events.length - 1, { align: "end" });
  };

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const onScroll = () => {
      const at = isAtNewestEnd(el);
      stickToNewest.current = at;
      const wasPaused = useStore.getState().paused;
      if (!at && !wasPaused) setPaused(true, events.length);
      if (at && wasPaused) setPaused(false);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [events.length, setPaused, newestAtTop]);

  useLayoutEffect(() => {
    if (paused || !liveTail) return;
    if (!stickToNewest.current || events.length === 0) return;
    scrollToNewest();
  }, [events.length, virtualizer, paused, liveTail, newestAtTop]);

  const onRowClick = (id: number, e: React.MouseEvent) => {
    if (!paused) setPaused(true, events.length);
    if (e.shiftKey) {
      // Drop any text selection the browser started before our
      // mousedown intercept could land.
      window.getSelection()?.removeAllRanges();
      // Anchor: primary selection if any, else last item in current
      // multi-set, else just select the clicked row.
      const anchor =
        selectedId ?? selectedIds[selectedIds.length - 1] ?? null;
      if (anchor != null) {
        const a = events.findIndex((x) => x.id === anchor);
        const b = events.findIndex((x) => x.id === id);
        if (a >= 0 && b >= 0) {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const ids = events.slice(lo, hi + 1).map((x) => x.id);
          onSelectIds(ids);
          return;
        }
      }
      onSelect(id);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onSelectIds([...next]);
      return;
    }
    onSelect(selectedSet.has(id) && selectedIds.length === 1 ? null : id);
  };

  const resume = () => {
    setPaused(false);
    stickToNewest.current = true;
    scrollToNewest();
  };


  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inField =
        target.tagName === "INPUT" || target.tagName === "TEXTAREA";
      if (e.key === " " && paused && !inField) {
        e.preventDefault();
        resume();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "c" && !inField) {
        if (selectedIds.length === 0) return;
        const picked = events.filter((ev) => selectedSet.has(ev.id));
        const txt = picked.map((ev) => JSON.stringify(ev)).join("\n");
        navigator.clipboard
          ?.writeText(txt)
          .then(() => toast(`Copied ${picked.length} row${picked.length === 1 ? "" : "s"}`))
          .catch(() => toast("Copy failed"));
        e.preventDefault();
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key === "a" &&
        !inField &&
        !target.closest(".filter-bar")
      ) {
        e.preventDefault();
        onSelectIds(events.map((ev) => ev.id));
      }
      if (e.key === "Escape" && !inField) {
        if (selectedIds.length > 0 || selectedId != null) {
          e.preventDefault();
          onSelect(null);
          onSelectIds([]);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Resume affordance: only when paused, new events arrived, AND we
  // are not already sitting at the newest-end position.
  const showPill = paused && newCount > 0;

  return (
    <div
      className="stream"
      ref={parentRef}
      style={{ paddingBottom: bottomInset }}
      tabIndex={0}
    >
      {showPill && (
        <div className="pause-pill" role="button" onClick={resume}>
          <span style={{ color: "var(--ink)" }}>
            {newCount.toLocaleString()} new
          </span>
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
          const isSel = selectedSet.has(ev.id);
          const isPrimary = ev.id === selectedId;
          const matchedIds = alertMatches.get(ev.id);
          const alertColor =
            matchedIds && matchedIds.length > 0
              ? alertColorById.get(matchedIds[0]!)
              : undefined;
          return (
            <div
              key={ev.id}
              className={`logrow lvl-${cls}${isSel ? " sel" : ""}${
                isPrimary ? " primary" : ""
              }${alertColor ? ` alert-${alertColor}` : ""}${showSource ? "" : " no-src"}`}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${vi.start}px)`,
                height: vi.size,
              }}
              onMouseDown={(e) => {
                // Suppress browser text-selection on shift+click range
                // picks; rows aren't text first, they're targets.
                if (e.shiftKey) e.preventDefault();
              }}
              onClick={(e) => onRowClick(ev.id, e)}
            >
              <span className="ts">{formatTs(ev.ts)}</span>
              <span>
                <span className={`lvl ${cls}`} style={{ display: "block" }}>
                  {cls}
                </span>
              </span>
              {showSource && (
                <span className="src" title={ev.source}>
                  {ev.source}
                </span>
              )}
              <span className="msg">{ev.msg || ev.raw}</span>
            </div>
          );
        })}
      </div>
      {!paused && liveTail && (
        <div className="stream-foot">
          ▼ tailing — newest at {newestAtTop ? "top" : "bottom"} · scroll{" "}
          {newestAtTop ? "down" : "up"} to pause
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
