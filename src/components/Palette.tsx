import { Command } from "cmdk";
import { useEffect, useState } from "react";

import { setMeta } from "../lib/ipc";
import { useStore } from "../store";

const RECENTS_KEY = "palette_recents";
const RECENTS_MAX = 5;

interface Action {
  id: string;
  label: string;
  group: "View" | "Time" | "Stream" | "Session" | "Export";
  shortcut?: string;
  run: () => void | Promise<void>;
}

export function Palette() {
  const [open, setOpen] = useState(false);
  const [recents, setRecents] = useState<string[]>([]);
  const views = useStore((s) => s.views);
  const setActiveViewId = useStore((s) => s.setActiveViewId);
  const setFilter = useStore((s) => s.setFilter);
  const paused = useStore((s) => s.paused);
  const setPaused = useStore((s) => s.setPaused);
  const events = useStore((s) => s.events);

  useEffect(() => {
    const stored = localStorage.getItem(RECENTS_KEY);
    if (stored) setRecents(JSON.parse(stored) as string[]);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const recordRecent = (id: string) => {
    setRecents((prev) => {
      const next = [id, ...prev.filter((x) => x !== id)].slice(0, RECENTS_MAX);
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
      return next;
    });
  };

  const actions: Action[] = [
    ...views.map<Action>((v) => ({
      id: `view-${v.id}`,
      label: `Switch view → ${v.name}`,
      group: "View",
      run: () => {
        setActiveViewId(v.id);
        setFilter(v.query);
        void setMeta("active_view", String(v.id));
      },
    })),
    {
      id: "jump-now",
      label: "Jump to now (clear time range)",
      group: "Time",
      run: () => {
        // strip ts:>= / ts:<= from current filter
        const f = useStore.getState().filter;
        let q = f.replace(/(\s+AND\s+|^)ts:(>|>=|<|<=)[\d.\-]+/g, (_, p) =>
          p.startsWith(" AND") ? "" : "",
        );
        q = q.replace(/ts:(>|>=|<|<=)[\d.\-]+\s+AND\s+/g, "");
        setFilter(q.trim());
      },
    },
    {
      id: "pause-toggle",
      label: paused ? "Resume live tail" : "Pause live tail",
      group: "Stream",
      shortcut: "Space",
      run: () => setPaused(!paused, events.length),
    },
    {
      id: "session-current",
      label: "Switch session → current",
      group: "Session",
      run: () => {},
    },
    {
      id: "export-jsonl",
      label: "Export selection as JSONL",
      group: "Export",
      run: () => {
        const blob = new Blob(
          [events.map((e) => JSON.stringify(e)).join("\n")],
          { type: "application/x-ndjson" },
        );
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `istoria-${Date.now()}.jsonl`;
        a.click();
        URL.revokeObjectURL(a.href);
      },
    },
  ];

  const ranked = [
    ...recents
      .map((id) => actions.find((a) => a.id === id))
      .filter((x): x is Action => Boolean(x)),
    ...actions.filter((a) => !recents.includes(a.id)),
  ];

  if (!open) return null;

  return (
    <div className="palette-overlay" onClick={() => setOpen(false)}>
      <div className="palette-dialog" onClick={(e) => e.stopPropagation()}>
        <Command label="Command palette">
          <Command.Input placeholder="Jump to view, time, session…" autoFocus />
          <Command.List>
            <Command.Empty>No actions match.</Command.Empty>
            {(["View", "Time", "Stream", "Session", "Export"] as const).map(
              (group) => {
                const items = ranked.filter((a) => a.group === group);
                if (items.length === 0) return null;
                return (
                  <Command.Group key={group} heading={group}>
                    {items.map((a) => (
                      <Command.Item
                        key={a.id}
                        value={a.label}
                        onSelect={() => {
                          void a.run();
                          recordRecent(a.id);
                          setOpen(false);
                        }}
                      >
                        <span>{a.label}</span>
                        {a.shortcut && (
                          <span className="palette-kbd">{a.shortcut}</span>
                        )}
                      </Command.Item>
                    ))}
                  </Command.Group>
                );
              },
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
