import { useEffect, useState } from "react";

import {
  claudeStatus,
  codexStatus,
  mcpPort,
  openTerminal,
  type ClaudeStatus,
} from "../lib/ipc";
import { toast } from "../lib/toast";
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
              Local agents like Claude Code and Codex can query your logs via
              MCP.
            </p>
            <p className="claude-dialog-muted">
              {url ? (
                <>
                  Running on <code>{url}</code>
                </>
              ) : (
                <>Starting…</>
              )}
            </p>
          </section>

          <section className="ai-section">
            <h4 className="ai-section-title">Connect an agent</h4>
            {agents == null ? (
              <p className="claude-dialog-muted">Detecting agents…</p>
            ) : !anyInstalled ? (
              <p className="claude-dialog-muted">
                No supported agents detected on this machine. Install Claude
                Code or Codex, then reopen this panel.
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
