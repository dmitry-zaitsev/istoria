// istoria browser-logs service worker.
//
// Programmatic injection model: nothing runs on a tab until the user
// clicks "Start recording" in the popup. That click grants activeTab
// for the current tab; we then inject bridge.js (ISOLATED) and
// injected.js (MAIN). Events flow back through chrome.runtime.sendMessage
// and are POSTed to istoria's local HTTP ingest endpoint at 127.0.0.1:9787.
//
// Stop / cross-origin nav drops the tab from `recordingTabs`. The page
// may stay patched (no way to un-patch console/fetch in MAIN world) but
// the SW gates by sender tabId so nothing leaves the browser.

const PORT = 9787;
const FLUSH_INTERVAL_MS = 250;
const FLUSH_BATCH = 50;

const buffers = new Map(); // source -> events[]
const recordingTabs = new Set(); // tabId set
let flushTimer = null;
let lastIngestOk = null;
let lastIngestErr = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "event") {
    const tabId = sender?.tab?.id;
    if (tabId == null || !recordingTabs.has(tabId)) {
      sendResponse({ ok: false, dropped: true });
      return false;
    }
    push(msg.source, msg.event);
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "popup-state") {
    const tabId = msg.tabId;
    sendResponse({
      recording: tabId != null && recordingTabs.has(tabId),
      lastOk: lastIngestOk,
      lastErr: lastIngestErr,
    });
    return false;
  }
  if (msg?.type === "start") {
    startRecording(msg.tabId).then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: String(e?.message || e) }),
    );
    return true; // async
  }
  if (msg?.type === "stop") {
    recordingTabs.delete(msg.tabId);
    sendResponse({ ok: true });
    return false;
  }
  sendResponse({ error: "unknown message" });
  return false;
});

async function startRecording(tabId) {
  if (tabId == null) throw new Error("missing tabId");
  // ISOLATED bridge first so it's listening before MAIN injected.js posts.
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ["bridge.js"],
    world: "ISOLATED",
  });
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ["injected.js"],
    world: "MAIN",
  });
  recordingTabs.add(tabId);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  recordingTabs.delete(tabId);
});

// Any top-level navigation reloads the document — patches are gone and,
// for cross-origin navs, the activeTab grant is gone too. Drop the tab
// so the popup re-shows "Start recording".
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && recordingTabs.has(tabId)) {
    recordingTabs.delete(tabId);
  }
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
