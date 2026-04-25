import { create } from "zustand";
import type { LogEvent } from "./lib/ipc";

export const INSPECTOR_MIN = 100;
export const INSPECTOR_MAX = 600;
export const INSPECTOR_DEFAULT = 320;

interface Store {
  events: LogEvent[];
  filter: string;
  selectedId: number | null;
  inspectorHeight: number;
  setEvents: (events: LogEvent[]) => void;
  setFilter: (filter: string) => void;
  setSelected: (id: number | null) => void;
  setInspectorHeight: (h: number) => void;
}

export const useStore = create<Store>((set) => ({
  events: [],
  filter: "",
  selectedId: null,
  inspectorHeight: INSPECTOR_DEFAULT,
  setEvents: (events) => set({ events }),
  setFilter: (filter) => set({ filter }),
  setSelected: (selectedId) => set({ selectedId }),
  setInspectorHeight: (h) =>
    set({
      inspectorHeight: Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, h)),
    }),
}));
