import { create } from "zustand";
import type { Alert } from "./lib/alerts";
import type { LogEvent, RelevanceAnalysis } from "./lib/ipc";
import type { View } from "./lib/views";

export const INSPECTOR_MIN = 100;
export const INSPECTOR_MAX = 600;
export const INSPECTOR_DEFAULT = 320;

export type ColKey = "ts" | "lvl" | "src" | "br";
export type ColumnWidths = Record<ColKey, number>;
export type ColumnVisibility = Partial<Record<ColKey, boolean>>;
export interface FieldColumn {
  path: string;
  width: number;
}

export const COL_MIN: Record<ColKey, number> = { ts: 60, lvl: 44, src: 50, br: 50 };
export const COL_MAX: Record<ColKey, number> = { ts: 240, lvl: 140, src: 400, br: 400 };
export const COL_DEFAULTS: ColumnWidths = { ts: 92, lvl: 64, src: 80, br: 100 };

export const FIELD_COL_MIN = 40;
export const FIELD_COL_MAX = 600;
export const FIELD_COL_DEFAULT = 120;

const COLS_KEY = "cols.v1";
const COLS_VIS_KEY = "cols.vis.v1";
const COLS_FIELDS_KEY = "cols.fields.v1";

function loadInitialCols(): ColumnWidths {
  try {
    const raw = localStorage.getItem(COLS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ColumnWidths>;
      const out: ColumnWidths = { ...COL_DEFAULTS };
      for (const k of ["ts", "lvl", "src", "br"] as const) {
        const v = parsed[k];
        if (typeof v === "number" && Number.isFinite(v)) {
          out[k] = Math.min(COL_MAX[k], Math.max(COL_MIN[k], v));
        }
      }
      return out;
    }
  } catch {
    // ignore
  }
  return { ...COL_DEFAULTS };
}

