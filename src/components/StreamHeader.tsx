import { useEffect, useRef, useState } from "react";

import { clearSession, type LogEvent } from "../lib/ipc";
import { fireSessionCleared } from "../lib/sessionBus";
import { toast } from "../lib/toast";
import { useStore, type SortKey } from "../store";
import { AlertsPanel } from "./AlertsPanel";
import { PinsPanel } from "./PinsPanel";

interface StreamHeaderProps {
  total: number;
  filtered: number;
  filterActive: boolean;
  unfilteredEvents: LogEvent[];
}

const SORT_LABELS: Record<SortKey, string> = {
  "newest-bottom": "newest at bottom",
  "newest-top": "newest at top",
};

export function StreamHeader({
  total,
  filtered,
  filterActive,
  unfilteredEvents,
}: StreamHeaderProps) {
  const sort = useStore((s) => s.sort);
  const setSort = useStore((s) => s.setSort);
  const events = useStore((s) => s.events);
  const selectedIds = useStore((s) => s.selectedIds);
  const pinnedIds = useStore((s) => s.pinnedIds);
  const alerts = useStore((s) => s.alerts);
  const [open, setOpen] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const select = (key: SortKey) => {
    setSort(key);
    setOpen(false);
    // sort persists via setSort → localStorage in store.ts
  };

  return (
    <div className="stream-h">
      <span className="count">
        <b>{filtered.toLocaleString()}</b> events
        {filterActive && (
          <span style={{ color: "var(--muted-2)" }}> · of {total.toLocaleString()}</span>
        )}
      </span>
      <span className="right" ref={ref}>
        {pinnedIds.size > 0 && (
          <button
            type="button"
            className="sort-btn"
            onClick={() => setPinsOpen((x) => !x)}
            title="Show pinned events"
          >
            ★ {pinnedIds.size}
          </button>
        )}
        <PinsPanel events={unfilteredEvents} open={pinsOpen} onClose={() => setPinsOpen(false)} />
        {alerts.length > 0 && (
          <button
            type="button"
            className="sort-btn"
            onClick={() => setAlertsOpen((x) => !x)}
            title="Show alerts"
          >
            ⚑ {alerts.length}
          </button>
        )}
        <AlertsPanel open={alertsOpen} onClose={() => setAlertsOpen(false)} />
        {selectedIds.length > 0 && (
          <button
            type="button"
            className="sort-btn"
            onClick={() => {
              const sel = new Set(selectedIds);
              const picked = events.filter((e) => sel.has(e.id));
              const txt = picked.map((e) => JSON.stringify(e)).join("\n");
              navigator.clipboard
                ?.writeText(txt)
                .then(() => toast(`Copied ${picked.length} row${picked.length === 1 ? "" : "s"}`))
                .catch(() => toast("Copy failed"));
            }}
            title="Copy selected rows as JSONL"
          >
            copy {selectedIds.length}
          </button>
        )}
        <button
          type="button"
          className="sort-btn"
          onClick={() => {
            // Wipe local state immediately so the UI doesn't lag the
            // backend roundtrip / pause snapshot.
            fireSessionCleared();
            void clearSession()
              .then(() => toast("Session cleared"))
              .catch(() => toast("Clear failed"));
          }}
          title="Wipe all events from the current session"
        >
          clear
        </button>
        <button type="button" className="sort-btn" onClick={() => setOpen((x) => !x)}>
          sort: {SORT_LABELS[sort]}
        </button>
        {open && (
          <div className="sort-menu">
            {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
              <div
                key={k}
                className={`sort-menu-item${k === sort ? " active" : ""}`}
                onClick={() => select(k)}
              >
                {SORT_LABELS[k]}
              </div>
            ))}
          </div>
        )}
      </span>
    </div>
  );
}
