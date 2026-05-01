import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useRef } from "react";

import { highlight, type HighlightTerm } from "../lib/highlight";
import { pinEvent, unpinEvent, type Level, type LogEvent } from "../lib/ipc";
import { toast } from "../lib/toast";
import { useStore, type ColKey, type FieldColumn } from "../store";

interface LogStreamProps {
  events: LogEvent[];
  selectedId: number | null;
  selectedIds: number[];
  onSelect: (id: number | null) => void;
  onSelectIds: (ids: number[]) => void;
  bottomInset: number;
  visibility: Record<ColKey, boolean>;
  fieldColumns: FieldColumn[];
  highlightTerms: HighlightTerm[];
  alertMatches: Map<number, string[]>;
  relevanceRe: RegExp | null;
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
  visibility,
  fieldColumns,
  highlightTerms,
  alertMatches,
  relevanceRe,
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
  const pinnedIds = useStore((s) => s.pinnedIds);
  const togglePinLocal = useStore((s) => s.togglePinLocal);
  const scrollTargetId = useStore((s) => s.scrollTargetId);
  const setScrollTarget = useStore((s) => s.setScrollTarget);
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

  const applyRange = (anchorId: number, endId: number) => {
    const a = events.findIndex((x) => x.id === anchorId);
    const b = events.findIndex((x) => x.id === endId);
    if (a < 0 || b < 0) {
      onSelect(endId);
      return;
    }
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const ids = events.slice(lo, hi + 1).map((x) => x.id);
    onSelectIds(ids);
  };

  const dragRef = useRef<{ anchor: number; lastEnd: number } | null>(null);

  const onRowMouseDown = (id: number, e: React.MouseEvent) => {
    if (!e.shiftKey) return;
    // Suppress browser text-selection on shift+click and shift+drag;
    // rows aren't text first, they're targets.
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    if (!paused) setPaused(true, events.length);
    const anchor = selectedId ?? selectedIds[selectedIds.length - 1] ?? id;
    dragRef.current = { anchor, lastEnd: id };
    document.body.classList.add("range-dragging");
    applyRange(anchor, id);

    const onMove = (ev: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const rowEl = target?.closest<HTMLElement>("[data-row-id]");
      if (!rowEl) return;
      const rid = Number(rowEl.dataset.rowId);
      if (!Number.isFinite(rid) || rid === drag.lastEnd) return;
      drag.lastEnd = rid;
      applyRange(drag.anchor, rid);
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.classList.remove("range-dragging");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onRowClick = (id: number, e: React.MouseEvent) => {
    if (!paused) setPaused(true, events.length);
    if (e.shiftKey) {
      // Range already applied on mousedown / drag; no-op on click so we
      // don't clobber a drag-extended selection.
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

  const togglePin = (id: number) => {
    const isPinned = pinnedIds.has(id);
    togglePinLocal(id);
    const op = isPinned ? unpinEvent(id) : pinEvent(id);
    op
      .then(() => toast(isPinned ? "Unpinned" : "Pinned"))
      .catch((e) => {
        // revert on failure
        togglePinLocal(id);
        toast(`Pin failed: ${String(e)}`);
      });
  };

  // Scroll to a requested event id (from PinsPanel etc.). Defers one
  // frame so the inspector's bottom inset is in the DOM first; then
  // nudges scrollTop up by half the inset since the virtualizer
  // centers on the parent's clientHeight, not the visible area above
  // the inspector overlay.
  useEffect(() => {
    if (scrollTargetId == null) return;
    const idx = events.findIndex((e) => e.id === scrollTargetId);
    if (idx < 0) {
      setScrollTarget(null);
      return;
    }
    const raf = requestAnimationFrame(() => {
      virtualizer.scrollToIndex(idx, { align: "center" });
      const el = parentRef.current;
      if (el && bottomInset > 0) {
        el.scrollTop += bottomInset / 2;
      }
      setScrollTarget(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [scrollTargetId, events, virtualizer, setScrollTarget, bottomInset]);


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
        // Defer to native copy when user has a text selection.
        if (window.getSelection()?.toString()) return;
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
      if (e.key === "p" && !inField && !e.metaKey && !e.ctrlKey) {
        if (selectedId != null) {
          e.preventDefault();
          togglePin(selectedId);
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
          const isPinned = pinnedIds.has(ev.id);
          const matchedIds = alertMatches.get(ev.id);
          const alertColor =
            matchedIds && matchedIds.length > 0
              ? alertColorById.get(matchedIds[0]!)
              : undefined;
          const isRelevant =
            relevanceRe != null &&
            (relevanceRe.test(ev.msg) || relevanceRe.test(ev.raw));
          return (
            <div
              key={ev.id}
              data-row-id={ev.id}
              className={`logrow lvl-${cls}${isSel ? " sel" : ""}${
                isPrimary ? " primary" : ""
              }${isPinned ? " pinned" : ""}${alertColor ? ` alert-${alertColor}` : ""}${
                isRelevant ? " relevant" : ""
              }`}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${vi.start}px)`,
                height: vi.size,
              }}
              onMouseDown={(e) => onRowMouseDown(ev.id, e)}
              onClick={(e) => onRowClick(ev.id, e)}
            >
              {visibility.ts && (
                <span className="ts">{formatTs(ev.ts)}</span>
              )}
              {visibility.lvl && (
                <span>
                  <span className={`lvl ${cls}`} style={{ display: "block" }}>
                    {cls}
                  </span>
                </span>
              )}
              {visibility.src && (
                <span className="src" title={ev.source}>
                  {ev.source}
                </span>
              )}
              {visibility.br && (
                <span className="br" title={ev.branch}>
                  {ev.branch}
                </span>
              )}
              {fieldColumns.map((fc) => {
                const v = getValueAtPath(ev.fields, fc.path);
                const empty = v === undefined || v === null;
                const text = empty ? "—" : formatFieldValue(v);
                return (
                  <span
                    key={fc.path}
                    className={`field-cell${empty ? " empty" : ""}`}
                    title={empty ? "" : text}
                  >
                    {text}
                  </span>
                );
              })}
              <span className="msg">
                {highlight(ev.msg || ev.raw, highlightTerms)}
              </span>
              <button
                type="button"
                className={`pin-btn${isPinned ? " on" : ""}`}
                title={isPinned ? "Unpin" : "Pin"}
                aria-label={isPinned ? "Unpin event" : "Pin event"}
                onClick={(e) => {
                  e.stopPropagation();
                  togglePin(ev.id);
                }}
              >
                {isPinned ? "★" : "☆"}
              </button>
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

function getValueAtPath(root: unknown, path: string): unknown {
  if (root == null || typeof root !== "object") return undefined;
  let cur: unknown = root;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function formatFieldValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === "object") {
    try {
      const s = JSON.stringify(v);
      return s.length > 80 ? s.slice(0, 77) + "…" : s;
    } catch {
      return "[object]";
    }
  }
  return String(v);
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
