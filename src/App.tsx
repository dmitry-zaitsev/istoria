import { useEffect, useMemo, useRef, useState } from "react";

import { Chrome } from "./components/Chrome";
import { FilterBar } from "./components/FilterBar";
import { Inspector } from "./components/Inspector";
import { LogStream } from "./components/LogStream";
import { queryRecent, subscribeEvents, type LogEvent } from "./lib/ipc";
import { useStore } from "./store";

const QUERY_LIMIT = 100_000;

export default function App() {
  const events = useStore((s) => s.events);
  const filter = useStore((s) => s.filter);
  const selectedId = useStore((s) => s.selectedId);
  const setEvents = useStore((s) => s.setEvents);
  const setFilter = useStore((s) => s.setFilter);
  const setSelected = useStore((s) => s.setSelected);

  const [lastTickAt, setLastTickAt] = useState<number>(0);
  const filterRef = useRef(filter);
  filterRef.current = filter;

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await queryRecent(
          QUERY_LIMIT,
          filterRef.current || undefined,
        );
        if (cancelled) return;
        setEvents(next.slice().reverse() as LogEvent[]);
        setLastTickAt(Date.now());
      } catch (e) {
        console.warn("queryRecent failed", e);
      }
    };
    refresh();
    let unlisten: (() => void) | undefined;
    subscribeEvents(() => {
      void refresh();
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [setEvents, filter]);

  const selected = useMemo(
    () =>
      selectedId == null ? null : events.find((e) => e.id === selectedId),
    [events, selectedId],
  );

  const live = lastTickAt > 0 && Date.now() - lastTickAt < 5_000;

  return (
    <div className="app">
      <Chrome live={live} count={events.length} />
      <FilterBar value={filter} onChange={setFilter} />
      <LogStream
        events={events}
        selectedId={selectedId}
        onSelect={setSelected}
      />
      {selected && (
        <Inspector event={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
