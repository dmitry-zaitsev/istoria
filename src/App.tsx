import { useEffect, useMemo, useState } from "react";

import { Chrome } from "./components/Chrome";
import { FilterBar } from "./components/FilterBar";
import { Inspector } from "./components/Inspector";
import { LogStream } from "./components/LogStream";
import { StatusBar } from "./components/StatusBar";
import { StreamHeader } from "./components/StreamHeader";
import { Tabs } from "./components/Tabs";
import { Facets } from "./components/Facets";
import { Histogram } from "./components/Histogram";
import { Palette } from "./components/Palette";
import { Toast } from "./components/Toast";
import {
  getMeta,
  listViews,
  queryRecent,
  subscribeEvents,
  type LogEvent,
} from "./lib/ipc";
import { evalAst, isError, parse } from "./lib/query";
import { useStore, type SortKey } from "./store";

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
  const setViews = useStore((s) => s.setViews);
  const setActiveViewId = useStore((s) => s.setActiveViewId);
  const sort = useStore((s) => s.sort);

  const [unfilteredCount, setUnfilteredCount] = useState(0);
  const [unfilteredEvents, setUnfilteredEvents] = useState<LogEvent[]>([]);
  const [lastTickAt, setLastTickAt] = useState(0);
  const [, setNow] = useState(0);

  const parsed = useMemo(() => parse(filter), [filter]);
  const filterValid = !isError(parsed);

  // Bootstrap views + active id from DuckDB.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await listViews();
        if (cancelled) return;
        setViews(all);
        if (all.length > 0) {
          const stored = await getMeta("active_view");
          const storedId = stored ? Number(stored) : NaN;
          const active =
            all.find((v) => v.id === storedId) ?? all[0]!;
          setActiveViewId(active.id);
          setFilter(active.query);
        }
      } catch (e) {
        console.warn("views bootstrap failed", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setViews, setActiveViewId, setFilter]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const all = await queryRecent(QUERY_LIMIT);
        if (cancelled) return;
        const ordered = all.slice().reverse() as LogEvent[];
        const filtered = filterValid
          ? ordered.filter((ev) => evalAst(parsed, ev))
          : ordered;
        const sorted = applySort(filtered, sort);
        setEvents(sorted);
        setUnfilteredEvents(ordered);
        setUnfilteredCount(ordered.length);
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
  }, [setEvents, parsed, filterValid, sort]);

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
      <Palette />
      <Toast />
      <Chrome live={live} count={unfilteredCount} session={SESSION_ID} />
      <Tabs />
      <FilterBar value={filter} onChange={setFilter} />
      <Histogram
        events={unfilteredEvents}
        filter={filter}
        onFilterChange={setFilter}
      />
      <div className="main">
        <Facets
          events={events}
          filter={filter}
          onFilterChange={setFilter}
        />
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
            <Inspector
              event={selected}
              events={unfilteredEvents}
              onSelect={setSelected}
              onClose={() => setSelected(null)}
            />
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

const LEVEL_RANK: Record<string, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

function applySort(events: LogEvent[], sort: SortKey): LogEvent[] {
  // events arrive oldest-first (queryRecent reversed). The live-tail
  // default keeps that order so LogStream's scroll-to-bottom places
  // newest at the bottom.
  if (sort === "newest-bottom") return events;
  const out = events.slice();
  if (sort === "newest-top") {
    out.sort((a, b) => b.ts - a.ts || b.id - a.id);
  } else if (sort === "level") {
    out.sort((a, b) => {
      const ra = LEVEL_RANK[a.level] ?? 9;
      const rb = LEVEL_RANK[b.level] ?? 9;
      if (ra !== rb) return ra - rb;
      return b.ts - a.ts;
    });
  }
  return out;
}
