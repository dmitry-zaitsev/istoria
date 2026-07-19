import { useEffect, useState } from "react";

import { checkForUpdates, openTerminal } from "../lib/ipc";
import { log } from "../lib/logger";

const DISMISS_KEY = "update.dismissed.v1";

type BannerState =
  | { kind: "brew"; latest: string; brewFormula: string }
  // Direct-download install → electron-updater in-app update; `releaseUrl` is
  // the fallback if the updater errors (dev/unsigned/offline).
  | { kind: "app"; latest: string; releaseUrl: string };

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
  // null = idle; number = download %; "ready" = downloaded, awaiting restart.
  const [progress, setProgress] = useState<number | "ready" | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const u = await checkForUpdates();
      if (cancelled || !u.hasUpdate) return;
      if (loadDismissed() === u.latest) return;
      if (u.installMethod === "homebrew") {
        setInfo({ kind: "brew", latest: u.latest, brewFormula: u.brewFormula });
      } else {
        setInfo({ kind: "app", latest: u.latest, releaseUrl: u.releaseUrl });
      }
    })().catch((e) => {
      // Offline, GitHub rate-limit, endpoint down — silent.
      // The banner is a courtesy; never escalate to the user.
      log.warn("update check failed", e);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Listen to electron-updater events (download progress / ready / error).
  useEffect(() => {
    const un = window.istoria?.update.onEvent((e) => {
      if (e.type === "progress") setProgress(Math.round(e.payload.percent));
      else if (e.type === "downloaded") setProgress("ready");
      else if (e.type === "error") {
        // Updater failed (dev/unsigned/offline) — fall back to the release page.
        log.warn("in-app update failed", e.payload.message);
        setProgress(null);
        if (info?.kind === "app") window.open(info.releaseUrl, "_blank");
      }
    });
    return un;
  }, [info]);

  if (!info || dismissed) return null;

  const dismiss = () => {
    saveDismissed(info.latest);
    setDismissed(true);
  };

  const update = () => {
    if (info.kind === "brew") {
      void openTerminal(`brew upgrade ${info.brewFormula}`);
      return;
    }
    if (progress === "ready") {
      void window.istoria?.update.install();
      return;
    }
    if (progress !== null) return; // download in flight
    // Direct-download install → electron-updater downloads in the background;
    // events drive the progress UI. Fallback to the release page on failure.
    setProgress(0);
    const bridge = window.istoria?.update;
    if (!bridge) {
      window.open(info.releaseUrl, "_blank");
      return;
    }
    bridge.start().catch((e) => {
      log.warn("update start failed", e);
      setProgress(null);
      window.open(info.releaseUrl, "_blank");
    });
  };

  const cta =
    info.kind === "brew"
      ? "Update"
      : progress === "ready"
        ? "Restart to update"
        : progress !== null
          ? `Downloading ${progress}%`
          : "Install update";

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
      <button
        type="button"
        className="update-toast-cta"
        onClick={update}
        disabled={typeof progress === "number"}
      >
        {cta}
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
