// Dev orchestrator: build the Rust core, start Vite, wait for it, launch
// Electron pointed at the Vite dev server. Ctrl-C tears everything down.
import { spawn } from "node:child_process";
import http from "node:http";
import electronBinary from "electron";

const VITE_URL = "http://localhost:1420";
const root = new URL("..", import.meta.url).pathname;

const children = [];
function cleanup() {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("exit", cleanup);

function run(cmd, args, opts = {}) {
  const c = spawn(cmd, args, { stdio: "inherit", ...opts });
  children.push(c);
  return c;
}

function waitForUrl(url, timeoutMs = 60000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.destroy();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) reject(new Error(`timed out waiting for ${url}`));
        else setTimeout(tick, 300);
      });
    };
    tick();
  });
}

console.log("[dev] building istoria-core (cargo)…");
const build = run("cargo", ["build", "--bin", "istoria-core"], { cwd: root });
build.on("exit", async (code) => {
  if (code !== 0) {
    console.error("[dev] cargo build failed");
    cleanup();
    process.exit(code ?? 1);
  }
  console.log("[dev] starting vite…");
  run("npm", ["run", "dev"], { cwd: root });
  try {
    await waitForUrl(VITE_URL);
  } catch (e) {
    console.error(`[dev] ${e.message}`);
    cleanup();
    process.exit(1);
  }
  console.log("[dev] starting electron…");
  const electron = run(electronBinary, ["electron/main.cjs"], {
    cwd: root,
    env: { ...process.env, ISTORIA_DEV_URL: VITE_URL },
  });
  electron.on("exit", () => {
    cleanup();
    process.exit(0);
  });
});
