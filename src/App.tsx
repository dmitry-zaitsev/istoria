import { isPermissionGranted, requestPermission, sendNotification } from "./lib/notify";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { log } from "./lib/logger";
import { Chrome } from "./components/Chrome";
import { ColumnHeader } from "./components/ColumnHeader";
import { FilterBar } from "./components/FilterBar";
import { Inspector } from "./components/Inspector";
import { LogStream } from "./components/LogStream";
import { StatusBar } from "./components/StatusBar";
import { StreamHeader } from "./components/StreamHeader";
import { Tabs } from "./components/Tabs";
import { Facets } from "./components/Facets";
import { FacetIndex, computeFacets, type FacetGroup } from "./lib/facets";
import { Histogram } from "./components/Histogram";
import { Toast } from "./components/Toast";
import { UpdateBanner } from "./components/UpdateBanner";
import {
  astHasAggregation,
  compileAlerts,
  compiledHasAggregation,
  loadAlerts,
  matchAlerts,
  matchAlertsDelta,
  MIN_DEBOUNCE_MS,
} from "./lib/alerts";
import {
  focusChanged,
  listPins,
  queryRecent,
  querySince,
  relevanceSnapshot,
  subscribeEvents,
  subscribeRelevance,
  type LogEvent,
} from "./lib/ipc";
import { evalAst, isError, parse, resolveAst, type Ast } from "./lib/query";
import { termsFromAst } from "./lib/highlight";
import { onSessionCleared } from "./lib/sessionBus";
import { toast } from "./lib/toast";
import { applyAllCached, COMPILED_BUILTINS } from "./lib/transformers";
import { loadActiveViewId, loadViews } from "./lib/views";
import { useStore, type ColKey, type SortKey } from "./store";

const QUERY_LIMIT = 100_000;

