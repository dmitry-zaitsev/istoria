// Electron main process for istoria.
//
// Spawns the headless Rust core (`istoria-core`) as a sidecar, discovers the
// port it binds (printed to stderr), generates a per-launch bearer token, and
// hands both to the renderer via preload. The renderer (the real React app)
// then talks to the core over HTTP + SSE — no WKWebView, so no ghost.

const { app, BrowserWindow, Menu, shell, ipcMain } = require("electron");
const { autoUpdater } = require("electron-updater");
const { spawn } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const isDev = !app.isPackaged;
const DEV_URL = process.env.ISTORIA_DEV_URL || "http://localhost:1420";
const TOKEN = crypto.randomBytes(24).toString("hex");

let coreProc = null;
let mainWindow = null;
let quitting = false;

/** Resolve the core binary: dev → cargo target, packaged → app resources. */
function coreBinaryPath() {
  if (isDev) {
    // Cargo workspace → binaries land in the workspace-root target/.
    return path.join(__dirname, "..", "target", "debug", "istoria-core");
  }
  return path.join(process.resourcesPath, "istoria-core");
}

/** Spawn the core and resolve once it prints its HTTP port. */
function startCore() {
  return new Promise((resolve, reject) => {
    const bin = coreBinaryPath();
    if (!fs.existsSync(bin)) {
      reject(
        new Error(
          `core binary not found at ${bin} — run: cd src-tauri && cargo build --bin istoria-core`
        )
      );
      return;
    }
    const proc = spawn(bin, [], {
      env: { ...process.env, ISTORIA_GUI_OWNER: "1", ISTORIA_TOKEN: TOKEN },
      // Pass our stdin straight to the core so `logs | just dev` (Electron
      // launched with a piped stdin) streams into the ring. Launched normally
      // (no pipe), the core just sees EOF. Port handshake is on stderr, so a
      // teed stdin on stdout doesn't interfere.
      stdio: ["inherit", "pipe", "pipe"],
    });
    coreProc = proc;

    let resolved = false;
    const onData = (buf) => {
      const s = buf.toString();
      process.stderr.write(`[core] ${s}`);
      const m = s.match(/ISTORIA_HTTP_PORT=(\d+)/);
      if (m && !resolved) {
        resolved = true;
        resolve(parseInt(m[1], 10));
      }
    };
    proc.stderr.on("data", onData);
    proc.stdout.on("data", (b) => process.stdout.write(`[core] ${b}`));

    proc.on("exit", (code, signal) => {
      coreProc = null;
      if (!resolved) reject(new Error(`core exited early (code ${code}, signal ${signal})`));
      if (!quitting) {
        // The core is the data engine; without it the UI is dead. Bail.
        console.error(`[core] exited unexpectedly (code ${code}) — quitting`);
        app.quit();
      }
    });
    proc.on("error", (err) => {
      if (!resolved) reject(err);
    });
  });
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: "istoria",
    titleBarStyle: "hiddenInset", // matches the Tauri "Overlay" (inset traffic lights)
    backgroundColor: "#1a1a1a",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--istoria-port=${port}`, `--istoria-token=${TOKEN}`],
    },
  });

  // Open target=_blank / window.open externally rather than in a new BrowserWindow.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Surface renderer warnings/errors and load failures to the main stdout so
  // they're visible when running headless / from a terminal.
  mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    if (level >= 2) process.stderr.write(`[renderer] ${message} (${sourceId}:${line})\n`);
  });
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    process.stderr.write(`[renderer] did-fail-load ${code} ${desc} ${url}\n`);
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    process.stderr.write(`[renderer] render-process-gone ${JSON.stringify(details)}\n`);
  });

  if (isDev) {
    mainWindow.loadURL(DEV_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Renderer-invokable relaunch (replaces Tauri plugin-process `relaunch()`).
ipcMain.handle("istoria:relaunch", () => {
  app.relaunch();
  app.exit(0);
});

// ---- Auto-update (electron-updater) ---------------------------------------
// Replaces the Tauri updater plugin for direct-download (non-brew) installs.
// The feed is the embedded app-update.yml (electron-builder `publish` config →
// dmitry-zaitsev/istoria-releases). Brew installs update via `brew upgrade`
// (handled in the renderer); electron-updater refuses to run on brew/unsigned
// builds, so those paths simply surface an error the UI falls back from.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

function forwardUpdateEvent(type, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("istoria:update-event", { type, payload });
  }
}
autoUpdater.on("update-available", (info) =>
  forwardUpdateEvent("available", { version: info.version })
);
autoUpdater.on("update-not-available", () => forwardUpdateEvent("not-available", {}));
autoUpdater.on("download-progress", (p) => forwardUpdateEvent("progress", { percent: p.percent }));
autoUpdater.on("update-downloaded", (info) =>
  forwardUpdateEvent("downloaded", { version: info.version })
);
autoUpdater.on("error", (err) => forwardUpdateEvent("error", { message: String(err) }));

// Start check + download. Throws in dev / unsigned / brew — the renderer
// catches and falls back to opening the release page.
ipcMain.handle("istoria:update-start", async () => {
  const result = await autoUpdater.checkForUpdates();
  if (result && result.updateInfo) {
    await autoUpdater.downloadUpdate();
  }
});
ipcMain.handle("istoria:update-install", () => {
  autoUpdater.quitAndInstall();
});

app.whenReady().then(async () => {
  buildMenu();
  // Dev dock icon: the packaged app gets its icon from the bundle Info.plist,
  // but a dev run (`just dev`) would otherwise show the generic Electron icon.
  if (isDev && process.platform === "darwin" && app.dock) {
    const devIcon = path.join(__dirname, "..", "src-tauri", "icons", "icon.png");
    if (fs.existsSync(devIcon)) app.dock.setIcon(devIcon);
  }
  try {
    const port = await startCore();
    createWindow(port);
  } catch (err) {
    console.error("Failed to start istoria core:", err);
    app.quit();
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && coreProc) {
      // Port is stable across the process lifetime; re-read from the running core.
      // Simplicity: only recreate if we still have a window reference path.
    }
  });
});

app.on("before-quit", () => {
  quitting = true;
  if (coreProc) {
    coreProc.kill("SIGTERM");
    coreProc = null;
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
