import { useEffect, useState, type ReactNode } from "react";

import { cliLinkStatus, installCliLink } from "../lib/ipc";
import { log } from "../lib/logger";

type GateState =
  | { kind: "checking" }
  | { kind: "ok" }
  | { kind: "needed"; linkPath: string; error: string | null; installing: boolean };

export function CliSetupGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: "checking" });

  useEffect(() => {
    let cancelled = false;
    cliLinkStatus()
      .then((s) => {
        if (cancelled) return;
        if (!s.needed || s.installed) {
          setState({ kind: "ok" });
        } else {
          setState({ kind: "needed", linkPath: s.linkPath, error: null, installing: false });
        }
      })
      .catch((e) => {
        // If status probe itself fails we don't have evidence the
        // link is needed — fail open rather than lock out the user.
        log.warn("cli link status failed", e);
        if (!cancelled) setState({ kind: "ok" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "checking") return null;
  if (state.kind === "ok") return <>{children}</>;

  const install = async () => {
    setState({ ...state, installing: true, error: null });
    try {
      await installCliLink();
      // Re-probe to confirm; on success transition to ok, on
      // anything else keep modal up with a fresh error.
      const fresh = await cliLinkStatus();
      if (fresh.installed) {
        setState({ kind: "ok" });
      } else {
        setState({
          ...state,
          installing: false,
          error: "Link still missing after install. Try again or check the app's location.",
        });
      }
    } catch (e) {
      setState({ ...state, installing: false, error: String(e) });
    }
  };

  return (
    <div className="cli-setup-backdrop" role="dialog" aria-modal="true">
      <div className="cli-setup-card">
        <h1 className="cli-setup-title">Install command-line tool</h1>
        <p className="cli-setup-body">
          istoria needs a one-time setup to be usable from your terminal — e.g.{" "}
          <code>cat log.txt | istoria</code>.
        </p>
        <p className="cli-setup-body">
          This creates a symlink at <code>{state.linkPath}</code>. macOS will ask for your
          administrator password.
        </p>
        {state.error && <p className="cli-setup-error">{state.error}</p>}
        <button
          type="button"
          className="cli-setup-cta"
          onClick={install}
          disabled={state.installing}
        >
          {state.installing ? "Installing…" : "Install"}
        </button>
      </div>
    </div>
  );
}
