import { useState } from "react";

import { useStore } from "../store";
import { TransformersPanel } from "./TransformersPanel";

interface StatusBarProps {
  total: number;
  filtered: number;
  filterActive: boolean;
}

export function StatusBar({
  total,
  filtered,
  filterActive,
}: StatusBarProps) {
  const transformers = useStore((s) => s.transformers);
  const [txOpen, setTxOpen] = useState(false);

  return (
    <div className="status">
      <span>{total.toLocaleString()} events</span>
      <button
        type="button"
        className="status-btn"
        onClick={() => setTxOpen((x) => !x)}
        title="Edit line transformers"
      >
        ⚒ transformers
        <span style={{ color: "var(--muted-2)", marginLeft: 4 }}>
          {transformers.length}
        </span>
      </button>
      <TransformersPanel open={txOpen} onClose={() => setTxOpen(false)} />
      {filterActive && (
        <span style={{ color: "var(--muted-2)" }}>
          {filtered.toLocaleString()} match filter
        </span>
      )}
      <span className="right">
        <span>
          <kbd>⌘F</kbd> filter
        </span>
        <span>
          <kbd>⌘K</kbd> palette
        </span>
      </span>
    </div>
  );
}
