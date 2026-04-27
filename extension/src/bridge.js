// ISOLATED-world content script. Listens for postMessages from the
// MAIN-world injected.js and relays them to the service worker.
window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  const data = e.data;
  if (!data || data.__istoria !== true) return;
  if (typeof data.source !== "string" || !data.event) return;
  try {
    chrome.runtime.sendMessage({ type: "event", source: data.source, event: data.event });
  } catch {}
});
