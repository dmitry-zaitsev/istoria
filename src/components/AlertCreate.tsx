import { useEffect, useRef, useState } from "react";

import { ALERT_COLORS, type AlertColor } from "../lib/alerts";
import { createAlert, listAlerts } from "../lib/ipc";
import { isError, parse } from "../lib/query";
import { toast } from "../lib/toast";
import { useStore } from "../store";

interface Props {
  query: string;
  onClose: () => void;
}

export function AlertCreatePopover({ query, onClose }: Props) {
  const setAlerts = useStore((s) => s.setAlerts);
  const [name, setName] = useState(() => suggestName(query));
  const [color, setColor] = useState<AlertColor>("red");
  const [notify, setNotify] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
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
  }, [onClose]);

  const save = async () => {
    if (!name.trim()) {
      toast("Name required");
      return;
    }
    const parsed = parse(query);
    if (isError(parsed)) {
      toast(`Bad query: ${parsed.message}`);
      return;
    }
    try {
      await createAlert({
        name: name.trim(),
        query,
        color,
        notify,
        debounce_ms: 5000,
      });
      const next = await listAlerts();
      setAlerts(next);
      toast(`Alert "${name.trim()}" created`);
      onClose();
    } catch (e) {
      toast(`Save failed: ${String(e)}`);
    }
  };

  return (
    <div className="alert-create-popover" ref={ref} role="dialog" aria-label="Create alert">
      <label>
        <span>Name</span>
        <input
          type="text"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          placeholder="alert name"
        />
      </label>
      <label>
        <span>Color</span>
        <div className="alert-colors">
          {ALERT_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`alert-swatch alert-${c}${color === c ? " on" : ""}`}
              onClick={() => setColor(c)}
              aria-label={c}
              title={c}
            />
          ))}
        </div>
      </label>
      <label className="alert-row-inline">
        <input
          type="checkbox"
          checked={notify}
          onChange={(e) => setNotify(e.target.checked)}
        />
        <span>macOS notification</span>
      </label>
      <div className="alert-form-actions">
        <button type="button" className="sort-btn" onClick={onClose}>
          cancel
        </button>
        <button type="button" className="sort-btn primary" onClick={() => void save()}>
          create
        </button>
      </div>
    </div>
  );
}

function suggestName(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length <= 32) return trimmed;
  return trimmed.slice(0, 30) + "…";
}
