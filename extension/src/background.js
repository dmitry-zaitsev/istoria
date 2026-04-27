// istoria browser-logs service worker.
//
// Receives `{ type: 'event', source, event }` messages from the
// content-script bridge, batches per source, POSTs to istoria's
// local HTTP ingest endpoint at 127.0.0.1:9787.
//
// No chrome.debugger. No yellow banner.

const PORT = 9787;
const FLUSH_INTERVAL_MS = 250;
const FLUSH_BATCH = 50;

const buffers = new Map(); // source -> events[]
let flushTimer = null;
let lastIngestOk = null;
let lastIngestErr = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "event") {
    push(msg.source, msg.event);
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "status") {
    sendResponse({ lastOk: lastIngestOk, lastErr: lastIngestErr });
    return false;
  }
  sendResponse({ error: "unknown message" });
  return false;
});

function push(source, event) {
  if (typeof source !== "string" || !source || !event) return;
  if (source.length > 256) source = source.slice(0, 256);
  let buf = buffers.get(source);
  if (!buf) {
    buf = [];
    buffers.set(source, buf);
  }
  buf.push(event);
  ensureFlushTimer();
  if (buf.length >= FLUSH_BATCH) flushSource(source).catch(warn);
}

function ensureFlushTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushAll().catch(warn);
  }, FLUSH_INTERVAL_MS);
}

async function flushAll() {
  for (const s of [...buffers.keys()]) {
    await flushSource(s);
  }
}

async function flushSource(source) {
  const buf = buffers.get(source);
  if (!buf || buf.length === 0) return;
  const events = buf.splice(0, buf.length);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, events }),
    });
    if (res.ok) {
      lastIngestOk = Date.now();
      lastIngestErr = null;
    } else {
      lastIngestErr = `HTTP ${res.status}`;
      warn("ingest", res.status);
    }
  } catch (e) {
    lastIngestErr = String(e?.message || e);
    warn("ingest fetch failed", e);
  }
}

function warn(...args) {
  console.warn("istoria:", ...args);
}
