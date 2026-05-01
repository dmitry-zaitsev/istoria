import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useRef, useState } from "react";

import { Chrome } from "./components/Chrome";
import { ColumnHeader } from "./components/ColumnHeader";
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
  branchState,
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
import { useStore, type ColKey, type SortKey } from "./store";

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
  const relevance = useStore((s) => s.relevance);
  const setRelevanceStale = useStore((s) => s.setRelevanceStale);

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

  const parsed = useMemo(() => parse(filter), [filter]);
  const filterValid = !isError(parsed);
  const highlightTerms = useMemo(
    () => (filterValid ? termsFromAst(parsed as Ast) : []),
    [parsed, filterValid],
  );

  // Compile the relevance regex list into a single OR-joined RegExp so
  // each row only pays one .test() call. Patterns are wrapped in `(?:..)`
  // to keep alternation safe even when individual patterns contain
  // top-level alternatives. Strip `/.../flags` wrappers if Claude
  // returned them despite the prompt. Invalid patterns are dropped
  // with a console warning so the cause is visible in devtools.
  const relevanceRe = useMemo(() => {
    if (!relevance || relevance.regexes.length === 0) return null;
    const safe: string[] = [];
    for (const raw of relevance.regexes) {
      const normalized = stripRegexWrapper(raw);
      try {
        new RegExp(normalized);
        safe.push(`(?:${normalized})`);
      } catch (e) {
        console.warn("relevance: dropped invalid regex", raw, e);
      }
    }
    if (safe.length === 0) {
      console.warn(
        "relevance: all patterns were invalid; nothing will match",
        relevance.regexes,
      );
      return null;
    }
    try {
      return new RegExp(safe.join("|"), "i");
    } catch (e) {
      console.warn("relevance: failed to compile combined regex", safe, e);
      return null;
    }
  }, [relevance]);

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
    const base = [
      "msg",
      "raw",
      "ts",
      "pinned",
      "stack",
      "hasStackTrace",
    ];
    if (relevance) base.push("relevant");
    return [...base, ...groups.map((g) => g.key)];
  }, [tsScopedEvents, relevance]);
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
    if (relevance) m.set("relevant", ["true", "false"]);
    return m;
  }, [tsScopedEvents, relevance]);

  const sources = useMemo(() => {
    const seen = new Set<string>();
    for (const e of unfilteredEvents) seen.add(e.source);
    return [...seen].sort();
  }, [unfilteredEvents]);
  const branches = useMemo(() => {
    const seen = new Set<string>();
    for (const e of unfilteredEvents) {
      if (e.branch) seen.add(e.branch);
    }
    return [...seen].sort();
  }, [unfilteredEvents]);
  const columnVisibility = useStore((s) => s.columnVisibility);
  const fieldColumns = useStore((s) => s.fieldColumns);
  const effectiveVisibility: Record<ColKey, boolean> = {
    ts: columnVisibility.ts ?? true,
    lvl: columnVisibility.lvl ?? true,
    src: columnVisibility.src ?? (sources.length > 1),
    br: columnVisibility.br ?? (branches.length > 1),
  };
  const availableFieldKeys = useMemo(() => {
    const groups = computeFacets(tsScopedEvents);
    return groups
      .map((g) => g.key)
      .filter((k) => k !== "level" && k !== "source" && k !== "branch");
  }, [tsScopedEvents]);
  const setSources = useStore((s) => s.setSources);
  useEffect(() => {
    setSources(sources);
  }, [sources, setSources]);
  const setBranches = useStore((s) => s.setBranches);
  useEffect(() => {
    setBranches(branches);
  }, [branches, setBranches]);

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

  // Whenever the window regains focus, re-probe the project's git
  // state. If HEAD or the working-tree dirty flag differs from what
  // we analyzed against, mark the relevance result as stale so the
  // Claude button can prompt for a re-run. Skipped silently when no
  // analysis is stored (nothing to compare against) or when git is
  // unavailable for the project root.
  useEffect(() => {
    if (!relevance) return;
    let cancelled = false;
    // Only toast on the first focus that observes a change — repeated
    // focus events while the user is reading shouldn't keep nagging.
    let toastedForThisAnalysis = useStore.getState().relevanceStale;
    const check = () => {
      branchState()
        .then((bs) => {
          if (cancelled || !relevance) return;
          const stored = relevance.branch_state;
          const changed =
            bs.head_sha !== stored.head_sha ||
            bs.has_uncommitted !== stored.has_uncommitted ||
            bs.branch !== stored.branch;
          if (changed) {
            setRelevanceStale(true);
            if (!toastedForThisAnalysis) {
              toastedForThisAnalysis = true;
              toast("Branch changed — re-run Claude analysis to refresh");
            }
          }
        })
        .catch(() => {
          // git unavailable / not a repo — leave stale flag alone
        });
    };
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) check();
      })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {
        // not running under Tauri (e.g. vite preview) — skip
      });
    // Also probe once on mount in case the user opened istoria from
    // a different branch than the one stored in localStorage.
    check();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [relevance, setRelevanceStale]);

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
    const ctx = { pinnedIds, relevanceRe };
    const filtered = sourceEvents.filter((ev) => evalAst(resolved, ev, ctx));
    return applySort(filtered, sort);
  }, [sourceEvents, parsed, filterValid, sort, pinnedIds, relevanceRe]);

  useEffect(() => {
    setEvents(displayedEvents);
  }, [displayedEvents, setEvents]);

  // Filter-aware: only count new events that would actually appear in
  // the displayed list once the user resumes. Otherwise the pill lies
  // about new matches when the active filter excludes the new arrivals.
  const newCount = useMemo(() => {
    if (!pausedSrc) return 0;
    const cutoff =
      pausedSrc.length > 0 ? pausedSrc[pausedSrc.length - 1]!.id : -Infinity;
    if (!filterValid) {
      let n = 0;
      for (const ev of unfilteredEvents) if (ev.id > cutoff) n++;
      return n;
    }
    const resolved = resolveAst(parsed as Ast, unfilteredEvents);
    const ctx = { pinnedIds, relevanceRe };
    let n = 0;
    for (const ev of unfilteredEvents) {
      if (ev.id > cutoff && evalAst(resolved, ev, ctx)) n++;
    }
    return n;
  }, [pausedSrc, unfilteredEvents, filterValid, parsed, pinnedIds, relevanceRe]);

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
  const columnWidths = useStore((s) => s.columnWidths);
  const gridParts: string[] = [];
  if (effectiveVisibility.ts) gridParts.push(`${columnWidths.ts}px`);
  if (effectiveVisibility.lvl) gridParts.push(`${columnWidths.lvl}px`);
  if (effectiveVisibility.src) gridParts.push(`${columnWidths.src}px`);
  if (effectiveVisibility.br) gridParts.push(`${columnWidths.br}px`);
  for (const fc of fieldColumns) gridParts.push(`${fc.width}px`);
  gridParts.push("1fr", "auto");
  const colVars = {
    "--stream-cols": gridParts.join(" "),
  } as React.CSSProperties;

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
        <div className="stream-col" style={colVars}>
          <StreamHeader
            total={unfilteredCount}
            filtered={events.length}
            filterActive={filterActive}
            unfilteredEvents={unfilteredEvents}
          />
          <ColumnHeader
            visibility={effectiveVisibility}
            fieldColumns={fieldColumns}
            availableFieldKeys={availableFieldKeys}
          />
          <LogStream
            events={events}
            selectedId={selectedId}
            selectedIds={selectedIds}
            onSelect={setSelected}
            onSelectIds={setSelectedIds}
            bottomInset={bottomInset}
            visibility={effectiveVisibility}
            fieldColumns={fieldColumns}
            highlightTerms={highlightTerms}
            alertMatches={alertMatches}
            relevanceRe={relevanceRe}
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

/// Claude is asked NOT to wrap regexes in `/.../flags`, but sometimes
/// does anyway. Strip the surrounding slashes (and any trailing flag
/// letters) so `new RegExp(p)` doesn't choke. Leaves a non-wrapped
/// pattern untouched.
function stripRegexWrapper(p: string): string {
  const m = p.match(/^\/(.+)\/([gimsuy]*)$/s);
  return m ? m[1]! : p;
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
