// Ghost-kill spike renderer.
//
// Mounts the REAL, unmodified `LogStream` component with the REAL app CSS and
// the REAL Zustand store, driven by a synthetic high-volume log feed. Nothing
// here is production code — it exists only to answer one question on the user's
// hardware: does the virtualized log stream still ghost in Chromium (Electron)
// the way it does in WKWebView (Tauri)? Same component + same CSS = same layer
// tree; the only variable under test is the renderer/compositor.
//
// Repro after it's running: stream for a bit, then sleep the display, unplug /
// replug a monitor, or drag the window between a Retina and non-Retina screen.
// In WKWebView this leaves doubled / stale "ghost" glyphs. Expectation here:
// none, because Chromium's compositor doesn't have the WKWebView CA-tile bug.

import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { LogStream } from "../../src/components/LogStream";
import type { Level, LogEvent } from "../../src/lib/ipc";
import { useStore } from "../../src/store";

// Real app styles (global.css @imports tokens.css) so row markup, backgrounds,
// containment, and fonts match production exactly — the compositing-relevant bits.
import "../../src/styles/global.css";
import "./spike.css";

// Mirror App.tsx: live DOM window the virtualizer paints (STREAM_RENDER_CAP).
const RENDER_CAP = 500;
// Keep the full store bounded so a long session doesn't grow unbounded, but
// well above the cap so the "showing newest N of M" path and window-slicing
// behave exactly like production.
const STORE_CAP = 5000;
// Default column layout (all columns visible, no field columns): ts lvl src br msg pin.
const STREAM_COLS = "92px 64px 80px 100px 1fr auto";

const LEVELS: Level[] = ["info", "info", "info", "info", "debug", "warn", "error", "trace"];
const SOURCES = ["api", "web", "worker", "db", "auth", "cache"];
const BRANCHES = ["main", "feat/casablanca", "fix/logstream"];
const WORDS =
  "request completed handler dispatched retry timeout connection pool flushed cache miss token refreshed payload parsed queue drained socket closed reconnecting latency spike gc pause snapshot committed rows scanned index rebuilt".split(
    " "
  );

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length]!;
}

function makeEvent(id: number): LogEvent {
  const level = pick(LEVELS, id * 7 + (id % 5));
  const nWords = 6 + (id % 10);
  const parts: string[] = [];
  for (let w = 0; w < nWords; w++) parts.push(pick(WORDS, id * 3 + w));
  const msg = `#${id} ${parts.join(" ")}`;
  return {
    id,
    ts: Date.now(),
    source: pick(SOURCES, id),
    branch: pick(BRANCHES, id >> 3),
    level,
    msg,
    raw: msg,
    fields: { seq: id, level },
  };
}

function Harness() {
  const events = useStore((s) => s.events);
  const sort = useStore((s) => s.sort);
  const setEvents = useStore((s) => s.setEvents);
  const setSort = useStore((s) => s.setSort);

  const allRef = useRef<LogEvent[]>([]);
  const nextIdRef = useRef(1);
  const [rate, setRate] = useState(8); // rows per tick
  const [running, setRunning] = useState(true);

  // Force a classic bottom-tailing view (newest at bottom): the most
  // scroll-churn-heavy layout and the one users most associate with the ghost.
  useEffect(() => {
    setSort("newest-bottom");
  }, [setSort]);

  // Synthetic feeder — appends `rate` rows every 120ms while running.
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      const batch: LogEvent[] = [];
      for (let i = 0; i < rate; i++) batch.push(makeEvent(nextIdRef.current++));
      const next = allRef.current.concat(batch);
      allRef.current = next.length > STORE_CAP ? next.slice(-STORE_CAP) : next;
      setEvents(allRef.current);
    }, 120);
    return () => window.clearInterval(timer);
  }, [running, rate, setEvents]);

  // The newest-N window LogStream actually paints (mirrors App.tsx streamEvents).
  const streamEvents = useMemo(() => {
    if (events.length <= RENDER_CAP) return events;
    return sort === "newest-bottom" ? events.slice(-RENDER_CAP) : events.slice(0, RENDER_CAP);
  }, [events, sort]);

  const colVars = { "--stream-cols": STREAM_COLS } as React.CSSProperties;

  return (
    <div className="win spike-win">
      <div className="spike-banner">
        <b>istoria ghost spike</b> — Electron / Chromium · {events.length.toLocaleString()} in
        store, painting newest {Math.min(events.length, RENDER_CAP)} ·{" "}
        <button onClick={() => setRunning((r) => !r)}>
          {running ? "⏸ pause feed" : "▶ resume feed"}
        </button>{" "}
        <button onClick={() => setRate((r) => (r >= 32 ? 4 : r * 2))}>rate ×{rate}</button>
        <span className="spike-hint">
          Repro: sleep display · unplug/replug monitor · drag Retina⇄non-Retina — watch for doubled
          / stale rows
        </span>
      </div>
      <div className="main">
        <div className="stream-col" style={colVars}>
          <LogStream
            events={streamEvents}
            selectedId={null}
            selectedIds={[]}
            onSelect={() => {}}
            onSelectIds={() => {}}
            bottomInset={0}
            visibility={{ ts: true, lvl: true, src: true, br: true }}
            fieldColumns={[]}
            highlightTerms={[]}
            alertMatches={new Map()}
            relevantIds={new Set()}
          />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
