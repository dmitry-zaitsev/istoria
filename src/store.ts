import { create } from "zustand";
import type { LogEvent } from "./lib/ipc";

interface Store {
  events: LogEvent[];
  filter: string;
  selectedId: number | null;
  setEvents: (events: LogEvent[]) => void;
  setFilter: (filter: string) => void;
  setSelected: (id: number | null) => void;
}

export const useStore = create<Store>((set) => ({
  events: [],
  filter: "",
  selectedId: null,
  setEvents: (events) => set({ events }),
  setFilter: (filter) => set({ filter }),
  setSelected: (selectedId) => set({ selectedId }),
}));
