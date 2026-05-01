import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Level = "error" | "warn" | "info" | "debug" | "trace";

export interface LogEvent {
  id: number;
  ts: number;
  source: string;
  branch: string;
  level: Level;
  msg: string;
  raw: string;
  fields?: unknown;
}

export interface EventNewPayload {
  len: number;
  dropped: number;
}

export async function queryRecent(
  limit: number,
  filter?: string,
): Promise<LogEvent[]> {
  return invoke<LogEvent[]>("query_recent", { limit, filter: filter ?? null });
}

export async function subscribeEvents(
  cb: (payload: EventNewPayload) => void,
): Promise<UnlistenFn> {
  return listen<EventNewPayload>("event-new", (e) => cb(e.payload));
}

export async function clearSession(): Promise<void> {
  return invoke("clear_session");
}

export async function pinEvent(eventId: number): Promise<void> {
  return invoke("pin_event", { eventId });
}

export async function unpinEvent(eventId: number): Promise<void> {
  return invoke("unpin_event", { eventId });
}

export async function listPins(): Promise<number[]> {
  return invoke<number[]>("list_pins");
}

export interface CodeLine {
  line: number;
  text: string;
}

export interface EmissionSite {
  path: string;
  rel_path: string;
  line: number;
  preview: CodeLine[];
  is_local: boolean;
}

export async function getCodePreview(
  path: string,
  line: number,
  context: number,
): Promise<CodeLine[]> {
  return invoke<CodeLine[]>("get_code_preview", { path, line, context });
}

export async function getEmissionSite(
  msg: string,
): Promise<EmissionSite | null> {
  return invoke<EmissionSite | null>("get_emission_site", { msg });
}

export async function openUrl(url: string): Promise<void> {
  return invoke("open_url", { url });
}

export interface EditorEntry {
  id: string;
  name: string;
  url_template: string;
}

export async function listEditors(): Promise<EditorEntry[]> {
  return invoke<EditorEntry[]>("list_editors");
}

export interface ClaudeStatus {
  installed: boolean;
  path: string | null;
  mcpAdded: boolean;
}

export async function claudeStatus(): Promise<ClaudeStatus> {
  return invoke<ClaudeStatus>("claude_status");
}

export async function codexStatus(): Promise<ClaudeStatus> {
  return invoke<ClaudeStatus>("codex_status");
}

export async function mcpPort(): Promise<number> {
  return invoke<number>("mcp_port");
}

export async function openTerminal(command: string): Promise<void> {
  return invoke("open_terminal", { command });
}

export interface BranchState {
  branch: string;
  head_sha: string;
  has_uncommitted: boolean;
  default_branch: string;
}

export interface RelevanceAnalysis {
  regexes: string[];
  branch_state: BranchState;
}

export async function branchState(): Promise<BranchState> {
  return invoke<BranchState>("branch_state");
}

export async function analyzeBranchRelevance(): Promise<RelevanceAnalysis> {
  return invoke<RelevanceAnalysis>("analyze_branch_relevance");
}
