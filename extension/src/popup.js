const dotEl = document.getElementById("dot");
const statusEl = document.getElementById("statusText");
const hintEl = document.getElementById("statusHint");
const btnEl = document.getElementById("recBtn");
const btnLabelEl = document.getElementById("recLabel");

let currentTabId = null;

function ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function setDot(cls) {
  dotEl.className = `dot${cls ? " " + cls : ""}`;
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => resolve(resp));
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

function canInject(tab) {
  if (!tab?.url) return false;
  return /^https?:\/\//.test(tab.url) || tab.url.startsWith("file://");
}

async function refresh() {
  const tab = await getActiveTab();
  currentTabId = tab?.id ?? null;

  if (!canInject(tab)) {
    btnEl.disabled = true;
    btnEl.classList.remove("btn-stop");
    btnEl.classList.add("btn-rec");
    btnLabelEl.textContent = "Start recording";
    setDot("");
    statusEl.textContent = "This page can't be recorded.";
    hintEl.textContent = "Open an http(s) page and try again.";
    return;
  }

  const resp = await sendMessage({ type: "popup-state", tabId: currentTabId });
  if (!resp) {
    btnEl.disabled = true;
    btnLabelEl.textContent = "Start recording";
    setDot("warn");
    statusEl.textContent = "Service worker idle";
    hintEl.textContent = "Reopen the popup.";
    return;
  }

  btnEl.disabled = false;

  if (resp.recording) {
    btnEl.classList.remove("btn-rec");
    btnEl.classList.add("btn-stop");
    btnLabelEl.textContent = "Stop recording";
    setDot("live");
    if (resp.lastErr) {
      statusEl.textContent = "istoria not reachable";
      hintEl.textContent = resp.lastErr;
    } else if (resp.lastOk) {
      statusEl.textContent = "Recording this tab";
      hintEl.textContent = `Last event ${ago(resp.lastOk)}`;
    } else {
      statusEl.textContent = "Recording this tab";
      hintEl.textContent = "Waiting for events…";
    }
  } else {
    btnEl.classList.remove("btn-stop");
    btnEl.classList.add("btn-rec");
    btnLabelEl.textContent = "Start recording";
    setDot("");
    statusEl.textContent = "Not recording";
    hintEl.textContent = "Click to capture console + network events.";
  }
}

btnEl.addEventListener("click", async () => {
  if (currentTabId == null) return;
  btnEl.disabled = true;
  const isRecording = btnEl.classList.contains("btn-stop");
  if (isRecording) {
    await sendMessage({ type: "stop", tabId: currentTabId });
  } else {
    const resp = await sendMessage({ type: "start", tabId: currentTabId });
    if (!resp?.ok) {
      statusEl.textContent = "Couldn't start recording";
      hintEl.textContent = resp?.error || "executeScript failed";
      btnEl.disabled = false;
      return;
    }
  }
  refresh();
});

refresh();
