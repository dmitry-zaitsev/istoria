import { useEffect, useState } from "react";

import { claudeStatus } from "../lib/ipc";
import { useStore } from "../store";
import { AIPanel } from "./AIPanel";
import { SparkleIcon } from "./SparkleIcon";

const INSTALL_URL = "https://docs.claude.com/en/docs/claude-code/overview";

type Probe =
  | { state: "loading" }
  | { state: "missing" }
  | { state: "ready" };

type Mode = "closed" | "connect" | "panel";

export function ClaudeButton() {
  const connected = useStore((s) => s.claudeConnected);
  const setConnected = useStore((s) => s.setClaudeConnected);
  const relevance = useStore((s) => s.relevance);
  const relevanceStale = useStore((s) => s.relevanceStale);
  const analyzing = useStore((s) => s.relevanceAnalyzing);
  const [probe, setProbe] = useState<Probe>({ state: "loading" });
  const [mode, setMode] = useState<Mode>("closed");

  useEffect(() => {
    let cancelled = false;
    claudeStatus()
      .then((s) => {
        if (cancelled) return;
        setProbe(s.installed ? { state: "ready" } : { state: "missing" });
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
    if (mode === "closed") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMode("closed");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);

  const tooltip =
    probe.state === "loading"
      ? "Checking Claude Code…"
      : probe.state === "missing"
        ? "Claude Code not installed — click to learn more"
        : !connected
          ? "Connect Claude Code for advanced analysis"
          : analyzing
            ? "Analyzing branch…"
            : relevanceStale
              ? "Branch changed — re-run analysis"
              : relevance
                ? `AI · ${relevance.regexes.length} relevance pattern${
                    relevance.regexes.length === 1 ? "" : "s"
                  }`
                : "AI — MCP & branch relevance";

  // Orange dot signals: branch drifted since last analysis, OR connected
  // but no analysis run yet. Hidden while a run is in flight (the
  // breathing animation already says "busy").
  const showDot =
    connected && !analyzing && (relevanceStale || !relevance);

  const handleClick = () => {
    setMode(connected ? "panel" : "connect");
  };

  const handleConnect = () => {
    setConnected(true);
    setMode("panel");
  };

  const handleDisconnect = () => {
    setConnected(false);
    setMode("closed");
  };

  return (
    <>
      <button
        type="button"
        className={`icon-btn tabs-claude-btn${connected ? " on" : ""}${
          analyzing ? " analyzing" : ""
        }`}
        onClick={handleClick}
        title={tooltip}
        aria-label="AI integration"
        aria-pressed={connected}
      >
        <SparkleIcon />
        {showDot && <span className="claude-dot" aria-hidden="true" />}
      </button>
      {mode === "connect" && (
        <ConnectDialog
          probe={probe}
          onClose={() => setMode("closed")}
          onConfirm={handleConnect}
        />
      )}
      {mode === "panel" && (
        <AIPanel
          onClose={() => setMode("closed")}
          onDisconnect={handleDisconnect}
        />
      )}
    </>
  );
}

interface ConnectDialogProps {
  probe: Probe;
  onClose: () => void;
  onConfirm: () => void;
}

function ConnectDialog({ probe, onClose, onConfirm }: ConnectDialogProps) {
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
                <li>Highlight log entries relevant to the current branch</li>
                <li>Summarize errors and recurring patterns</li>
                <li>Explain stack traces in plain English</li>
                <li>Translate plain English into filters</li>
              </ul>
              <p className="claude-dialog-muted">
                Install Claude Code, then reopen this dialog.
              </p>
            </>
          )}
          {probe.state === "ready" && (
            <>
              <p>Connect your local Claude Code to unlock:</p>
              <ul className="claude-dialog-list">
                <li>Highlight log entries relevant to the current branch</li>
                <li>Summarize errors and recurring patterns</li>
                <li>Explain stack traces in plain English</li>
                <li>Translate plain English into filters</li>
              </ul>
            </>
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
                className="claude-btn primary"
                onClick={onConfirm}
                disabled={loading}
              >
                Connect
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
