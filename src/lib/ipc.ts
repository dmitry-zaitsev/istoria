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

export async function queryRecent(limit: number, filter?: string): Promise<LogEvent[]> {
  return invoke<LogEvent[]>("query_recent", { limit, filter: filter ?? null });
}

export interface QuerySincePayload {
  events: LogEvent[];
  /// Lowest id still in the ring, or null when empty. If
  /// `minId > lastId + 1` the caller's cursor fell off the back of the
  /// ring and the caller must fall back to `queryRecent` + reset.
  minId: number | null;
  /// Total events currently in the ring.
  len: number;
}

interface RawQuerySincePayload {
  events: LogEvent[];
  min_id: number | null;
  len: number;
}

export async function querySince(lastId: number, limit: number): Promise<QuerySincePayload> {
  const raw = await invoke<RawQuerySincePayload>("query_since", { lastId, limit });
  return { events: raw.events, minId: raw.min_id, len: raw.len };
}

export async function subscribeEvents(cb: (payload: EventNewPayload) => void): Promise<UnlistenFn> {
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
  context: number
): Promise<CodeLine[]> {
  return invoke<CodeLine[]>("get_code_preview", { path, line, context });
}

export async function getEmissionSite(msg: string): Promise<EmissionSite | null> {
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

export type InstallMethod = "homebrew" | "other";

export interface UpdateInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
  installMethod: InstallMethod;
  releaseUrl: string;
  brewFormula: string;
}

export async function checkForUpdates(): Promise<UpdateInfo> {
  return invoke<UpdateInfo>("check_for_updates");
}

export async function detectInstallMethod(): Promise<InstallMethod> {
  return invoke<InstallMethod>("detect_install_method");
}

export interface CliLinkStatus {
  needed: boolean;
  installed: boolean;
  linkPath: string;
  binaryPath: string | null;
}

export async function cliLinkStatus(): Promise<CliLinkStatus> {
  return invoke<CliLinkStatus>("cli_link_status");
}

export async function installCliLink(): Promise<void> {
  return invoke<void>("install_cli_link");
}

export type PatternKind = { kind: "direct" } | { kind: "indirect"; via_files: string[] };

export interface RelevanceSite {
  source: string;
  rel_path: string;
  abs_path: string;
  line: number;
  raw_call: string;
  snippet: CodeLine[];
  emitted_count: number;
  kind: PatternKind;
}

export interface RelevanceSnapshot {
  ids: number[];
  sites: RelevanceSite[];
}

export async function relevanceSnapshot(): Promise<RelevanceSnapshot> {
  return invoke<RelevanceSnapshot>("relevance_snapshot");
}

export async function focusChanged(focused: boolean): Promise<void> {
  return invoke("focus_changed", { focused });
}

export async function subscribeRelevance(cb: () => void): Promise<UnlistenFn> {
  return listen("relevance-updated", () => cb());
}

// Emitted by the native macOS graphics-recovery observers (src/redraw.rs)
// after a context rebuild (sleep/wake, display sleep/wake, monitor or
// backing-scale change) so the web layer can flush its own stale tiles.
export async function subscribeGfxRebuilt(cb: () => void): Promise<UnlistenFn> {
  return listen("gfx-context-rebuilt", () => cb());
}

// Force a native WKWebView repaint (macOS). The wall-clock heartbeat uses
// the soft path; the manual ⌘⇧R escape hatch passes hard=true to add a
// hide/show cycle that clears a stuck ghost.
export async function forceRedraw(hard = false): Promise<void> {
  return invoke("force_redraw", { hard });
}
