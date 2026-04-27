import { useEffect, useState } from "react";

import { ALERT_COLORS, type AlertColor } from "../lib/alerts";
import {
  createAlert,
  deleteAlert,
  listAlerts,
  updateAlert,
  type Alert,
} from "../lib/ipc";
import { isError, parse } from "../lib/query";
import { toast } from "../lib/toast";
import { useStore } from "../store";

interface AlertsModalProps {
  open: boolean;
  onClose: () => void;
  initialQuery?: string;
}

interface Draft {
  id?: number;
  name: string;
  query: string;
  color: AlertColor;
  notify: boolean;
  debounce_ms: number;
}

const EMPTY_DRAFT: Draft = {
  name: "",
  query: "",
  color: "red",
  notify: false,
  debounce_ms: 5000,
};

export function AlertsModal({ open, onClose, initialQuery }: AlertsModalProps) {
  const alerts = useStore((s) => s.alerts);
  const setAlerts = useStore((s) => s.setAlerts);
  const [draft, setDraft] = useState<Draft | null>(null);

  useEffect(() => {
    if (!open) return;
    if (initialQuery) {
      setDraft({ ...EMPTY_DRAFT, query: initialQuery });
    } else {
      setDraft(null);
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, initialQuery, onClose]);

  if (!open) return null;

  const refresh = async () => {
    try {
      const next = await listAlerts();
      setAlerts(next);
    } catch (e) {
      toast(`Reload failed: ${String(e)}`);
    }
  };

  const startEdit = (a: Alert) => {
    setDraft({
      id: a.id,
      name: a.name,
      query: a.query,
      color: (ALERT_COLORS as readonly string[]).includes(a.color)
        ? (a.color as AlertColor)
        : "red",
      notify: a.notify,
      debounce_ms: a.debounce_ms,
    });
  };

  const cancelEdit = () => setDraft(null);

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.query.trim()) {
      toast("Name and query required");
      return;
    }
    const parsed = parse(draft.query);
    if (isError(parsed)) {
      toast(`Bad query: ${parsed.message}`);
      return;
    }
    try {
      if (draft.id != null) {
        await updateAlert({
          id: draft.id,
          name: draft.name.trim(),
          query: draft.query.trim(),
          color: draft.color,
          notify: draft.notify,
          debounce_ms: draft.debounce_ms,
        });
        toast("Alert updated");
      } else {
        await createAlert({
          name: draft.name.trim(),
          query: draft.query.trim(),
          color: draft.color,
          notify: draft.notify,
          debounce_ms: draft.debounce_ms,
        });
        toast("Alert created");
      }
      setDraft(null);
      await refresh();
    } catch (e) {
      toast(`Save failed: ${String(e)}`);
    }
  };

  const remove = async (id: number) => {
    if (!confirm("Delete this alert?")) return;
    try {
      await deleteAlert(id);
      toast("Alert deleted");
      await refresh();
    } catch (e) {
      toast(`Delete failed: ${String(e)}`);
    }
  };

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div
        className="alerts-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Manage alerts"
      >
        <div className="alerts-h">
          <span>Alert rules</span>
          <button
            type="button"
            className="sort-btn"
            onClick={() => setDraft({ ...EMPTY_DRAFT })}
          >
            + new
          </button>
          <button
            type="button"
            className="sort-btn"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="alerts-body">
          {alerts.length === 0 && !draft && (
            <div className="alerts-empty">
              No alerts yet. Click <b>+ new</b> or run <i>Save current query as alert</i> from the palette.
            </div>
          )}
          {alerts.map((a) => (
            <div key={a.id} className={`alert-row alert-${a.color}`}>
              <span className="alert-swatch" />
              <div className="alert-meta">
                <div className="alert-name">{a.name}</div>
                <div className="alert-q">
                  <code>{a.query}</code>
                </div>
              </div>
              {a.notify && <span className="alert-bell" title={`debounce ${a.debounce_ms}ms`}>🔔</span>}
              <button type="button" className="sort-btn" onClick={() => startEdit(a)}>
                edit
              </button>
              <button
                type="button"
                className="sort-btn"
                onClick={() => void remove(a.id)}
              >
                delete
              </button>
            </div>
          ))}
          {draft && (
            <div className="alert-form">
              <label>
                <span>Name</span>
                <input
                  type="text"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="e.g. errors"
                  autoFocus
                />
              </label>
              <label>
                <span>Query</span>
                <input
                  type="text"
                  value={draft.query}
                  onChange={(e) => setDraft({ ...draft, query: e.target.value })}
                  placeholder="e.g. level:error"
                  spellCheck={false}
                />
              </label>
              <label>
                <span>Color</span>
                <div className="alert-colors">
                  {ALERT_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`alert-swatch alert-${c}${draft.color === c ? " on" : ""}`}
                      onClick={() => setDraft({ ...draft, color: c })}
                      aria-label={c}
                      title={c}
                    />
                  ))}
                </div>
              </label>
              <label className="alert-row-inline">
                <input
                  type="checkbox"
                  checked={draft.notify}
                  onChange={(e) => setDraft({ ...draft, notify: e.target.checked })}
                />
                <span>macOS notification on match</span>
              </label>
              {draft.notify && (
                <label>
                  <span>Debounce (ms)</span>
                  <input
                    type="number"
                    min={0}
                    step={500}
                    value={draft.debounce_ms}
                    onChange={(e) =>
                      setDraft({ ...draft, debounce_ms: Number(e.target.value) || 0 })
                    }
                  />
                </label>
              )}
              <div className="alert-form-actions">
                <button type="button" className="sort-btn" onClick={cancelEdit}>
                  cancel
                </button>
                <button type="button" className="sort-btn primary" onClick={() => void save()}>
                  {draft.id != null ? "save" : "create"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
