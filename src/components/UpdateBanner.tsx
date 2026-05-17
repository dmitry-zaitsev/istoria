import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useEffect, useState } from "react";

import { checkForUpdates, detectInstallMethod, openTerminal } from "../lib/ipc";
import { log } from "../lib/logger";

const DISMISS_KEY = "update.dismissed.v1";

type BannerState =
  | { kind: "brew"; latest: string; brewFormula: string }
  | { kind: "plugin"; latest: string; update: Update };

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
  const [info, setInfo] = useState<BannerState | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const method = await detectInstallMethod();
      if (method === "homebrew") {
        const u = await checkForUpdates();
        if (cancelled || !u.hasUpdate) return;
        if (loadDismissed() === u.latest) return;
        setInfo({ kind: "brew", latest: u.latest, brewFormula: u.brewFormula });
      } else {
        const upd = await check();
        if (cancelled || !upd) return;
        if (loadDismissed() === upd.version) return;
        setInfo({ kind: "plugin", latest: upd.version, update: upd });
      }
    })().catch((e) => {
      // Offline, GitHub rate-limit, signature endpoint down — silent.
      // The banner is a courtesy; never escalate to the user.
      log.warn("update check failed", e);
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

  const update = async () => {
    if (info.kind === "brew") {
      void openTerminal(`brew upgrade ${info.brewFormula}`);
      return;
    }
    try {
      setInstalling(true);
      await info.update.downloadAndInstall();
      await relaunch();
    } catch (e) {
      log.warn("update install failed", e);
      setInstalling(false);
    }
  };

  const cta = info.kind === "brew" ? "Update" : installing ? "Installing…" : "Install update";

  return (
    <div className="update-toast" role="status">
      <div className="update-toast-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <circle cx="9" cy="9" r="6.5" stroke="currentColor" strokeWidth="1.5" />
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
      <button type="button" className="update-toast-cta" onClick={update} disabled={installing}>
        {cta}
      </button>
      <button
        type="button"
        className="update-toast-dismiss"
        aria-label="Dismiss update notice"
        onClick={dismiss}
        disabled={installing}
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
