// Minimal Electron main for the ghost-kill spike. Loads the static Vite build
// (dist/index.html) — no dev server, no sidecar, no Tauri. Mirrors how the real
// Electron app will load its renderer, so the compositor path under test is
// representative.
const { app, BrowserWindow } = require("electron");
const path = require("path");

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "istoria ghost spike (Chromium)",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "dist", "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
