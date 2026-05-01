import { useEffect, useState } from "react";

import { checkForUpdates, openTerminal, type UpdateInfo } from "../lib/ipc";

const DISMISS_KEY = "update.dismissed.v1";

function loadDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function saveDismissed(version: string) {
  try {
    window.localStorage.setItem(DISMISS_KEY, version);
  } catch {
    // localStorage disabled — accept that dismissal won't persist
  }
}

export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    checkForUpdates()
      .then((u) => {
        if (cancelled) return;
        if (!u.hasUpdate) return;
        if (loadDismissed() === u.latest) return;
        setInfo(u);
      })
      .catch((e) => {
        // Offline, GitHub rate-limit, or proxy block — silent.
        // The banner is a courtesy; never escalate to the user.
        console.warn("update check failed", e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!info || dismissed) return null;

  const dismiss = () => {
    saveDismissed(info.latest);
    setDismissed(true);
  };

  // Istoria ships exclusively via Homebrew (see RELEASING.md), so the
  // install action always runs `brew upgrade` in a Terminal window.
  // Terminal output stays visible so the user can confirm the upgrade
  // landed (or see brew errors) instead of the app silently shelling out.
  const update = () => {
    void openTerminal(`brew upgrade ${info.brewFormula}`);
  };

  return (
    <div className="update-toast" role="status">
      <div className="update-toast-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <circle
            cx="9"
            cy="9"
            r="6.5"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M9 12V6M6.5 8.5L9 6l2.5 2.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div className="update-toast-text">
        <div className="update-toast-title">Update available</div>
        <div className="update-toast-version">v{info.latest}</div>
      </div>
      <button type="button" className="update-toast-cta" onClick={update}>
        Update
      </button>
      <button
        type="button"
        className="update-toast-dismiss"
        aria-label="Dismiss update notice"
        onClick={dismiss}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path
            d="M1 1l8 8M9 1l-8 8"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}
