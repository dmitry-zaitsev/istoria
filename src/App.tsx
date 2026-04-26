import { useEffect, useMemo, useState } from "react";

import { Chrome } from "./components/Chrome";
import { FilterBar } from "./components/FilterBar";
import { Inspector } from "./components/Inspector";
import { LogStream } from "./components/LogStream";
import { StatusBar } from "./components/StatusBar";
import { StreamHeader } from "./components/StreamHeader";
import { Tabs } from "./components/Tabs";
import { Facets } from "./components/Facets";
import { computeFacets } from "./lib/facets";
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
import { evalAst, isError, parse, type Ast } from "./lib/query";
import { useStore, type SortKey } from "./store";

const QUERY_LIMIT = 100_000;

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
  const setSort = useStore((s) => s.setSort);

  const [unfilteredCount, setUnfilteredCount] = useState(0);
  const [unfilteredEvents, setUnfilteredEvents] = useState<LogEvent[]>([]);

  const parsed = useMemo(() => parse(filter), [filter]);
  const filterValid = !isError(parsed);

  // Facets only respect the ts: bounds (if any), not the full query —
  // so changing a level filter doesn't shrink the source list to one
  // value. If no ts bounds are set, all events are visible.
  const tsBounds = useMemo(() => {
    if (isError(parsed)) return { lo: -Infinity, hi: Infinity };
    return collectTsBounds(parsed);
  }, [parsed]);
  const tsScopedEvents = useMemo(
    () =>
      unfilteredEvents.filter(
        (e) => e.ts >= tsBounds.lo && e.ts <= tsBounds.hi,
      ),
    [unfilteredEvents, tsBounds.lo, tsBounds.hi],
  );
  const suggestKeys = useMemo(() => {
    const groups = computeFacets(tsScopedEvents);
    return ["msg", "raw", "ts", ...groups.map((g) => g.key)];
  }, [tsScopedEvents]);
  const suggestValuesByKey = useMemo(() => {
    const m = new Map<string, string[]>();
    const groups = computeFacets(tsScopedEvents);
    for (const g of groups) {
      m.set(
        g.key,
        g.values.slice(0, 50).map((v) => v.value),
      );
    }
    return m;
  }, [tsScopedEvents]);

  const showSource = useMemo(() => {
    const seen = new Set<string>();
    for (const e of unfilteredEvents) {
      seen.add(e.source);
      if (seen.size > 1) return true;
    }
    return false;
  }, [unfilteredEvents]);

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
        const storedSort = await getMeta("sort");
        if (storedSort === "newest-bottom" || storedSort === "newest-top" || storedSort === "level") {
          setSort(storedSort);
        }
      } catch (e) {
        console.warn("views bootstrap failed", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setViews, setActiveViewId, setFilter, setSort]);

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

  const selected = useMemo(
    () => (selectedId == null ? null : events.find((e) => e.id === selectedId)),
    [events, selectedId],
  );

  const filterActive = filter.trim().length > 0;
  const bottomInset = selected ? inspectorH : 0;

  return (
    <div className="win">
      <Palette />
      <Toast />
      <Chrome />
      <Tabs />
      <FilterBar
        value={filter}
        onChange={setFilter}
        suggestKeys={suggestKeys}
        suggestValuesByKey={suggestValuesByKey}
      />
      <Histogram
        events={events}
        filter={filter}
        onFilterChange={setFilter}
      />
      <div className="main">
        <Facets
          events={tsScopedEvents}
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
            showSource={showSource}
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

function collectTsBounds(ast: Ast): { lo: number; hi: number } {
  let lo = -Infinity;
  let hi = Infinity;
  const walk = (a: Ast) => {
    switch (a.kind) {
      case "key_cmp":
        if (a.key === "ts") {
          if (a.op === "gte") lo = Math.max(lo, a.value);
          if (a.op === "gt") lo = Math.max(lo, a.value + 1);
          if (a.op === "lte") hi = Math.min(hi, a.value);
          if (a.op === "lt") hi = Math.min(hi, a.value - 1);
        }
        break;
      case "and":
        walk(a.left);
        walk(a.right);
        break;
      case "or":
      case "not":
      default:
        break;
    }
  };
  walk(ast);
  return { lo, hi };
}

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
