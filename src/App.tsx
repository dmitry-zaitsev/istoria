import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useRef, useState } from "react";

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
import { Toast } from "./components/Toast";
import {
  compileAlerts,
  loadAlerts,
  matchAlerts,
  MIN_DEBOUNCE_MS,
} from "./lib/alerts";
import {
  listPins,
  queryRecent,
  subscribeEvents,
  type LogEvent,
} from "./lib/ipc";
import { evalAst, isError, parse, resolveAst, type Ast } from "./lib/query";
import { termsFromAst } from "./lib/highlight";
import { onSessionCleared } from "./lib/sessionBus";
import { toast } from "./lib/toast";
import { applyAll, COMPILED_BUILTINS } from "./lib/transformers";
import { loadActiveViewId, loadViews } from "./lib/views";
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
  const setPinnedIds = useStore((s) => s.setPinnedIds);
  const pinnedIds = useStore((s) => s.pinnedIds);
  const setScrollTarget = useStore((s) => s.setScrollTarget);
  const alerts = useStore((s) => s.alerts);
  const setAlerts = useStore((s) => s.setAlerts);

  // When inspector opens (selectedId transitions null → non-null), scroll
  // the row into view above the inspector overlay so it's not occluded.
  const prevSelectedRef = useRef<number | null>(null);
  useEffect(() => {
    if (selectedId != null && prevSelectedRef.current == null) {
      setScrollTarget(selectedId);
    }
    prevSelectedRef.current = selectedId;
  }, [selectedId, setScrollTarget]);

  const [unfilteredCount, setUnfilteredCount] = useState(0);
  const [canonicalEvents, setCanonicalEvents] = useState<LogEvent[]>([]);
  // Derived: canonical events with built-in transformer rules applied.
  // Downstream (filter, alerts, facets, inspector) sees the transformed
  // shape; the original `raw` is preserved on every row for the raw tab.
  const unfilteredEvents = useMemo(
    () => applyAll(canonicalEvents, COMPILED_BUILTINS),
    [canonicalEvents],
  );

  // Wipe local state the moment the user clears the session, even if
  // we're paused or mid-throttle. Backend wipe runs in parallel.
  useEffect(
    () =>
      onSessionCleared(() => {
        setCanonicalEvents([]);
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
    return [
      "msg",
      "raw",
      "ts",
      "pinned",
      "stack",
      "hasStackTrace",
      ...groups.map((g) => g.key),
    ];
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
    m.set("pinned", ["true", "false"]);
    m.set("stack", ["true", "false"]);
    m.set("hasStackTrace", ["true", "false"]);
    return m;
  }, [tsScopedEvents]);

  const sources = useMemo(() => {
    const seen = new Set<string>();
    for (const e of unfilteredEvents) seen.add(e.source);
    return [...seen].sort();
  }, [unfilteredEvents]);
  const showSource = sources.length > 1;
  const setSources = useStore((s) => s.setSources);
  useEffect(() => {
    setSources(sources);
  }, [sources, setSources]);

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

  // Bootstrap alerts on mount. Synchronous localStorage read — no
  // DuckDB round trip; alerts are tiny configuration, not log data.
  useEffect(() => {
    setAlerts(loadAlerts());
  }, [setAlerts]);

  // Bootstrap views + active id from localStorage. Synchronous —
  // no DuckDB round trip, so it can't be wedged by a broken store.
  useEffect(() => {
    const all = loadViews();
    setViews(all);
    if (all.length > 0) {
      const storedId = loadActiveViewId();
      const active = all.find((v) => v.id === storedId) ?? all[0]!;
      setActiveViewId(active.id);
      setFilter(active.query);
    }
  }, [setViews, setActiveViewId, setFilter]);

  useEffect(() => {
    let cancelled = false;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const refresh = async () => {
      try {
        const all = await queryRecent(QUERY_LIMIT);
        if (cancelled) return;
        const ordered = all.slice().reverse() as LogEvent[];
        setCanonicalEvents(ordered);
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

  // Notification: per-alert debounce + suppressed-match counter so a
  // flood doesn't spam the user. lastFiredRef gates the cooldown;
  // suppressedRef counts matches that landed during it. On the next
  // fire we surface the count as "+N more" in the body, then reset.
  // Skipped entirely when the istoria window is currently focused.
  const lastFiredRef = useRef<Map<string, number>>(new Map());
  const suppressedRef = useRef<Map<string, number>>(new Map());
  const lastSeenIdRef = useRef<number>(-1);
  const notifyPermitRef = useRef<boolean | null>(null);
  const notifyPermitInflightRef = useRef<Promise<boolean> | null>(null);
  // Global floor: regardless of per-alert debounce_ms, never fire
  // more than one notification across all alerts inside a 5s window.
  const globalLastFireRef = useRef<number>(0);
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
    void (async () => {
      let focused = false;
      try {
        focused = await getCurrentWindow().isFocused();
      } catch {
        // running outside Tauri (e.g. vite preview) — assume not focused
      }
      for (const ev of newEvents) {
        const ids = alertMatches.get(ev.id);
        if (!ids) continue;
        for (const id of ids) {
          const a = notifying.find((x) => x.id === id);
          if (!a) continue;
          const last = lastFiredRef.current.get(a.id) ?? 0;
          const perAlertGap = Math.max(a.debounce_ms || 0, MIN_DEBOUNCE_MS);
          const inPerAlertCooldown = now - last < perAlertGap;
          const inGlobalCooldown =
            now - globalLastFireRef.current < MIN_DEBOUNCE_MS;
          if (inPerAlertCooldown || inGlobalCooldown) {
            // Still in cooldown — accumulate so the next fire can
            // tell the user "+N more matched while you were away".
            suppressedRef.current.set(
              a.id,
              (suppressedRef.current.get(a.id) ?? 0) + 1,
            );
            continue;
          }
          lastFiredRef.current.set(a.id, now);
          globalLastFireRef.current = now;
          const suppressed = suppressedRef.current.get(a.id) ?? 0;
          suppressedRef.current.set(a.id, 0);
          const head = (ev.msg || ev.raw).slice(0, 120);
          const body = suppressed > 0 ? `${head}\n+${suppressed} more` : head;
          if (focused) {
            // Window already showing — surface match in-app instead
            // of pinging the user's notification center.
            toast(`${a.name}: ${head}`);
            continue;
          }
          // Lazy permission probe: cached after the very first match
          // that wants to fire. Avoids prompting at launch when no
          // alert has actually triggered yet.
          let permit = notifyPermitRef.current;
          if (permit == null) {
            if (!notifyPermitInflightRef.current) {
              notifyPermitInflightRef.current = (async () => {
                try {
                  let g = await isPermissionGranted();
                  if (!g) {
                    const r = await requestPermission();
                    g = r === "granted";
                  }
                  notifyPermitRef.current = g;
                  return g;
                } catch (e) {
                  console.warn("notification permission probe failed", e);
                  notifyPermitRef.current = false;
                  return false;
                } finally {
                  notifyPermitInflightRef.current = null;
                }
              })();
            }
            permit = await notifyPermitInflightRef.current;
          }
          if (!permit) {
            toast(`${a.name}: ${head}`);
            continue;
          }
          try {
            sendNotification({ title: a.name, body });
          } catch (e) {
            console.warn("sendNotification failed", e);
            toast(`${a.name}: ${head}`);
          }
        }
      }
    })();
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
    const ctx = { pinnedIds };
    const filtered = sourceEvents.filter((ev) => evalAst(resolved, ev, ctx));
    return applySort(filtered, sort);
  }, [sourceEvents, parsed, filterValid, sort, pinnedIds]);

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
