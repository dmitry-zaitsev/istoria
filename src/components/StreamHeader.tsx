import { useEffect, useRef, useState } from "react";

import { useStore, type SortKey } from "../store";

interface StreamHeaderProps {
  total: number;
  filtered: number;
  filterActive: boolean;
}

const SORT_LABELS: Record<SortKey, string> = {
  "time-desc": "time ▾",
  "time-asc": "time ▴",
  level: "level (err first)",
};

export function StreamHeader({ total, filtered, filterActive }: StreamHeaderProps) {
  const sort = useStore((s) => s.sort);
  const setSort = useStore((s) => s.setSort);
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
