import { useEffect, useRef } from "react";

import { deleteAlertLocal, loadAlerts, setAlertEnabledLocal } from "../lib/alerts";
import { toast } from "../lib/toast";
import { useStore } from "../store";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function AlertsPanel({ open, onClose }: Props) {
  const alerts = useStore((s) => s.alerts);
  const setAlerts = useStore((s) => s.setAlerts);
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

  const toggle = (id: string, enabled: boolean) => {
    try {
      setAlertEnabledLocal(id, enabled);
      setAlerts(loadAlerts());
    } catch (e) {
      toast(`Update failed: ${String(e)}`);
    }
  };

  const remove = (id: string) => {
    // window.confirm is blocked in WKWebView so the prompt never
    // returned and the click silently no-op'd. Just delete; user can
    // re-create from the filter bar if it was a mistake.
    try {
      deleteAlertLocal(id);
      setAlerts(loadAlerts());
      toast("Alert deleted");
    } catch (e) {
      toast(`Delete failed: ${String(e)}`);
    }
  };

  return (
    <div className="alerts-panel" ref={ref} role="dialog" aria-label="Active alerts">
      <div className="alerts-panel-h">
        Alerts
        <span style={{ color: "var(--muted-2)" }}>{alerts.length}</span>
      </div>
      {alerts.length === 0 && (
        <div className="alerts-empty">
          No alerts. Type a filter, then click <b>notify</b> to save it.
        </div>
      )}
      {alerts.map((a) => (
        <div key={a.id} className={`alerts-row${a.enabled ? "" : " disabled"}`}>
          <span className={`alert-swatch alert-${a.color}`} />
          <div className="alerts-meta">
            <div className="alert-name">{a.name}</div>
            <div className="alert-q">
              <code>{a.query}</code>
            </div>
          </div>
          {a.notify && (
            <span className="alert-notify-tag" title={`debounce ${a.debounce_ms}ms`}>
              notify
            </span>
          )}
          <button
            type="button"
            className="sort-btn"
            onClick={() => toggle(a.id, !a.enabled)}
            title={a.enabled ? "Deactivate alert" : "Activate alert"}
          >
            {a.enabled ? "on" : "off"}
          </button>
          <button
            type="button"
            className="sort-btn"
            onClick={() => remove(a.id)}
            title="Delete alert"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