function loadInitialVisibility(): ColumnVisibility {
  try {
    const raw = localStorage.getItem(COLS_VIS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as ColumnVisibility;
    const out: ColumnVisibility = {};
    for (const k of ["ts", "lvl", "src", "br"] as const) {
      const v = parsed[k];
      if (typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function loadInitialFieldColumns(): FieldColumn[] {
  try {
    const raw = localStorage.getItem(COLS_FIELDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: FieldColumn[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const path = (item as { path?: unknown }).path;
      const width = (item as { width?: unknown }).width;
      if (typeof path !== "string" || !path || seen.has(path)) continue;
      seen.add(path);
      const w =
        typeof width === "number" && Number.isFinite(width)
          ? Math.min(FIELD_COL_MAX, Math.max(FIELD_COL_MIN, width))
          : FIELD_COL_DEFAULT;
      out.push({ path, width: w });
    }
    return out;
  } catch {
    return [];
  }
}

export type SortKey = "newest-bottom" | "newest-top";

const SORT_KEY = "sort.v1";
const CLAUDE_CONNECTED_KEY = "claudeConnected.v1";
const RELEVANCE_KEY = "relevance.v1";

function loadInitialSort(): SortKey {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    if (raw === "newest-bottom" || raw === "newest-top") return raw;
  } catch {
    // ignore
  }
  return "newest-top";
}

function loadInitialClaudeConnected(): boolean {
  try {
    return localStorage.getItem(CLAUDE_CONNECTED_KEY) === "1";
  } catch {
    return false;
  }
}

function loadInitialRelevance(): RelevanceAnalysis | null {
  try {
    const raw = localStorage.getItem(RELEVANCE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      Array.isArray(parsed.regexes) &&
      parsed.branch_state &&
      typeof parsed.branch_state.head_sha === "string"
    ) {
      return parsed as RelevanceAnalysis;
    }
  } catch {
    // ignore
  }
  return null;
}

interface Store {
  events: LogEvent[];
  filter: string;
  selectedId: number | null;
  selectedIds: number[]; // multi-select; empty when none. selectedId is "primary".
  inspectorHeight: number;
  views: View[];
  activeViewId: number | null;
  paused: boolean;
  pausedBaseline: number; // unused since DEE-75 (kept for future)
  newCount: number;
  sort: SortKey;
  claudeConnected: boolean;
  relevance: RelevanceAnalysis | null;
  /// True after a window-focus check observed a branch state different
  /// from the analysis we have stored. Reset to false on re-analyze
  /// or clear.
  relevanceStale: boolean;
  /// While analyze is in flight we disable the trigger to prevent
  /// double-spawning a Claude subprocess.
  relevanceAnalyzing: boolean;
  pinnedIds: Set<number>;
  scrollTargetId: number | null;
  alerts: Alert[];
  sources: string[];
  branches: string[];
  columnWidths: ColumnWidths;
  columnVisibility: ColumnVisibility;
  fieldColumns: FieldColumn[];
  setEvents: (events: LogEvent[]) => void;
  setFilter: (filter: string) => void;
  setSelected: (id: number | null) => void;
  setSelectedIds: (ids: number[]) => void;
  setInspectorHeight: (h: number) => void;
  setViews: (views: View[]) => void;
  setActiveViewId: (id: number | null) => void;
  setPaused: (paused: boolean, baseline?: number) => void;
  setNewCount: (n: number) => void;
  setSort: (sort: SortKey) => void;
  setClaudeConnected: (connected: boolean) => void;
  setRelevance: (a: RelevanceAnalysis | null) => void;
  setRelevanceStale: (stale: boolean) => void;
  setRelevanceAnalyzing: (analyzing: boolean) => void;
  setPinnedIds: (ids: Set<number>) => void;
  togglePinLocal: (id: number) => void;
  setScrollTarget: (id: number | null) => void;
  setAlerts: (alerts: Alert[]) => void;
  setSources: (sources: string[]) => void;
  setBranches: (branches: string[]) => void;
  setColumnWidth: (col: ColKey, w: number) => void;
  setColumnVisible: (col: ColKey, visible: boolean) => void;
  resetColumnVisibility: (col: ColKey) => void;
  toggleFieldColumn: (path: string) => void;
  setFieldColumnWidth: (path: string, w: number) => void;
}

export const useStore = create<Store>((set) => ({
  events: [],
  filter: "",
  selectedId: null,
  selectedIds: [],
  inspectorHeight: INSPECTOR_DEFAULT,
  views: [],
  activeViewId: null,
  paused: false,
  pausedBaseline: 0,
  newCount: 0,
  sort: loadInitialSort(),
  claudeConnected: loadInitialClaudeConnected(),
  relevance: loadInitialRelevance(),
  relevanceStale: false,
  relevanceAnalyzing: false,
  pinnedIds: new Set<number>(),
  scrollTargetId: null,
  alerts: [],
  sources: [],
  branches: [],
  columnWidths: loadInitialCols(),
  columnVisibility: loadInitialVisibility(),
  fieldColumns: loadInitialFieldColumns(),
  setEvents: (events) => set({ events }),
  setFilter: (filter) => set({ filter }),
  setSelected: (selectedId) =>
    set({
      selectedId,
      selectedIds: selectedId == null ? [] : [selectedId],
    }),
  setSelectedIds: (selectedIds) => set({ selectedIds }),
  setInspectorHeight: (h) =>
    set({
      inspectorHeight: Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, h)),
    }),
  setViews: (views) => set({ views }),
  setActiveViewId: (activeViewId) => set({ activeViewId }),
  setPaused: (paused, baseline) =>
    set((s) => ({
      paused,
      pausedBaseline: paused ? (baseline ?? s.events.length) : 0,
    })),
  setNewCount: (newCount) => set({ newCount }),
  setSort: (sort) => {
    try {
      localStorage.setItem(SORT_KEY, sort);
    } catch {
      // ignore
    }
    set({ sort });
  },
  setClaudeConnected: (connected) => {
    try {
      localStorage.setItem(CLAUDE_CONNECTED_KEY, connected ? "1" : "0");
    } catch {
      // ignore
    }
    set({ claudeConnected: connected });
  },
  setRelevance: (a) => {
    try {
      if (a) localStorage.setItem(RELEVANCE_KEY, JSON.stringify(a));
      else localStorage.removeItem(RELEVANCE_KEY);
    } catch {
      // ignore
    }
    set({ relevance: a, relevanceStale: false });
  },
  setRelevanceStale: (stale) => set({ relevanceStale: stale }),
  setRelevanceAnalyzing: (analyzing) => set({ relevanceAnalyzing: analyzing }),
  setPinnedIds: (pinnedIds) => set({ pinnedIds }),
  togglePinLocal: (id) =>
    set((s) => {
      const next = new Set(s.pinnedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { pinnedIds: next };
    }),
  setScrollTarget: (scrollTargetId) => set({ scrollTargetId }),
  setAlerts: (alerts) => set({ alerts }),
  setSources: (sources) => set({ sources }),
  setBranches: (branches) => set({ branches }),
  setColumnWidth: (col, w) =>
    set((s) => {
      const clamped = Math.min(COL_MAX[col], Math.max(COL_MIN[col], w));
      const next = { ...s.columnWidths, [col]: clamped };
      try {
        localStorage.setItem(COLS_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return { columnWidths: next };
    }),
  setColumnVisible: (col, visible) =>
    set((s) => {
      const next: ColumnVisibility = { ...s.columnVisibility, [col]: visible };
      try {
        localStorage.setItem(COLS_VIS_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return { columnVisibility: next };
    }),
  resetColumnVisibility: (col) =>
    set((s) => {
      const next: ColumnVisibility = { ...s.columnVisibility };
      delete next[col];
      try {
        localStorage.setItem(COLS_VIS_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return { columnVisibility: next };
    }),
  toggleFieldColumn: (path) =>
    set((s) => {
      const i = s.fieldColumns.findIndex((c) => c.path === path);
      const next =
        i >= 0
          ? s.fieldColumns.filter((_, j) => j !== i)
          : [...s.fieldColumns, { path, width: FIELD_COL_DEFAULT }];
      try {
        localStorage.setItem(COLS_FIELDS_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return { fieldColumns: next };
    }),
  setFieldColumnWidth: (path, w) =>
    set((s) => {
      const clamped = Math.min(FIELD_COL_MAX, Math.max(FIELD_COL_MIN, w));
      const next = s.fieldColumns.map((c) => (c.path === path ? { ...c, width: clamped } : c));
      try {
        localStorage.setItem(COLS_FIELDS_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return { fieldColumns: next };
    }),
}));
