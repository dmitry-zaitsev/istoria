import { useEffect, useState } from "react";

import {
  analyzeBranchRelevance,
  claudeStatus,
  codexStatus,
  mcpPort,
  openTerminal,
  type ClaudeStatus,
} from "../lib/ipc";
import { toast } from "../lib/toast";
import { useStore } from "../store";
import { SparkleIcon } from "./SparkleIcon";

interface Props {
  onClose: () => void;
  onDisconnect: () => void;
}

interface AgentState {
  claude: ClaudeStatus | null;
  codex: ClaudeStatus | null;
}

export function AIPanel({ onClose, onDisconnect }: Props) {
  const [port, setPort] = useState<number | null>(null);
  const [agents, setAgents] = useState<AgentState | null>(null);
  const relevance = useStore((s) => s.relevance);
  const setRelevance = useStore((s) => s.setRelevance);
  const relevanceStale = useStore((s) => s.relevanceStale);
  const analyzing = useStore((s) => s.relevanceAnalyzing);
  const setAnalyzing = useStore((s) => s.setRelevanceAnalyzing);

  useEffect(() => {
    let cancelled = false;
    mcpPort()
      .then((p) => {
        if (!cancelled) setPort(p);
      })
      .catch(() => {});

    // Independent calls so a missing IPC for one agent doesn't blank both.
    let pendingClaude = true;
    let pendingCodex = true;
    let claudeRes: ClaudeStatus | null = null;
    let codexRes: ClaudeStatus | null = null;
    const finish = () => {
      if (cancelled || pendingClaude || pendingCodex) return;
      setAgents({ claude: claudeRes, codex: codexRes });
    };
    claudeStatus()
      .then((s) => {
        claudeRes = s;
      })
      .catch(() => {})
      .finally(() => {
        pendingClaude = false;
        finish();
      });
    codexStatus()
      .then((s) => {
        codexRes = s;
      })
      .catch(() => {})
      .finally(() => {
        pendingCodex = false;
        finish();
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const url = port ? `http://localhost:${port}/mcp` : null;
  const claudeCmd = url
    ? `claude mcp add --transport http istoria ${url}`
    : null;
  const codexCmd = url ? `codex mcp add istoria --url ${url}` : null;

  const runInTerminal = async (cmd: string, label: string) => {
    try {
      await openTerminal(cmd);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      toast(`Couldn't open Terminal for ${label}: ${err}`);
    }
  };

  const claudeInstalled = !!agents?.claude?.installed;
  const codexInstalled = !!agents?.codex?.installed;
  const anyInstalled = claudeInstalled || codexInstalled;

  const runAnalyze = async () => {
    if (analyzing) return;
    setAnalyzing(true);
    try {
      const result = await analyzeBranchRelevance();
      setRelevance(result);
      const n = result.regexes.length;
      toast(
        n === 0
          ? "Branch analysis: no relevant log patterns found"
          : `Branch analysis: ${n} pattern${n === 1 ? "" : "s"} marked relevant`,
      );
    } catch (e) {
      toast(`Branch analysis failed: ${String(e)}`);
    } finally {
      setAnalyzing(false);
    }
  };

  const clearAnalysis = () => setRelevance(null);

  // Relevance section is gated on Claude — Codex doesn't run our prompt.
  const relevanceAvailable = claudeInstalled;

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div
        className="claude-dialog ai-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="claude-dialog-head">
          <SparkleIcon />
          <span>AI</span>
        </div>
        <div className="claude-dialog-body">
          <section className="ai-section">
            <h4 className="ai-section-title">MCP server</h4>
            <p>
              Local agents like Claude Code and Codex can query your logs
              over MCP.
            </p>
            <div className="ai-status-row">
              {url ? (
                <>
                  <span className="ai-status-dot ok" aria-hidden="true" />
                  <code className="ai-mono">{url}</code>
                </>
              ) : (
                <>
                  <span className="ai-status-dot" aria-hidden="true" />
                  <span className="claude-dialog-muted">Starting…</span>
                </>
              )}
            </div>
          </section>

          <section className="ai-section">
            <h4 className="ai-section-title">Connect an agent</h4>
            {agents == null ? (
              <p className="claude-dialog-muted">Detecting agents…</p>
            ) : !anyInstalled ? (
              <p className="claude-dialog-muted">
                No supported agents detected. Install Claude Code or Codex,
                then reopen this panel.
              </p>
            ) : (
              <div className="ai-actions">
                {agents.claude?.installed && (
                  <AgentRow
                    label="Claude Code"
                    added={agents.claude.mcpAdded}
                    onAdd={() =>
                      claudeCmd && runInTerminal(claudeCmd, "Claude Code")
                    }
                    canAdd={!!claudeCmd}
                  />
                )}
                {agents.codex?.installed && (
                  <AgentRow
                    label="Codex"
                    added={agents.codex.mcpAdded}
                    onAdd={() => codexCmd && runInTerminal(codexCmd, "Codex")}
                    canAdd={!!codexCmd}
                    icon={<CodexLogo />}
                  />
                )}
              </div>
            )}
          </section>

          <section className="ai-section">
            <h4 className="ai-section-title">Branch relevance</h4>
            <p>
              Highlight log entries tied to your current branch's changes,
              and unlock the <code>relevant:true</code> filter.
            </p>
            {!relevanceAvailable ? (
              <p className="claude-dialog-muted">
                Requires Claude Code. Install it to enable branch analysis.
              </p>
            ) : (
              <RelevanceBlock
                analyzing={analyzing}
                relevance={relevance}
                stale={relevanceStale}
                onAnalyze={runAnalyze}
                onClear={clearAnalysis}
              />
            )}
          </section>
        </div>
        <div className="claude-dialog-actions">
          <button type="button" className="claude-btn ghost" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="claude-btn danger"
            onClick={onDisconnect}
          >
            Disconnect
          </button>
        </div>
      </div>
    </div>
  );
}

interface RelevanceBlockProps {
  analyzing: boolean;
  relevance: ReturnType<typeof useStore.getState>["relevance"];
  stale: boolean;
  onAnalyze: () => void;
  onClear: () => void;
}

function RelevanceBlock({
  analyzing,
  relevance,
  stale,
  onAnalyze,
  onClear,
}: RelevanceBlockProps) {
  const status = analyzing
    ? "Analyzing — this can take 30–60s"
    : relevance
      ? `${relevance.regexes.length} pattern${
          relevance.regexes.length === 1 ? "" : "s"
        } · branch ${relevance.branch_state.branch}${stale ? " · branch changed since" : ""}`
      : "No analysis yet for this branch";
  const dotClass = analyzing
    ? "warn"
    : relevance && !stale
      ? "ok"
      : relevance && stale
        ? "warn"
        : "";
  return (
    <>
      <div className="ai-status-row">
        <span className={`ai-status-dot ${dotClass}`} aria-hidden="true" />
        <span className={relevance ? "" : "claude-dialog-muted"}>
          {status}
        </span>
      </div>
      <div className="ai-actions">
        <button
          type="button"
          className="claude-btn primary ai-agent-btn"
          onClick={onAnalyze}
          disabled={analyzing}
        >
          <SparkleIcon />
          <span>
            {analyzing
              ? "Analyzing…"
              : relevance
                ? "Re-run analysis"
                : "Analyze branch"}
          </span>
        </button>
        {relevance && !analyzing && (
          <button
            type="button"
            className="claude-btn ghost"
            onClick={onClear}
          >
            Clear
          </button>
        )}
      </div>
    </>
  );
}

interface AgentRowProps {
  label: string;
  added: boolean;
  canAdd: boolean;
  onAdd: () => void;
  icon?: React.ReactNode;
}

function AgentRow({ label, added, canAdd, onAdd, icon }: AgentRowProps) {
  if (added) {
    return (
      <div className="ai-agent-added">
        <CheckIcon /> Added to {label}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="claude-btn primary ai-agent-btn"
      onClick={onAdd}
      disabled={!canAdd}
    >
      {icon}
      <span>Add to {label}</span>
    </button>
  );
}

function CheckIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5l3.5 3.5 6.5-7" />
    </svg>
  );
}

function CodexLogo() {
  // OpenAI mark — three intersecting petals.
  return (
    <svg
      width="14"
      height="14"
      viewBox="-12 -12 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <ellipse cx="0" cy="0" rx="9" ry="3.4" />
      <ellipse cx="0" cy="0" rx="9" ry="3.4" transform="rotate(60)" />
      <ellipse cx="0" cy="0" rx="9" ry="3.4" transform="rotate(120)" />
    </svg>
  );
}
