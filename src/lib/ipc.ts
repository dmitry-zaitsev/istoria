import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Level = "error" | "warn" | "info" | "debug" | "trace";

export interface LogEvent {
  id: number;
  ts: number;
  source: string;
  level: Level;
  msg: string;
  raw: string;
  fields?: unknown;
}

export interface EventNewPayload {
  len: number;
  dropped: number;
}

export interface View {
  id: number;
  name: string;
  query: string;
  sort_order: number;
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

export async function listViews(): Promise<View[]> {
  return invoke<View[]>("views_list");
}

export async function createView(name: string, query: string): Promise<View> {
  return invoke<View>("views_create", { name, query });
}

export async function updateView(
  id: number,
  name: string,
  query: string,
): Promise<void> {
  return invoke("views_update", { id, name, query });
}

export async function deleteView(id: number): Promise<void> {
  return invoke("views_delete", { id });
}

export async function duplicateView(id: number): Promise<View> {
  return invoke<View>("views_duplicate", { id });
}

export async function getMeta(key: string): Promise<string | null> {
  return invoke<string | null>("meta_get", { key });
}

export async function setMeta(key: string, value: string): Promise<void> {
  return invoke("meta_set", { key, value });
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

export interface Alert {
  id: number;
  name: string;
  query: string;
  color: string;
  notify: boolean;
  debounce_ms: number;
  enabled: boolean;
}

export async function listAlerts(): Promise<Alert[]> {
  return invoke<Alert[]>("alerts_list");
}

export async function createAlert(input: Omit<Alert, "id" | "enabled">): Promise<Alert> {
  return invoke<Alert>("alerts_create", {
    name: input.name,
    query: input.query,
    color: input.color,
    notify: input.notify,
    debounceMs: input.debounce_ms,
  });
}

export async function setAlertEnabled(id: number, enabled: boolean): Promise<void> {
  return invoke("alerts_set_enabled", { id, enabled });
}

export async function deleteAlert(id: number): Promise<void> {
  return invoke("alerts_delete", { id });
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