// Cap the live DOM the virtualizer paints. Total scroll height = count*26px;
// long sessions hit millions of px and triggered the WKWebView ghost (stale
// Core Animation tiles). Only the newest CAP rows stay live; older rows remain
// reachable via search (full set stays in memory) and via the FULL store
// `events` used by export/copy/histogram/counts.
const STREAM_RENDER_CAP = 500;

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
  const relevantIds = useStore((s) => s.relevantIds);
  const setRelevantIds = useStore((s) => s.setRelevantIds);
  const setRelevanceSites = useStore((s) => s.setRelevanceSites);

  // When inspector opens (selectedId transitions null → non-null), scroll
  // the row into view above the inspector overlay so it's not occluded.
  const prevSelectedRef = useRef<number | null>(null);
  useEffect(() => {
    if (selectedId != null && prevSelectedRef.current == null) {
      setScrollTarget(selectedId);
    }
    prevSelectedRef.current = selectedId;
  }, [selectedId, setScrollTarget]);

  // ----- live event ingestion (append-only) -----
  //
  // unfilteredEvents is the canonical backend payload with built-in
  // transformer rules applied. Grows append-only across ticks; full
  // replace only on cold start, ring eviction, or session clear.
  const [unfilteredEvents, setUnfilteredEvents] = useState<LogEvent[]>([]);
  const [unfilteredCount, setUnfilteredCount] = useState(0);
  // Maintained in lockstep with unfilteredEvents. Per-event work is
  // O(payload-depth) not O(n), so facet snapshots stay cheap.
  const facetIndexRef = useRef<FacetIndex>(new FacetIndex());
  const [facetVersion, setFacetVersion] = useState(0);
  // Per-id transform memo. Keeps applyAll cost O(delta) across ticks.
  const transformCacheRef = useRef<Map<number, LogEvent>>(new Map());
  // Cursor into the ring. Bumped to the last ingested event id; the
  // next refresh passes it to query_since.
  const lastSeenIdRef = useRef<number>(0);
  // Last delta batch. Drives the notification + delta-alert effects so
  // they don't have to scan the full array for "what's new".
  const [pendingDelta, setPendingDelta] = useState<LogEvent[]>([]);

  // Wipe local state the moment the user clears the session, even if
  // we're paused or mid-throttle. Backend wipe runs in parallel.
  useEffect(
    () =>
      onSessionCleared(() => {
        setUnfilteredEvents([]);
        setUnfilteredCount(0);
        facetIndexRef.current.clear();
        transformCacheRef.current.clear();
        alertMatchesRef.current = new Map();
        lastSeenIdRef.current = 0;
        setFacetVersion((v) => v + 1);
        setAlertMatchesVersion((v) => v + 1);
        setPendingDelta([]);
        setPausedAtId(null);
        setPaused(false);
        setSelected(null);
        setPinnedIds(new Set());
      }),
    []
  );

  // Pause snapshot: hold the id of the newest event at pause time.
  // Downstream derivations clip at that id, so the visible list
  // freezes mid-scroll without allocating a frozen slice each tick.
  const paused = useStore((s) => s.paused);
  const setPaused = useStore((s) => s.setPaused);
  const [pausedAtId, setPausedAtId] = useState<number | null>(null);
  useEffect(() => {
    if (paused) {
      setPausedAtId((prev) => {
        if (prev != null) return prev;
        return unfilteredEvents.length > 0
          ? unfilteredEvents[unfilteredEvents.length - 1]!.id
          : null;
      });
    } else {
      setPausedAtId(null);
    }
    // intentionally only react to `paused` — capturing on enter only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);

  // sourceEvents = unfilteredEvents clipped at pausedAtId. While
  // paused, returns a stable reference even as new events arrive, so
  // downstream useMemos don't fire.
  const sourceEventsRef = useRef<LogEvent[]>([]);
  const sourceEvents = useMemo(() => {
    if (pausedAtId == null) {
      sourceEventsRef.current = unfilteredEvents;
      return unfilteredEvents;
    }
    const cut = bisectRightById(unfilteredEvents, pausedAtId);
    const prev = sourceEventsRef.current;
    if (
      prev.length === cut &&
      prev.length > 0 &&
      prev[prev.length - 1]!.id === unfilteredEvents[cut - 1]!.id
    ) {
      return prev;
    }
    const clipped = unfilteredEvents.slice(0, cut);
    sourceEventsRef.current = clipped;
    return clipped;
  }, [unfilteredEvents, pausedAtId]);

  const parsed = useMemo(() => parse(filter), [filter]);
  const filterValid = !isError(parsed);
  const highlightTerms = useMemo(
    () => (filterValid ? termsFromAst(parsed as Ast) : []),
    [parsed, filterValid]
  );

  const hasRelevance = relevantIds.size > 0;

  // Facets only respect the ts: bounds (if any), not the full query —
  // so changing a level filter doesn't shrink the source list to one
  // value. If no ts bounds are set, all events are visible.
  const tsBounds = useMemo(() => {
    if (isError(parsed)) return { lo: -Infinity, hi: Infinity };
    return collectTsBounds(parsed);
  }, [parsed]);
  const tsBoundsUnbounded = !Number.isFinite(tsBounds.lo) && !Number.isFinite(tsBounds.hi);
  const tsScopedEvents = useMemo(() => {
    if (tsBoundsUnbounded) return unfilteredEvents;
    return unfilteredEvents.filter((e) => e.ts >= tsBounds.lo && e.ts <= tsBounds.hi);
  }, [unfilteredEvents, tsBounds.lo, tsBounds.hi, tsBoundsUnbounded]);

  // Single source of facet groups. When ts bounds are unset (common
  // case) we read from the maintained index — O(distinct values), not
  // O(events). When ts bounds are set, fall back to a cold recompute
  // over the filtered subset.
  const facetGroups: FacetGroup[] = useMemo(() => {
    if (tsBoundsUnbounded) return facetIndexRef.current.snapshot();
    return computeFacets(tsScopedEvents);
    // facetVersion bumps on each ingest tick so the index path
    // refreshes; the cold path depends on tsScopedEvents only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tsScopedEvents, tsBoundsUnbounded, facetVersion]);

  const suggestKeys = useMemo(() => {
    const base = ["msg", "raw", "ts", "pinned", "stack", "hasStackTrace"];
    if (hasRelevance) base.push("relevant");
    return [...base, ...facetGroups.map((g) => g.key)];
  }, [facetGroups, hasRelevance]);
  const suggestValuesByKey = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const g of facetGroups) {
      m.set(
        g.key,
        g.values.slice(0, 50).map((v) => v.value)
      );
    }
    m.set("pinned", ["true", "false"]);
    m.set("stack", ["true", "false"]);
    m.set("hasStackTrace", ["true", "false"]);
    if (hasRelevance) m.set("relevant", ["true", "false"]);
    return m;
  }, [facetGroups, hasRelevance]);
  const availableFieldKeys = useMemo(
    () =>
      facetGroups
        .map((g) => g.key)
        .filter((k) => k !== "level" && k !== "source" && k !== "branch"),
    [facetGroups]
  );

  // Cross-cutting substring autocomplete. Memoized on facetVersion so
  // the closure sees the freshest FacetIndex state on every keystroke
  // after ingest, while staying stable between ticks to avoid churn in
  // FilterBar's useMemo.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const suggestFn = useCallback(
    (q: string) => facetIndexRef.current.suggest(q, 10),
    [facetVersion]
  );

  // Sources/branches derive from the facet groups — same single pass.
  const sources = useMemo(() => {
    const g = facetGroups.find((x) => x.key === "source");
    return g ? g.values.map((v) => v.value).toSorted() : [];
  }, [facetGroups]);
  const branches = useMemo(() => {
    const g = facetGroups.find((x) => x.key === "branch");
    return g ? g.values.map((v) => v.value).toSorted() : [];
  }, [facetGroups]);

  const columnVisibility = useStore((s) => s.columnVisibility);
  const fieldColumns = useStore((s) => s.fieldColumns);
  const effectiveVisibility: Record<ColKey, boolean> = {
    ts: columnVisibility.ts ?? true,
    lvl: columnVisibility.lvl ?? true,
    src: columnVisibility.src ?? sources.length > 1,
    br: columnVisibility.br ?? branches.length > 1,
  };

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
      .catch((e) => log.warn("listPins failed", e));
    return () => {
      cancelled = true;
    };
  }, [setPinnedIds]);

  // Bootstrap alerts on mount. Synchronous localStorage read — no
  // backend round trip; alerts are tiny configuration, not log data.
  useEffect(() => {
    setAlerts(loadAlerts());
  }, [setAlerts]);

  // Bootstrap views + active id from localStorage. Synchronous —
  // no backend round trip, so it can't be wedged by a broken store.
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

  // ----- ingest loop -----
  //
  // Cold start does one queryRecent + reverses to oldest-first; after
  // that we subscribe to `event-new` and pull deltas via query_since.
  // Eviction (ring floor passed our cursor) drops back to the cold
  // path. Throttled to ~10 refreshes/sec so bursts coalesce.
  useEffect(() => {
    let cancelled = false;
    let pending: ReturnType<typeof setTimeout> | null = null;

    const ingestBatch = (incoming: LogEvent[], replace: boolean) => {
      if (cancelled) return;
      if (replace) {
        transformCacheRef.current.clear();
        facetIndexRef.current.clear();
      }
      const transformed = applyAllCached(incoming, COMPILED_BUILTINS, transformCacheRef.current);
      for (const ev of transformed) facetIndexRef.current.add(ev);
      if (replace) {
        setUnfilteredEvents(transformed);
      } else {
        setUnfilteredEvents((prev) => prev.concat(transformed));
      }
      if (transformed.length > 0) {
        // Advance the delta cursor to the batch's MAX id, never backwards.
        // With the backend's atomic append the batch is already id-ascending
        // (so this equals the last element), but taking the max keeps the
        // client robust to any ordering slip — a lower last-element id would
        // otherwise make querySince re-fetch a suffix and duplicate rows.
        // A loop (not spread) avoids a huge argument list on bootstrap batches.
        let maxId = lastSeenIdRef.current;
        for (const ev of transformed) {
          if (ev.id > maxId) maxId = ev.id;
        }
        lastSeenIdRef.current = maxId;
      }
      setFacetVersion((v) => v + 1);
      setPendingDelta(transformed);
    };

    const bootstrap = async () => {
      try {
        const all = await queryRecent(QUERY_LIMIT);
        if (cancelled) return;
        const ordered = all.toReversed() as LogEvent[];
        ingestBatch(ordered, true);
        setUnfilteredCount(ordered.length);
      } catch (e) {
        log.warn("queryRecent failed", e);
      }
    };

    const refresh = async () => {
      try {
        const since = lastSeenIdRef.current;
        const payload = await querySince(since, QUERY_LIMIT);
        if (cancelled) return;
        // Ring evicted past our cursor → fall back to a fresh snapshot.
        // `since === 0` is the bootstrap path; minId > 1 there is
        // expected (ring already had content before we started).
        if (since > 0 && payload.minId != null && payload.minId > since + 1) {
          const all = await queryRecent(QUERY_LIMIT);
          if (cancelled) return;
          ingestBatch(all.toReversed() as LogEvent[], true);
          setUnfilteredCount(payload.len);
          return;
        }
        setUnfilteredCount(payload.len);
        if (payload.events.length === 0) return;
        ingestBatch(payload.events, false);
      } catch (e) {
        log.warn("querySince failed", e);
      }
    };

    const scheduleRefresh = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        void refresh();
      }, 100);
    };

    void bootstrap();
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

  // Branch relevance: pull a fresh snapshot on mount and whenever the
  // backend emits relevance-updated. Window focus pokes the backend so
  // a freshly-saved file picks up before the next 15s tick.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      relevanceSnapshot()
        .then((snap) => {
          if (cancelled) return;
          setRelevantIds(new Set(snap.ids));
          setRelevanceSites(snap.sites);
        })
        .catch(() => {
          // backend may be starting up; next emit will retry
        });
    };
    refresh();
    let unlistenRelevance: (() => void) | undefined;
    subscribeRelevance(refresh)
      .then((u) => {
        if (cancelled) u();
        else unlistenRelevance = u;
      })
      .catch(() => {
        // not running under Tauri (e.g. vite preview) — skip
      });

    const onWinFocus = () => focusChanged(true).catch(() => {});
    const onWinBlur = () => focusChanged(false).catch(() => {});
    window.addEventListener("focus", onWinFocus);
    window.addEventListener("blur", onWinBlur);

    return () => {
      cancelled = true;
      unlistenRelevance?.();
      window.removeEventListener("focus", onWinFocus);
      window.removeEventListener("blur", onWinBlur);
    };
  }, [setRelevantIds, setRelevanceSites]);

  // ----- alert matching (incremental) -----
  //
  // Compiled alerts change rarely (user edits the alert list). When
  // they do, rebuild the match map from scratch. On each delta, merge
  // the delta-only matches into the existing map. Aggregation alerts
  // need full recompute because their threshold shifts with each new
  // event.
  const compiledAlerts = useMemo(() => compileAlerts(alerts), [alerts]);
  const alertMatchesRef = useRef<Map<number, string[]>>(new Map());
  const [alertMatchesVersion, setAlertMatchesVersion] = useState(0);

  // Full recompute when the alert set changes.
  useEffect(() => {
    alertMatchesRef.current = matchAlerts(unfilteredEvents, compiledAlerts);
    setAlertMatchesVersion((v) => v + 1);
    // We deliberately only re-run on compiledAlerts change here. The
    // delta-merge effect below handles new events.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compiledAlerts]);

  // Delta merge on each ingest batch.
  useEffect(() => {
    if (pendingDelta.length === 0) return;
    if (compiledHasAggregation(compiledAlerts)) {
      alertMatchesRef.current = matchAlerts(unfilteredEvents, compiledAlerts);
    } else {
      matchAlertsDelta(pendingDelta, compiledAlerts, alertMatchesRef.current);
    }
    setAlertMatchesVersion((v) => v + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDelta]);

  // Exposed to children via the version dep; ref stays stable but
  // children get a fresh useMemo result whenever the map changes.
  const alertMatches = useMemo(() => alertMatchesRef.current, [alertMatchesVersion]);

  // ----- notifications -----
  //
  // Drives off pendingDelta directly — no per-tick O(n) scan against
  // unfilteredEvents to find "new" events.
  const lastFiredRef = useRef<Map<string, number>>(new Map());
  const suppressedRef = useRef<Map<string, number>>(new Map());
  const notifyPermitRef = useRef<boolean | null>(null);
  const notifyPermitInflightRef = useRef<Promise<boolean> | null>(null);
  // Global floor: regardless of per-alert debounce_ms, never fire
  // more than one notification across all alerts inside a 5s window.
  const globalLastFireRef = useRef<number>(0);
  useEffect(() => {
    if (pendingDelta.length === 0) return;
    const notifying = alerts.filter((a) => a.notify);
    if (notifying.length === 0) return;
    const now = Date.now();
    void (async () => {
      const focused = document.hasFocus();
      for (const ev of pendingDelta) {
        const ids = alertMatchesRef.current.get(ev.id);
        if (!ids) continue;
        for (const id of ids) {
          const a = notifying.find((x) => x.id === id);
          if (!a) continue;
          const last = lastFiredRef.current.get(a.id) ?? 0;
          const perAlertGap = Math.max(a.debounce_ms || 0, MIN_DEBOUNCE_MS);
          const inPerAlertCooldown = now - last < perAlertGap;
          const inGlobalCooldown = now - globalLastFireRef.current < MIN_DEBOUNCE_MS;
          if (inPerAlertCooldown || inGlobalCooldown) {
            // Still in cooldown — accumulate so the next fire can
            // tell the user "+N more matched while you were away".
            suppressedRef.current.set(a.id, (suppressedRef.current.get(a.id) ?? 0) + 1);
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
                  log.warn("notification permission probe failed", e);
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
            log.warn("sendNotification failed", e);
            toast(`${a.name}: ${head}`);
          }
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDelta, alerts]);

  // ----- displayed events (incremental) -----
  //
  // displayedEvents is what LogStream actually renders. Kept oldest-
  // first internally; sort=`newest-top` reverses at the view layer.
  // Re-evaluated incrementally on each delta when filter inputs are
  // unchanged and the filter has no aggregation; otherwise rebuilt.
  const [displayedEvents, setDisplayedEvents] = useState<LogEvent[]>([]);
  const prevSourceRef = useRef<LogEvent[]>([]);
  const prevFilterInputsRef = useRef<{
    parsed: ReturnType<typeof parse>;
    filterValid: boolean;
    pinnedIds: Set<number>;
    relevantIds: Set<number>;
  } | null>(null);
  const filterUsesAggregation = filterValid && astHasAggregation(parsed as Ast);

  useEffect(() => {
    const prevSrc = prevSourceRef.current;
    prevSourceRef.current = sourceEvents;

    // Track filter inputs separately. The delta optimization below is
    // only valid when none of them changed — if the filter or one of
    // its set-membership inputs (pinned, relevant) moved, the
    // previously-displayed rows were filtered against a stale
    // predicate and have to be rebuilt from source.
    const prevFilter = prevFilterInputsRef.current;
    const filterInputsChanged =
      prevFilter == null ||
      prevFilter.parsed !== parsed ||
      prevFilter.filterValid !== filterValid ||
      prevFilter.pinnedIds !== pinnedIds ||
      prevFilter.relevantIds !== relevantIds;
    prevFilterInputsRef.current = { parsed, filterValid, pinnedIds, relevantIds };

    // Detect "this is just an extension of the previous source array".
    // Same first id + same length-1 entry means we appended. We compare
    // by event identity (refs are stable after applyAllCached), so a
    // single equality check is enough.
    const isExtension =
      !filterInputsChanged &&
      prevSrc.length > 0 &&
      sourceEvents.length > prevSrc.length &&
      sourceEvents[0] === prevSrc[0] &&
      sourceEvents[prevSrc.length - 1] === prevSrc[prevSrc.length - 1];

    // Full rebuild when filter inputs changed OR aggregation is used
    // OR source identity broke (replace path).
    if (!isExtension || filterUsesAggregation) {
      setDisplayedEvents(
        rebuildDisplayed(sourceEvents, parsed, filterValid, pinnedIds, relevantIds)
      );
      return;
    }

    const delta = sourceEvents.slice(prevSrc.length);
    if (!filterValid) {
      setDisplayedEvents((prev) => prev.concat(delta));
      return;
    }
    const ctx = { pinnedIds, relevantIds };
    const filteredDelta = delta.filter((ev) => evalAst(parsed as Ast, ev, ctx));
    if (filteredDelta.length === 0) return;
    setDisplayedEvents((prev) => prev.concat(filteredDelta));
  }, [sourceEvents, parsed, filterValid, pinnedIds, relevantIds, filterUsesAggregation]);

  // Sort view. Internal storage is oldest-first; expose a reversed
  // copy for `newest-top`. Only materializes when the source or sort
  // actually changes.
  const renderedEvents = useMemo(() => {
    if (sort === "newest-bottom") return displayedEvents;
    return displayedEvents.toReversed();
  }, [displayedEvents, sort]);

  // Mirror into the Zustand store so downstream components (StreamHeader)
  // can read filtered events without prop-drilling.
  useEffect(() => {
    setEvents(renderedEvents);
  }, [renderedEvents, setEvents]);

  // Newest-N window actually painted by LogStream. The store `events` above
  // stays FULL (histogram, counts, export, copy read it); only the live DOM
  // is bounded so the virtualizer's scroll layer can't grow into the
  // millions-of-px range that froze WKWebView tiles into "ghost" glyphs.
  // renderedEvents is already sort-oriented (newest-bottom: newest last;
  // newest-top: newest first), so slice the matching end. The <= short-circuit
  // keeps the same reference under the cap, preserving virtualizer identity.
  const streamEvents = useMemo(() => {
    if (renderedEvents.length <= STREAM_RENDER_CAP) return renderedEvents;
    return sort === "newest-bottom"
      ? renderedEvents.slice(-STREAM_RENDER_CAP) // newest at end → keep tail
      : renderedEvents.slice(0, STREAM_RENDER_CAP); // newest at start → keep head
  }, [renderedEvents, sort]);

  // Filter-aware new-events counter for the pause pill. Counts events
  // that landed *after* pausedAtId and would actually appear if the
  // user resumed. Cheap when paused (only walks events past the
  // cutoff).
  const newCount = useMemo(() => {
    if (pausedAtId == null) return 0;
    const cutIdx = bisectRightById(unfilteredEvents, pausedAtId);
    if (cutIdx >= unfilteredEvents.length) return 0;
    if (!filterValid) return unfilteredEvents.length - cutIdx;
    const resolved = resolveAst(parsed as Ast, unfilteredEvents);
    const ctx = { pinnedIds, relevantIds };
    let n = 0;
    for (let i = cutIdx; i < unfilteredEvents.length; i++) {
      if (evalAst(resolved, unfilteredEvents[i]!, ctx)) n++;
    }
    return n;
  }, [pausedAtId, unfilteredEvents, filterValid, parsed, pinnedIds, relevantIds]);

  const setNewCount = useStore((s) => s.setNewCount);
  useEffect(() => {
    setNewCount(newCount);
  }, [newCount, setNewCount]);

  const selected = useMemo(
    () => (selectedId == null ? null : events.find((e) => e.id === selectedId)),
    [events, selectedId]
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
      <UpdateBanner />
      <Chrome />
      <Tabs />
      <FilterBar
        value={filter}
        onChange={setFilter}
        suggestKeys={suggestKeys}
        suggestValuesByKey={suggestValuesByKey}
        suggest={suggestFn}
      />
      <Histogram events={events} filter={filter} onFilterChange={setFilter} />
      <div className="main">
        <Facets
          events={tsScopedEvents}
          groups={facetGroups}
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
            events={streamEvents}
            selectedId={selectedId}
            selectedIds={selectedIds}
            onSelect={setSelected}
            onSelectIds={setSelectedIds}
            bottomInset={bottomInset}
            visibility={effectiveVisibility}
            fieldColumns={fieldColumns}
            highlightTerms={highlightTerms}
            alertMatches={alertMatches}
            relevantIds={relevantIds}
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
      <StatusBar total={unfilteredCount} filtered={events.length} filterActive={filterActive} />
    </div>
  );
}

function rebuildDisplayed(
  src: LogEvent[],
  parsed: ReturnType<typeof parse>,
  filterValid: boolean,
  pinnedIds: Set<number>,
  relevantIds: Set<number>
): LogEvent[] {
  if (!filterValid) return src.slice();
  const resolved = resolveAst(parsed as Ast, src);
  const ctx = { pinnedIds, relevantIds };
  return src.filter((ev) => evalAst(resolved, ev, ctx));
}

/// Binary search for the first index where `events[i].id > target`.
/// Events are assumed monotonically non-decreasing in id.
function bisectRightById(events: LogEvent[], target: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid]!.id <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
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

// SortKey type is imported but not used here directly; kept for the
// signature compatibility with the store. Sort is applied at render.
export type { SortKey };
