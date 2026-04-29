import { create } from "zustand";
import type { Alert } from "./lib/alerts";
import type { LogEvent } from "./lib/ipc";
import type { TransformerRule } from "./lib/transformers";
import type { View } from "./lib/views";

export const INSPECTOR_MIN = 100;
export const INSPECTOR_MAX = 600;
export const INSPECTOR_DEFAULT = 320;

export type SortKey = "newest-bottom" | "newest-top";

const SORT_KEY = "sort.v1";

function loadInitialSort(): SortKey {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    if (raw === "newest-bottom" || raw === "newest-top") return raw;
  } catch {
    // ignore
  }
  return "newest-top";
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
  pinnedIds: Set<number>;
  scrollTargetId: number | null;
  alerts: Alert[];
  transformers: TransformerRule[];
  sources: string[];
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
  setPinnedIds: (ids: Set<number>) => void;
  togglePinLocal: (id: number) => void;
  setScrollTarget: (id: number | null) => void;
  setAlerts: (alerts: Alert[]) => void;
  setTransformers: (rules: TransformerRule[]) => void;
  setSources: (sources: string[]) => void;
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
  pinnedIds: new Set<number>(),
  scrollTargetId: null,
  alerts: [],
  transformers: [],
  sources: [],
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
      pausedBaseline: paused ? baseline ?? s.events.length : 0,
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
  setTransformers: (transformers) => set({ transformers }),
  setSources: (sources) => set({ sources }),
}));
