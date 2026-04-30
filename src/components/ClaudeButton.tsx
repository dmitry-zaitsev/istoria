import { useEffect, useState } from "react";

import { claudeStatus } from "../lib/ipc";
import { useStore } from "../store";

const INSTALL_URL = "https://docs.claude.com/en/docs/claude-code/overview";

type Probe =
  | { state: "loading" }
  | { state: "missing" }
  | { state: "ready" };

export function ClaudeButton() {
  const connected = useStore((s) => s.claudeConnected);
  const setConnected = useStore((s) => s.setClaudeConnected);
  const [probe, setProbe] = useState<Probe>({ state: "loading" });
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    claudeStatus()
      .then((s) => {
        if (cancelled) return;
        setProbe(s.installed ? { state: "ready" } : { state: "missing" });
        // Auto-disconnect if Claude Code disappeared since last run.
        if (!s.installed && useStore.getState().claudeConnected) {
          useStore.getState().setClaudeConnected(false);
        }
      })
      .catch(() => {
        if (!cancelled) setProbe({ state: "missing" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const tooltip =
    probe.state === "loading"
      ? "Checking Claude Code…"
      : probe.state === "missing"
        ? "Claude Code not installed — click to learn more"
        : connected
          ? "Claude Code connected — advanced analysis enabled"
          : "Connect Claude Code for advanced analysis";

  return (
    <>
      <button
        type="button"
        className={`icon-btn tabs-claude-btn${connected ? " on" : ""}`}
        onClick={() => setOpen(true)}
        title={tooltip}
        aria-label="Claude Code integration"
        aria-pressed={connected}
      >
        <SparkleIcon />
      </button>
      {open && (
        <ClaudeDialog
          probe={probe}
          connected={connected}
          onClose={() => setOpen(false)}
          onConfirm={() => {
            setConnected(!connected);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

interface DialogProps {
  probe: Probe;
  connected: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

function ClaudeDialog({ probe, connected, onClose, onConfirm }: DialogProps) {
  const missing = probe.state === "missing";
  const loading = probe.state === "loading";
  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="claude-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="claude-dialog-head">
          <SparkleIcon />
          <span>Claude Code</span>
        </div>
        <div className="claude-dialog-body">
          {loading && <p>Checking for Claude Code…</p>}
          {missing && (
            <>
              <p>Claude Code isn't installed on this machine.</p>
              <p>
                Once installed, istoria can use it (via the Claude Agent SDK)
                to unlock:
              </p>
              <ul className="claude-dialog-list">
                <li>Summarize errors and recurring patterns</li>
                <li>Explain stack traces in plain English</li>
                <li>Translate plain English into filters</li>
                <li>Spot anomalies and traffic spikes</li>
                <li>Root-cause across multiple sources</li>
              </ul>
              <p className="claude-dialog-muted">
                Install Claude Code, then reopen this dialog.
              </p>
            </>
          )}
          {probe.state === "ready" && !connected && (
            <>
              <p>Connect your local Claude Code to unlock:</p>
              <ul className="claude-dialog-list">
                <li>Summarize errors and recurring patterns</li>
                <li>Explain stack traces in plain English</li>
                <li>Translate plain English into filters</li>
                <li>Spot anomalies and traffic spikes</li>
                <li>Root-cause across multiple sources</li>
              </ul>
            </>
          )}
          {probe.state === "ready" && connected && (
            <p>Claude Code is connected. Disconnect any time.</p>
          )}
        </div>
        <div className="claude-dialog-actions">
          {missing ? (
            <>
              <button
                type="button"
                className="claude-btn ghost"
                onClick={onClose}
              >
                Close
              </button>
              <a
                className="claude-btn primary"
                href={INSTALL_URL}
                target="_blank"
                rel="noreferrer"
              >
                Install instructions
              </a>
            </>
          ) : (
            <>
              <button
                type="button"
                className="claude-btn ghost"
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`claude-btn ${connected ? "danger" : "primary"}`}
                onClick={onConfirm}
                disabled={loading}
              >
                {connected ? "Disconnect" : "Connect"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SparkleIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 1.5l1.4 4 4 1.4-4 1.4-1.4 4-1.4-4-4-1.4 4-1.4z" />
      <path d="M13 11l.6 1.7 1.7.6-1.7.6L13 15.6l-.6-1.7-1.7-.6 1.7-.6z" />
    </svg>
  );
}
