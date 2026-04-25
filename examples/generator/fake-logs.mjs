#!/usr/bin/env node
// Random log emitter for dogfooding istoria.
// Usage: `node examples/generator/fake-logs.mjs [--rate 50] [--burst 5]`
//   --rate  events per second (default 30)
//   --burst max events per tick (default 4)
//   --plain include some non-JSON lines too

const args = process.argv.slice(2);
const arg = (k, dflt) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : dflt;
};
const RATE = Number(arg("--rate", 30));
const BURST = Number(arg("--burst", 4));
const INCLUDE_PLAIN = args.includes("--plain");

const SOURCES = ["web", "api", "job", "db"];
const METHODS = ["GET", "POST", "PATCH", "DELETE"];
const PATHS = [
  "/api/users",
  "/api/users/42",
  "/api/users/207",
  "/api/posts",
  "/api/comments",
  "/api/feed",
  "/sessions",
  "/payments",
  "/api/uploads",
  "/api/admin",
  "/health",
];
const STATUS_CODES = [
  200, 200, 200, 200, 200, 201, 204, 304, 400, 401, 403, 404, 500, 502, 503,
];
const USERS = [42, 88, 207, 1009, 9001, 12345];
const LEVELS = ["info", "info", "info", "debug", "warn", "warn", "error"];
const ERR_MESSAGES = [
  "TypeError: cannot read property id of undefined",
  "validation failed: title required",
  "unauthorized",
  "forbidden — role mismatch",
  "gateway timeout",
  "ECONNRESET upstream feed.svc",
];
const STACK_TEMPLATES = [
  [
    "at handler (src/api/handler.js:%LINE%:18)",
    "at processRequest (src/server.js:%LINE%:7)",
    "at Layer.handle (node_modules/express/lib/router/layer.js:95:5)",
  ],
  [
    "at Sharp.<anonymous> (node_modules/sharp/lib/output.js:88:22)",
    "at processImage (src/jobs/resize.js:21:9)",
  ],
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const ridx = () => Math.floor(Math.random() * 100000);
const reqId = () => `req_${Math.random().toString(36).slice(2, 8)}`;
const traceId = () => `t_${Math.random().toString(36).slice(2, 10)}`;

function statusForLevel(level) {
  if (level === "error") return pick([400, 401, 403, 404, 500, 502, 503]);
  if (level === "warn") return pick([200, 201, 304, 400]);
  return pick([200, 200, 200, 201, 204, 304]);
}

function durationFor(level) {
  // Rough log-normal-ish distribution. Errors skew higher.
  const base = level === "error" ? 600 : level === "warn" ? 200 : 30;
  return Math.round(base * Math.exp(Math.random() * 4));
}

function makeHttpEvent() {
  const level = pick(LEVELS);
  const method = pick(METHODS);
  const path = pick(PATHS);
  const status = statusForLevel(level);
  const dur = durationFor(level);
  const user = { id: pick(USERS) };
  const rid = reqId();
  const tid = traceId();
  const obj = {
    level,
    source: pick(["web", "api"]),
    msg: `${method} ${path}`,
    method,
    path,
    status_code: status,
    dur_ms: dur,
    user,
    request_id: rid,
    trace_id: tid,
  };
  if (level === "error") {
    obj.msg = pick(ERR_MESSAGES);
    obj.stack = pick(STACK_TEMPLATES).map((f) =>
      f.replace("%LINE%", String(10 + (ridx() % 200))),
    );
  }
  return JSON.stringify(obj);
}

function makeJobEvent() {
  const level = pick(["info", "info", "debug", "warn", "error"]);
  const job = pick([
    "email.welcome.send",
    "image.resize",
    "thumbnail.generate",
    "sitemap.refresh",
    "analytics.flush",
  ]);
  const obj = {
    level,
    source: "job",
    msg: `${job} ${level === "error" ? "failed" : "done"}`,
    job,
    dur_ms: durationFor(level),
    customData: {
      fieldA: { rows: [{ count: ridx() % 1000, idx: ridx() % 100 }] },
    },
  };
  return JSON.stringify(obj);
}

function makeDbEvent() {
  const level = pick(["debug", "info", "warn"]);
  const obj = {
    level,
    source: "db",
    msg: level === "warn" ? "replication lag" : "query plan",
    rows: ridx() % 5000,
    dur_ms: durationFor(level),
    plan: pick(["index_scan", "seq_scan", "hash_join", "nested_loop"]),
  };
  return JSON.stringify(obj);
}

function makePlainLine() {
  const ts = new Date().toISOString().slice(11, 23);
  const level = pick(LEVELS).toUpperCase();
  const src = pick(SOURCES);
  return `[${ts}] ${level.padEnd(5)} ${src.padEnd(4)} ${pick(PATHS)} ${pick(STATUS_CODES)}`;
}

function emit() {
  const r = Math.random();
  let line;
  if (INCLUDE_PLAIN && r < 0.05) line = makePlainLine();
  else if (r < 0.55) line = makeHttpEvent();
  else if (r < 0.8) line = makeJobEvent();
  else line = makeDbEvent();
  process.stdout.write(line + "\n");
}

const intervalMs = Math.max(10, Math.floor(1000 / RATE));
setInterval(() => {
  const burst = 1 + Math.floor(Math.random() * BURST);
  for (let i = 0; i < burst; i++) emit();
}, intervalMs);

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
