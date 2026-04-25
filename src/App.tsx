import { useEffect, useMemo, useRef, useState } from "react";

import { Chrome } from "./components/Chrome";
import { FilterBar } from "./components/FilterBar";
import { Inspector } from "./components/Inspector";
import { LogStream } from "./components/LogStream";
import { StatusBar } from "./components/StatusBar";
import { StreamHeader } from "./components/StreamHeader";
import { queryRecent, subscribeEvents, type LogEvent } from "./lib/ipc";
import { useStore } from "./store";

const QUERY_LIMIT = 100_000;
const SESSION_ID = "1";

export default function App() {
  const events = useStore((s) => s.events);
  const filter = useStore((s) => s.filter);
  const selectedId = useStore((s) => s.selectedId);
  const inspectorH = useStore((s) => s.inspectorHeight);
  const setEvents = useStore((s) => s.setEvents);
  const setFilter = useStore((s) => s.setFilter);
  const setSelected = useStore((s) => s.setSelected);

  const [unfilteredCount, setUnfilteredCount] = useState(0);
  const [lastTickAt, setLastTickAt] = useState(0);
  const [, setNow] = useState(0);
  const filterRef = useRef(filter);
  filterRef.current = filter;

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const [filtered, all] = await Promise.all([
          queryRecent(QUERY_LIMIT, filterRef.current || undefined),
          filterRef.current
            ? queryRecent(QUERY_LIMIT)
            : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setEvents(filtered.slice().reverse() as LogEvent[]);
        setUnfilteredCount(all ? all.length : filtered.length);
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

  // Keep `live` derivation fresh after the last tick goes stale.
  useEffect(() => {
    const id = window.setInterval(() => setNow((n) => n + 1), 1_000);
    return () => window.clearInterval(id);
  }, []);

  const selected = useMemo(
    () => (selectedId == null ? null : events.find((e) => e.id === selectedId)),
    [events, selectedId],
  );

  const live = lastTickAt > 0 && Date.now() - lastTickAt < 5_000;
  const filterActive = filter.trim().length > 0;
  const bottomInset = selected ? inspectorH : 0;

  return (
    <div className="win">
      <Chrome live={live} count={unfilteredCount} session={SESSION_ID} />
      <FilterBar value={filter} onChange={setFilter} />
      <div className="main">
        <div className="stream-col">
          <StreamHeader
            total={unfilteredCount}
            filtered={events.length}
            filterActive={filterActive}
          />
          <LogStream
            events={events}
            selectedId={selectedId}
            onSelect={setSelected}
            bottomInset={bottomInset}
          />
          {selected && (
            <Inspector event={selected} onClose={() => setSelected(null)} />
          )}
        </div>
      </div>
      <StatusBar
        live={live}
        total={unfilteredCount}
        filtered={events.length}
        filterActive={filterActive}
      />
    </div>
  );
}
