import { describe, expect, it } from "vitest";

import type { Level, LogEvent } from "./ipc";
import { applyTransformers, BUILTIN_TRANSFORMERS, COMPILED_BUILTINS } from "./transformers";

// End-to-end coverage for the prefix destructurer. Each case feeds a
// raw log line through the same path the UI uses — the real compiled
// `transformer_rules.json` rules via `applyTransformers` — and asserts
// the destructured event (source / level / msg / fields).
//
// We seed the input the way the backend's plain-line ingest does:
// `msg === raw`, `level: "info"`, `fields: null` (see
// `event_from_plain` in src-tauri/src/format.rs). The JSON wire path
// (nested-msg unwrap, bracket-tagged JSON, numeric levels) is the
// backend's job and is covered by the Rust tests in format.rs.

function destructure(raw: string): LogEvent {
  const ev: LogEvent = {
    id: 1,
    ts: 0,
    source: "pipe-1",
    branch: "main",
    level: "info",
    msg: raw,
    raw,
    fields: null,
  };
  return applyTransformers(ev, COMPILED_BUILTINS);
}

interface Case {
  rule: string;
  raw: string;
  /** Expected event.source. Defaults to the wire source "pipe-1". */
  source?: string;
  /** Expected event.level. Defaults to "info". */
  level?: Level;
  msg: string;
  /** Subset of expected fields — only these keys are asserted. */
  fields?: Record<string, unknown>;
}

const CASES: Case[] = [
  {
    rule: "k8s-klog",
    raw: "W0114 10:30:45.123456    1 server.go:42] disk almost full",
    level: "warn",
    msg: "disk almost full",
    fields: { file: "server.go:42", thread: "1" },
  },
  {
    rule: "java-log4j",
    raw: "2026-05-02 10:30:45,123 ERROR [main] com.example.Foo - boom",
    source: "com.example.Foo",
    level: "error",
    msg: "boom",
    fields: { thread: "main" },
  },
  {
    rule: "python-logging",
    raw: "2026-05-02 10:30:45,123 - module.name - WARNING - heads up",
    source: "module.name",
    level: "warn",
    msg: "heads up",
  },
  {
    rule: "android-logcat",
    raw: "D/MyTag  ( 1234): activity created",
    level: "debug",
    msg: "activity created",
    fields: { tag: "MyTag", pid: "1234" },
  },
  {
    rule: "ios-nslog",
    raw: "2026-05-02 10:30:45.123 MyApp[1234:5678] launched",
    source: "MyApp",
    msg: "launched",
    fields: { pid: "1234", tid: "5678" },
  },
  {
    rule: "rust-tracing-fmt",
    raw: '2026-05-18T10:34:21.543675Z  INFO memphis_lib::agent: batch.start kind="file" size=10',
    source: "memphis_lib::agent",
    msg: 'batch.start kind="file" size=10',
  },
  {
    rule: "rust-tracing",
    raw: "[2026-05-02T10:30:45Z ERROR mod::path] kaboom",
    source: "mod::path",
    level: "error",
    msg: "kaboom",
  },
  {
    rule: "syslog-rfc3164",
    raw: "<14>Jan 15 10:30:45 host program[123]: hello",
    source: "program",
    msg: "hello",
    fields: { host: "host", pid: "123" },
  },
  {
    rule: "docker-cri",
    raw: "2026-05-02T10:30:45.123Z stderr F crashed",
    msg: "crashed",
    fields: { stream: "stderr" },
  },
  {
    rule: "turbo",
    raw: "@linear/client:start-client: hello world",
    source: "@linear/client",
    msg: "hello world",
    fields: { script: "start-client" },
  },
  {
    rule: "nodemon",
    raw: "[nodemon] starting `node server.js`",
    msg: "starting `node server.js`",
    fields: { tag: "nodemon" },
  },
  {
    // The reported case: pnpm/turbo workspace prefix with a *space*
    // between package path and script (distinct from the Turbo rule's
    // `pkg:script:` colon form).
    rule: "workspace-path",
    raw: "apps/game-tester dev: 1:34:43 AM [vite] (client) hmr update /src/App.tsx",
    source: "apps/game-tester",
    msg: "1:34:43 AM [vite] (client) hmr update /src/App.tsx",
    fields: { script: "dev" },
  },
  {
    rule: "level-prefix",
    raw: "ERROR: oh no",
    level: "error",
    msg: "oh no",
  },
  {
    rule: "bracket-tag",
    raw: "[auth] login ok",
    msg: "login ok",
    fields: { tag: "auth" },
  },
  {
    rule: "trailing-json",
    raw: 'request done {"status":200}',
    msg: "request done",
    fields: { status: 200 },
  },
];

describe("destructurer e2e", () => {
  it.each(CASES)("$rule destructures its example", (c) => {
    const out = destructure(c.raw);
    expect(out.source).toBe(c.source ?? "pipe-1");
    expect(out.level).toBe(c.level ?? "info");
    expect(out.msg).toBe(c.msg);
    if (c.fields) {
      const got = out.fields as Record<string, unknown>;
      for (const [k, v] of Object.entries(c.fields)) {
        expect(got[k]).toEqual(v);
      }
    }
  });

  it("composes rules: turbo prefix then trailing JSON", () => {
    // Both a `@pkg:script:` wrapper and a trailing `{...}` blob on one
    // line — turbo strips the prefix, trailing-json lifts the blob.
    const out = destructure('@linear/client:start-client: done {"code":0}');
    expect(out.source).toBe("@linear/client");
    expect(out.msg).toBe("done");
    const f = out.fields as Record<string, unknown>;
    expect(f.script).toBe("start-client");
    expect(f.code).toBe(0);
  });

  it.each(["Server started: listening on port 3000", "Build complete: 0 errors"])(
    "leaves prose %j untouched (workspace-path needs a slash)",
    (raw) => {
      // Ordinary `word word: rest` prose must not be mis-split into
      // source/script — the workspace-path rule requires a path separator
      // in the package token to fire.
      const out = destructure(raw);
      expect(out.source).toBe("pipe-1");
      expect(out.msg).toBe(raw);
    }
  );

  it("leaves an unrecognized plain line fully untouched", () => {
    const raw = "just some unstructured chatter";
    const out = destructure(raw);
    expect(out.source).toBe("pipe-1");
    expect(out.level).toBe("info");
    expect(out.msg).toBe(raw);
    expect(out.fields).toBeNull();
  });

  it("has a test for every shipped rule", () => {
    // Guard against adding a rule to transformer_rules.json without an
    // accompanying e2e example here.
    const covered = new Set(CASES.map((c) => c.rule));
    const shipped = BUILTIN_TRANSFORMERS.map((r) => r.id);
    const missing = shipped.filter((id) => !covered.has(id));
    expect(missing).toEqual([]);
  });
});
