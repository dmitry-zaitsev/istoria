// Preload bridge. Exposes the core's HTTP port + per-launch bearer token (both
// passed as process args by main.cjs) to the renderer, plus a relaunch bridge
// (replaces Tauri's plugin-process `relaunch()`). This is the entire privileged
// surface the renderer needs — everything else goes over HTTP to the core.

const { contextBridge, ipcRenderer } = require("electron");

function argValue(prefix) {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

const httpPort = parseInt(argValue("--istoria-port=") || "9787", 10);
const token = argValue("--istoria-token=") || "";

contextBridge.exposeInMainWorld("istoria", {
  httpPort,
  token,
  relaunch: () => ipcRenderer.invoke("istoria:relaunch"),
  // In-app auto-update (electron-updater) for non-brew installs.
  update: {
    start: () => ipcRenderer.invoke("istoria:update-start"),
    install: () => ipcRenderer.invoke("istoria:update-install"),
    onEvent: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on("istoria:update-event", handler);
      return () => ipcRenderer.removeListener("istoria:update-event", handler);
    },
  },
});
