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
