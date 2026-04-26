import { useEffect, useRef, useState } from "react";

import { clearSession, setMeta } from "../lib/ipc";
import { toast } from "../lib/toast";
import { useStore, type SortKey } from "../store";

interface StreamHeaderProps {
  total: number;
  filtered: number;
  filterActive: boolean;
}

const SORT_LABELS: Record<SortKey, string> = {
  "newest-bottom": "newest at bottom",
  "newest-top": "newest at top",
};

export function StreamHeader({ total, filtered, filterActive }: StreamHeaderProps) {
  const sort = useStore((s) => s.sort);
  const setSort = useStore((s) => s.setSort);
  const events = useStore((s) => s.events);
  const selectedIds = useStore((s) => s.selectedIds);
  const [open, setOpen] = useState(false);
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
    void setMeta("sort", key).catch(() => {});
  };

  return (
    <div className="stream-h">
      <span className="count">
        <b>{filtered.toLocaleString()}</b> events
        {filterActive && (
          <span style={{ color: "var(--muted-2)" }}>
            {" "}
            · of {total.toLocaleString()}
          </span>
        )}
      </span>
      <span className="right" ref={ref}>
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
                .then(() =>
                  toast(
                    `Copied ${picked.length} row${picked.length === 1 ? "" : "s"}`,
                  ),
                )
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
            void clearSession()
              .then(() => toast("Session cleared"))
              .catch(() => toast("Clear failed"));
          }}
          title="Wipe all events from the current session"
        >
          clear
        </button>
        <button
          type="button"
          className="sort-btn"
          onClick={() => setOpen((x) => !x)}
        >
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
