import { create } from "zustand";
import type { LogEvent, View } from "./lib/ipc";

export const INSPECTOR_MIN = 100;
export const INSPECTOR_MAX = 600;
export const INSPECTOR_DEFAULT = 320;

interface Store {
  events: LogEvent[];
  filter: string;
  selectedId: number | null;
  inspectorHeight: number;
  views: View[];
  activeViewId: number | null;
  setEvents: (events: LogEvent[]) => void;
  setFilter: (filter: string) => void;
  setSelected: (id: number | null) => void;
  setInspectorHeight: (h: number) => void;
  setViews: (views: View[]) => void;
  setActiveViewId: (id: number | null) => void;
}

export const useStore = create<Store>((set) => ({
  events: [],
  filter: "",
  selectedId: null,
  inspectorHeight: INSPECTOR_DEFAULT,
  views: [],
  activeViewId: null,
  setEvents: (events) => set({ events }),
  setFilter: (filter) => set({ filter }),
  setSelected: (selectedId) => set({ selectedId }),
  setInspectorHeight: (h) =>
    set({
      inspectorHeight: Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, h)),
    }),
  setViews: (views) => set({ views }),
  setActiveViewId: (activeViewId) => set({ activeViewId }),
}));
