import { create } from "zustand";
import type { LogEvent, View } from "./lib/ipc";

export const INSPECTOR_MIN = 100;
export const INSPECTOR_MAX = 600;
export const INSPECTOR_DEFAULT = 320;

export type SortKey = "newest-bottom" | "newest-top" | "level";

interface Store {
  events: LogEvent[];
  filter: string;
  selectedId: number | null;
  inspectorHeight: number;
  views: View[];
  activeViewId: number | null;
  paused: boolean;
  pausedBaseline: number; // event count when paused
  sort: SortKey;
  setEvents: (events: LogEvent[]) => void;
  setFilter: (filter: string) => void;
  setSelected: (id: number | null) => void;
  setInspectorHeight: (h: number) => void;
  setViews: (views: View[]) => void;
  setActiveViewId: (id: number | null) => void;
  setPaused: (paused: boolean, baseline?: number) => void;
  setSort: (sort: SortKey) => void;
}

export const useStore = create<Store>((set) => ({
  events: [],
  filter: "",
  selectedId: null,
  inspectorHeight: INSPECTOR_DEFAULT,
  views: [],
  activeViewId: null,
  paused: false,
  pausedBaseline: 0,
  sort: "newest-bottom",
  setEvents: (events) => set({ events }),
  setFilter: (filter) => set({ filter }),
  setSelected: (selectedId) => set({ selectedId }),
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
  setSort: (sort) => set({ sort }),
}));
