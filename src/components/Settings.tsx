import { useEffect, useRef, useState, type ReactNode } from "react";

import { getSettings, updateSettings, type AppSettings } from "../lib/ipc";
import { useStore, type SortKey } from "../store";

const GROUPS = [
  { id: "general", label: "General", icon: "sliders" },
  { id: "experimental", label: "Experimental", icon: "flask" },
] as const;
type GroupId = (typeof GROUPS)[number]["id"];

export function Settings() {
  const [activeGroup, setActiveGroup] = useState<GroupId>("general");
  const sort = useStore((state) => state.sort);
  const setSort = useStore((state) => state.setSort);
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    const unsubscribe = window.istoria?.onOpenSettings?.(() => setOpen(true));
    return () => {
      window.removeEventListener("keydown", onKey, true);
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!open) {
      dialog.current?.close();
      return;
    }
    dialog.current?.showModal();
    let cancelled = false;
    setLoading(true);
    setError(null);
    getSettings()
      .then((value) => {
        if (!cancelled) setSettings(value);
      })
      .catch(() => {
        if (!cancelled) {
          setSettings(null);
          setError("Could not load settings. Check that Istoria is running and try again.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, loadAttempt]);

  const toggleSystemLogs = async () => {
    if (!settings || pending.current) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      setSettings(await updateSettings(!settings.macosSystemLogs));
    } catch {
      // A lost response does not prove the backend rejected the change.
      // Reload its state before letting the user toggle again.
      try {
        setSettings(await getSettings());
        setError("Could not confirm the change. Current settings have been reloaded; try again.");
      } catch {
        setSettings(null);
        setError("Connection lost. Reload settings to check whether the change was saved.");
      }
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="icon-btn settings-open"
        title="Settings (⌘,)"
        aria-label="Settings"
        onClick={() => setOpen(true)}
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <path
            d="m9 3-.6 2.1-1.6.9-2.1-.5-3 5.2 1.5 1.6v1.8l-1.5 1.6 3 5.2 2.1-.5 1.6.9L9 23h6l.6-2.1 1.6-.9 2.1.5 3-5.2-1.5-1.6v-1.8l1.5-1.6-3-5.2-2.1.5-1.6-.9L15 3Z"
            transform="translate(1 0) scale(.92)"
          />
          <circle cx="12" cy="12" r="3.2" />
        </svg>
      </button>
      <dialog
        ref={dialog}
        className="settings-dialog"
        aria-labelledby="settings-title"
        onCancel={(event) => {
          event.preventDefault();
          setOpen(false);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            const rect = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < rect.left ||
              event.clientX > rect.right ||
              event.clientY < rect.top ||
              event.clientY > rect.bottom
            )
              setOpen(false);
          }
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <h1 id="settings-title">Settings</h1>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close settings"
            onClick={() => setOpen(false)}
            autoFocus
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="m6 6 12 12M6 18 18 6" />
            </svg>
          </button>
        </header>
        <div className="settings-layout">
          <nav className="settings-sidebar" aria-label="Settings groups">
            {GROUPS.map((group) => (
              <button
                key={group.id}
                type="button"
                className="settings-group"
                aria-current={activeGroup === group.id ? "page" : undefined}
                aria-controls="settings-content"
                onClick={() => setActiveGroup(group.id)}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  {group.icon === "sliders" ? (
                    <>
                      <path d="M4 7h6m4 0h6M4 17h10m4 0h2" />
                      <circle cx="12" cy="7" r="2" />
                      <circle cx="16" cy="17" r="2" />
                    </>
                  ) : (
                    <>
                      <path d="M9 3h6m-5 0v6l-6 10a1.3 1.3 0 0 0 1 2h14a1.3 1.3 0 0 0 1-2L14 9V3M7 15h10" />
                    </>
                  )}
                </svg>
                {group.label}
              </button>
            ))}
            <span className="settings-autosave">Saved automatically</span>
          </nav>
          <section
            className="settings-content"
            id="settings-content"
            aria-labelledby="settings-group-title"
          >
            <h2 id="settings-group-title">
              {GROUPS.find((group) => group.id === activeGroup)?.label}
            </h2>
            {activeGroup === "general" ? (
              <SettingsRow
                label="Log order"
                id="log-order"
                help="Choose where the newest logs appear in the stream. This is the same preference as the sort control above your logs, and it is saved automatically."
              >
                <select
                  id="log-order-control"
                  aria-labelledby="log-order-label"
                  className="settings-select"
                  value={sort}
                  onChange={(event) => setSort(event.target.value as SortKey)}
                >
                  <option value="newest-top">Newest at top</option>
                  <option value="newest-bottom">Newest at bottom</option>
                </select>
              </SettingsRow>
            ) : (
              <>
                {loading ? (
                  <p className="settings-status" role="status">
                    Loading settings…
                  </p>
                ) : settings ? (
                  <SettingsRow
                    label="macOS system logs"
                    id="system-logs"
                    help="Stream new macOS Console logs into source:macos. Experimental and off by default. Can fill the session faster. Privacy redactions are preserved. Turning capture off keeps existing logs."
                  >
                    <span className="settings-control-status" role="status" aria-live="polite">
                      {saving
                        ? "Saving…"
                        : !settings.macosSystemLogsSupported
                          ? "macOS only"
                          : settings.macosSystemLogs
                            ? "On"
                            : "Off"}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={settings.macosSystemLogs}
                      aria-labelledby="system-logs-label"
                      aria-describedby="system-logs-help"
                      className="settings-switch"
                      disabled={!settings.macosSystemLogsSupported}
                      aria-disabled={saving || !settings.macosSystemLogsSupported}
                      onClick={() => void toggleSystemLogs()}
                    >
                      <span />
                    </button>
                  </SettingsRow>
                ) : null}
                {settings?.loadWarning && (
                  <p className="settings-error" role="alert">
                    {settings.loadWarning}
                  </p>
                )}
                {error && (
                  <p className="settings-error" role="alert">
                    {error}
                  </p>
                )}
                {!settings && !loading && (
                  <button
                    type="button"
                    className="settings-retry"
                    onClick={() => setLoadAttempt((value) => value + 1)}
                  >
                    Try again
                  </button>
                )}
              </>
            )}
          </section>
        </div>
      </dialog>
    </>
  );
}

/** Shared row layout keeps labels, help and controls aligned as groups grow. */
function SettingsRow({
  label,
  id,
  help,
  children,
}: {
  label: string;
  id: string;
  help: string;
  children: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-label">
        <span id={`${id}-label`}>{label}</span>
        <SettingsHelp id={`${id}-help`} label={label}>
          {help}
        </SettingsHelp>
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

function SettingsHelp({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const timeout = useRef<ReturnType<typeof setTimeout>>();
  const show = () => {
    clearTimeout(timeout.current);
    setOpen(true);
  };
  const hide = () => {
    clearTimeout(timeout.current);
    timeout.current = setTimeout(() => {
      if (document.activeElement !== trigger.current) setOpen(false);
    }, 120);
  };
  useEffect(() => () => clearTimeout(timeout.current), []);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", dismiss, true);
    return () => window.removeEventListener("keydown", dismiss, true);
  }, [open]);
  return (
    <span className="settings-help" onMouseEnter={show} onMouseLeave={hide}>
      <button
        ref={trigger}
        type="button"
        className="settings-help-button"
        aria-label={`About ${label}`}
        aria-describedby={id}
        onFocus={show}
        onBlur={() => {
          clearTimeout(timeout.current);
          setOpen(false);
        }}
        onClick={show}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          aria-hidden="true"
        >
          <circle cx="10" cy="10" r="7.2" />
          <path d="M10 9v5m0-8v1" />
        </svg>
      </button>
      <span
        id={id}
        role="tooltip"
        className="settings-tooltip"
        hidden={!open}
        onMouseEnter={show}
        onMouseLeave={hide}
      >
        <span>{children}</span>
      </span>
    </span>
  );
}
