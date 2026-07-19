// Backend bridge. Talks to the headless Rust core (`istoria-core`) over HTTP +
// SSE on loopback. The port and per-launch bearer token are injected by the
// Electron preload (`window.istoria`). Types and function signatures are
// unchanged from the old Tauri-`invoke` version, so the rest of the app is
// untouched by the transport swap.

export type Level = "error" | "warn" | "info" | "debug" | "trace";

export type UnlistenFn = () => void;

export type UpdateEvent =
  | { type: "available"; payload: { version: string } }
  | { type: "not-available"; payload: Record<string, never> }
  | { type: "progress"; payload: { percent: number } }
  | { type: "downloaded"; payload: { version: string } }
  | { type: "error"; payload: { message: string } };

declare global {
  interface Window {
    istoria?: {
      httpPort: number;
      token: string;
      relaunch: () => Promise<void>;
      update: {
        start: () => Promise<void>;
        install: () => Promise<void>;
        onEvent: (cb: (e: UpdateEvent) => void) => () => void;
      };
    };
  }
}

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

function base(): string {
  const port = window.istoria?.httpPort ?? 9787;
  return `http://127.0.0.1:${port}`;
}

function token(): string {
  return window.istoria?.token ?? "";
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(base() + path, {
    headers: { authorization: `Bearer ${token()}` },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return (await res.json()) as T;
}

async function send<T>(method: "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  const hasBody = body !== undefined;
  const res = await fetch(base() + path, {
    method,
    headers: {
      authorization: `Bearer ${token()}`,
      ...(hasBody ? { "content-type": "application/json" } : {}),
    },
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// ---- SSE (shared connection for event-new + relevance-updated) -------------

let eventSource: EventSource | null = null;

function stream(): EventSource {
  if (eventSource && eventSource.readyState !== EventSource.CLOSED) return eventSource;
  const port = window.istoria?.httpPort ?? 9787;
  // EventSource can't set headers → token rides in the query string.
  eventSource = new EventSource(
    `http://127.0.0.1:${port}/stream?token=${encodeURIComponent(token())}`
  );
  return eventSource;
}

// ---- queries ---------------------------------------------------------------

export async function queryRecent(limit: number, filter?: string): Promise<LogEvent[]> {
  const q = filter ? `&filter=${encodeURIComponent(filter)}` : "";
  return getJson<LogEvent[]>(`/query/recent?limit=${limit}${q}`);
}

export interface QuerySincePayload {
  events: LogEvent[];
  minId: number | null;
  len: number;
}

interface RawQuerySincePayload {
  events: LogEvent[];
  min_id: number | null;
  len: number;
}

export async function querySince(lastId: number, limit: number): Promise<QuerySincePayload> {
  const raw = await getJson<RawQuerySincePayload>(`/query/since?last_id=${lastId}&limit=${limit}`);
  return { events: raw.events, minId: raw.min_id, len: raw.len };
}

export async function subscribeEvents(cb: (payload: EventNewPayload) => void): Promise<UnlistenFn> {
  const s = stream();
  const handler = (e: MessageEvent) => {
    try {
      cb(JSON.parse(e.data) as EventNewPayload);
    } catch {
      /* malformed frame — ignore */
    }
  };
  s.addEventListener("event-new", handler as EventListener);
  return () => s.removeEventListener("event-new", handler as EventListener);
}

export async function clearSession(): Promise<void> {
  await send("POST", "/session/clear");
}

export async function pinEvent(eventId: number): Promise<void> {
  await send("POST", "/pins", { event_id: eventId });
}

export async function unpinEvent(eventId: number): Promise<void> {
  await send("DELETE", `/pins/${eventId}`);
}

export async function listPins(): Promise<number[]> {
  return getJson<number[]>("/pins");
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
  return getJson<CodeLine[]>(
    `/code/preview?path=${encodeURIComponent(path)}&line=${line}&context=${context}`
  );
}

export async function getEmissionSite(msg: string): Promise<EmissionSite | null> {
  return getJson<EmissionSite | null>(`/code/emission-site?msg=${encodeURIComponent(msg)}`);
}

export async function openUrl(url: string): Promise<void> {
  await send("POST", "/open-url", { url });
}

export interface EditorEntry {
  id: string;
  name: string;
  url_template: string;
}

export async function listEditors(): Promise<EditorEntry[]> {
  return getJson<EditorEntry[]>("/editors");
}

export interface ClaudeStatus {
  installed: boolean;
  path: string | null;
  mcpAdded: boolean;
}

export async function claudeStatus(): Promise<ClaudeStatus> {
  return getJson<ClaudeStatus>("/claude/status");
}

export async function codexStatus(): Promise<ClaudeStatus> {
  return getJson<ClaudeStatus>("/codex/status");
}

export async function mcpPort(): Promise<number> {
  return getJson<number>("/mcp/port");
}

export async function openTerminal(command: string): Promise<void> {
  await send("POST", "/open-terminal", { command });
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
  return getJson<UpdateInfo>("/update/check");
}

export async function detectInstallMethod(): Promise<InstallMethod> {
  return getJson<InstallMethod>("/install-method");
}

export interface CliLinkStatus {
  needed: boolean;
  installed: boolean;
  linkPath: string;
  binaryPath: string | null;
}

export async function cliLinkStatus(): Promise<CliLinkStatus> {
  return getJson<CliLinkStatus>("/cli-link");
}

export async function installCliLink(): Promise<void> {
  await send("POST", "/cli-link/install");
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
  return getJson<RelevanceSnapshot>("/relevance/snapshot");
}

export async function focusChanged(focused: boolean): Promise<void> {
  await send("POST", "/focus", { focused });
}

export async function subscribeRelevance(cb: () => void): Promise<UnlistenFn> {
  const s = stream();
  const handler = () => cb();
  s.addEventListener("relevance-updated", handler);
  return () => s.removeEventListener("relevance-updated", handler);
}
