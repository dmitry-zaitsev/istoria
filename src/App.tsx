import { sendNotification } from "@tauri-apps/plugin-notification";
import { useEffect, useMemo, useRef, useState } from "react";

import { AlertsModal } from "./components/AlertsModal";
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
import { compileAlerts, matchAlerts } from "./lib/alerts";
import {
  getMeta,
  listAlerts,
  listPins,
  listViews,
  queryRecent,
  subscribeEvents,
  type LogEvent,
} from "./lib/ipc";
import { evalAst, isError, parse, resolveAst, type Ast } from "./lib/query";
import { termsFromAst } from "./lib/highlight";
import { onSessionCleared } from "./lib/sessionBus";
import { onAlertsModalOpen } from "./lib/alertsBus";
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
  const selectedIds = useStore((s) => s.selectedIds);
  const setSelectedIds = useStore((s) => s.setSelectedIds);
  const setViews = useStore((s) => s.setViews);
  const setActiveViewId = useStore((s) => s.setActiveViewId);
  const sort = useStore((s) => s.sort);
  const setSort = useStore((s) => s.setSort);
  const setPinnedIds = useStore((s) => s.setPinnedIds);
  const alerts = useStore((s) => s.alerts);
  const setAlerts = useStore((s) => s.setAlerts);

  const [unfilteredCount, setUnfilteredCount] = useState(0);
  const [unfilteredEvents, setUnfilteredEvents] = useState<LogEvent[]>([]);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [alertsInitialQuery, setAlertsInitialQuery] = useState<string | null>(null);

  useEffect(
    () =>
      onAlertsModalOpen((q) => {
        setAlertsInitialQuery(q);
        setAlertsOpen(true);
      }),
    [],
  );

  // Wipe local state the moment the user clears the session, even if
  // we're paused or mid-throttle. Backend wipe runs in parallel.
  useEffect(
    () =>
      onSessionCleared(() => {
        setUnfilteredEvents([]);
        setUnfilteredCount(0);
        setPausedSrc(null);
        setPaused(false);
        setSelected(null);
        setPinnedIds(new Set());
      }),
    [],
  );
  // Snapshot of unfilteredEvents at pause time. While set, all
  // downstream derivations operate on this frozen slice instead of
  // the live array, so rows under the user's cursor never shift.
  const paused = useStore((s) => s.paused);
  const setPaused = useStore((s) => s.setPaused);
  const [pausedSrc, setPausedSrc] = useState<LogEvent[] | null>(null);
  useEffect(() => {
    if (paused) {
      setPausedSrc((prev) => prev ?? unfilteredEvents);
    } else {
      setPausedSrc(null);
    }
    // intentionally only react to `paused` — capturing on enter only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);
  const sourceEvents = pausedSrc ?? unfilteredEvents;
  const newCount = pausedSrc ? unfilteredEvents.length - pausedSrc.length : 0;

  const parsed = useMemo(() => parse(filter), [filter]);
  const filterValid = !isError(parsed);
  const highlightTerms = useMemo(
    () => (filterValid ? termsFromAst(parsed as Ast) : []),
    [parsed, filterValid],
  );

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

  // Bootstrap pins on mount.
  useEffect(() => {
    let cancelled = false;
    listPins()
      .then((ids) => {
        if (!cancelled) setPinnedIds(new Set(ids));
      })
      .catch((e) => console.warn("listPins failed", e));
    return () => {
      cancelled = true;
    };
  }, [setPinnedIds]);

  // Bootstrap alerts on mount.
  useEffect(() => {
    let cancelled = false;
    listAlerts()
      .then((all) => {
        if (!cancelled) setAlerts(all);
      })
      .catch((e) => console.warn("listAlerts failed", e));
    return () => {
      cancelled = true;
    };
  }, [setAlerts]);

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
        if (storedSort === "newest-bottom" || storedSort === "newest-top") {
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
    let pending: ReturnType<typeof setTimeout> | null = null;
    const refresh = async () => {
      try {
        const all = await queryRecent(QUERY_LIMIT);
        if (cancelled) return;
        const ordered = all.slice().reverse() as LogEvent[];
        setUnfilteredEvents(ordered);
        setUnfilteredCount(ordered.length);
      } catch (e) {
        console.warn("queryRecent failed", e);
      }
    };
    // Throttle: under heavy ingest we'd otherwise rebuild the
    // event array (and re-derive facets/histogram/sort) on every
    // backend tick. Coalesce notifications into ≤10 refreshes/s.
    const scheduleRefresh = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        void refresh();
      }, 100);
    };
    refresh();
    let unlisten: (() => void) | undefined;
    subscribeEvents(scheduleRefresh).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      if (pending) clearTimeout(pending);
      unlisten?.();
    };
  }, []);

  // Compile alert queries once per alerts change, then derive matches
  // for displayed (downstream) events. Map: event.id → alertId[].
  const compiledAlerts = useMemo(() => compileAlerts(alerts), [alerts]);
  const alertMatches = useMemo(
    () => matchAlerts(unfilteredEvents, compiledAlerts),
    [unfilteredEvents, compiledAlerts],
  );

  // Notification: track last fired time per alert id; on new matching
  // events for notify-enabled alerts, fire native notification only
  // if elapsed > debounce_ms.
  const lastFiredRef = useRef<Map<number, number>>(new Map());
  const lastSeenIdRef = useRef<number>(-1);
  useEffect(() => {
    const notifying = alerts.filter((a) => a.notify);
    if (notifying.length === 0) {
      lastSeenIdRef.current = unfilteredEvents.length > 0
        ? unfilteredEvents[unfilteredEvents.length - 1]!.id
        : -1;
      return;
    }
    const now = Date.now();
    const newEvents = unfilteredEvents.filter((e) => e.id > lastSeenIdRef.current);
    for (const ev of newEvents) {
      const ids = alertMatches.get(ev.id);
      if (!ids) continue;
      for (const id of ids) {
        const a = notifying.find((x) => x.id === id);
        if (!a) continue;
        const last = lastFiredRef.current.get(a.id) ?? 0;
        if (now - last < a.debounce_ms) continue;
        lastFiredRef.current.set(a.id, now);
        try {
          sendNotification({
            title: a.name,
            body: (ev.msg || ev.raw).slice(0, 120),
          });
        } catch (e) {
          console.warn("sendNotification failed", e);
        }
      }
    }
    if (unfilteredEvents.length > 0) {
      lastSeenIdRef.current = unfilteredEvents[unfilteredEvents.length - 1]!.id;
    }
  }, [unfilteredEvents, alertMatches, alerts]);

  // Derive displayed events from sourceEvents (snapshot when paused),
  // so the visible list freezes mid-scroll.
  const displayedEvents = useMemo(() => {
    if (!filterValid) return applySort(sourceEvents, sort);
    // Resolve aggregation functions (\`percentile(N)\`) against the
    // current event set before walking the AST per row.
    const resolved = resolveAst(parsed as Ast, sourceEvents);
    const filtered = sourceEvents.filter((ev) => evalAst(resolved, ev));
    return applySort(filtered, sort);
  }, [sourceEvents, parsed, filterValid, sort]);

  useEffect(() => {
    setEvents(displayedEvents);
  }, [displayedEvents, setEvents]);

  const setNewCount = useStore((s) => s.setNewCount);
  useEffect(() => {
    setNewCount(newCount);
  }, [newCount, setNewCount]);

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
            unfilteredEvents={unfilteredEvents}
          />
          <LogStream
            events={events}
            selectedId={selectedId}
            selectedIds={selectedIds}
            onSelect={setSelected}
            onSelectIds={setSelectedIds}
            bottomInset={bottomInset}
            showSource={showSource}
            highlightTerms={highlightTerms}
            alertMatches={alertMatches}
          />
          {selected && (
            <Inspector
              event={selected}
              events={unfilteredEvents}
              onSelect={setSelected}
              onClose={() => setSelected(null)}
              highlightTerms={highlightTerms}
            />
          )}
        </div>
      </div>
      <StatusBar
        total={unfilteredCount}
        filtered={events.length}
        filterActive={filterActive}
      />
      <AlertsModal
        open={alertsOpen}
        onClose={() => {
          setAlertsOpen(false);
          setAlertsInitialQuery(null);
        }}
        initialQuery={alertsInitialQuery ?? undefined}
      />
    </div>
  );
}

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
  return events.slice().sort((a, b) => b.ts - a.ts || b.id - a.id);
}
