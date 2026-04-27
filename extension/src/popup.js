const dotEl = document.getElementById("dot");
const statusEl = document.getElementById("statusText");
const hintEl = document.getElementById("statusHint");

function ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function setState(dotClass, text, hint) {
  dotEl.className = `dot${dotClass ? " " + dotClass : ""}`;
  statusEl.textContent = text;
  hintEl.textContent = hint || "";
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => resolve(resp));
  });
}

(async () => {
  const resp = await sendMessage({ type: "status" });
  if (!resp) {
    setState("warn", "Service worker idle", "Reopen the popup.");
    return;
  }
  const recentOk = resp.lastOk && Date.now() - resp.lastOk < 5_000;
  if (recentOk) {
    setState("live", "Streaming to istoria", `Last event ${ago(resp.lastOk)}`);
    return;
  }
  if (resp.lastErr) {
    setState("warn", "istoria not reachable", resp.lastErr);
    return;
  }
  if (resp.lastOk) {
    setState("", "Idle", `Last event ${ago(resp.lastOk)}`);
    return;
  }
  setState("", "Waiting for events", "Visit a page that logs to console.");
})();
