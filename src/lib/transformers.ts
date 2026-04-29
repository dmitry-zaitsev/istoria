import type { Level, LogEvent } from "./ipc";

export interface TransformerOutput {
  source?: string;
  level?: string;
  msg?: string;
  fields?: Record<string, string>;
  /// Template that resolves to a JSON object literal. Parsed and its
  /// keys spread onto the event's fields. For embedded structured
  /// payloads (e.g. trailing `{...}` blobs) so each key is a top-level
  /// field instead of a nested blob.
  merge_fields?: string;
}

export interface TransformerRule {
  id: string;
  name: string;
  order: number;
  pattern: string;
  flags?: string;
  output: TransformerOutput;
}

export const BUILTIN_TRANSFORMERS: TransformerRule[] = [
  // === Format-specific structured loggers (specific → fall through) ===
  {
    id: "k8s-klog",
    name: "Kubernetes klog",
    order: 5,
    // I0114 10:30:45.123456    1 file.go:123] message
    pattern:
      "^(?<lvl>[IWEF])(?<mmdd>\\d{4})\\s+(?<time>\\d{2}:\\d{2}:\\d{2}\\.\\d+)\\s+(?<thread>\\d+)\\s+(?<file>\\S+)\\]\\s+(?<body>.*)$",
    output: {
      level: "${lvl}",
      msg: "${body}",
      fields: { file: "${file}", thread: "${thread}" },
    },
  },
  {
    id: "java-log4j",
    name: "Java log4j/logback",
    order: 6,
    // 2024-01-15 10:30:45,123 INFO  [main] com.example.Foo - message
    pattern:
      "^(?<timestamp>\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}[.,]\\d+)\\s+(?<lvl>TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\\s+\\[(?<thread>[^\\]]+)\\]\\s+(?<logger>\\S+)\\s+-\\s+(?<body>.*)$",
    output: {
      level: "${lvl}",
      msg: "${body}",
      source: "${logger}",
      fields: { thread: "${thread}" },
    },
  },
  {
    id: "python-logging",
    name: "Python logging",
    order: 7,
    // 2024-01-15 10:30:45,123 - module.name - INFO - message
    pattern:
      "^(?<timestamp>\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}:\\d{2}[.,]\\d+)\\s+-\\s+(?<logger>\\S+)\\s+-\\s+(?<lvl>DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL)\\s+-\\s+(?<body>.*)$",
    output: {
      level: "${lvl}",
      msg: "${body}",
      source: "${logger}",
    },
  },
  {
    id: "android-logcat",
    name: "Android logcat",
    order: 8,
    // D/TAG    ( 1234): message
    pattern:
      "^(?<lvl>[VDIWEF])/(?<tag>[^\\s\\(]+)\\s*\\(\\s*(?<pid>\\d+)\\):\\s*(?<body>.*)$",
    output: {
      level: "${lvl}",
      msg: "${body}",
      fields: { tag: "${tag}", pid: "${pid}" },
    },
  },
  {
    id: "ios-nslog",
    name: "iOS NSLog/os_log",
    order: 9,
    // 2024-01-15 10:30:45.123 MyApp[1234:5678] message
    pattern:
      "^(?<timestamp>\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}:\\d{2}\\.\\d+)\\s+(?<proc>\\S+)\\[(?<pid>\\d+):(?<tid>[0-9a-fx]+)\\]\\s+(?<body>.*)$",
    output: {
      source: "${proc}",
      msg: "${body}",
      fields: { pid: "${pid}", tid: "${tid}" },
    },
  },
  {
    id: "rust-tracing",
    name: "Rust env_logger/tracing",
    order: 11,
    // [2024-01-15T10:30:45Z INFO module::path] message
    pattern:
      "^\\[(?<timestamp>\\S+)\\s+(?<lvl>TRACE|DEBUG|INFO|WARN|ERROR)\\s+(?<module>\\S+)\\]\\s+(?<body>.*)$",
    output: {
      level: "${lvl}",
      msg: "${body}",
      source: "${module}",
    },
  },
  {
    id: "syslog-rfc3164",
    name: "syslog (RFC3164)",
    order: 12,
    // <14>Jan 15 10:30:45 host program[123]: message
    pattern:
      "^<(?<pri>\\d+)>(?<timestamp>\\w{3}\\s+\\d+\\s+\\d+:\\d+:\\d+)\\s+(?<host>\\S+)\\s+(?<prog>[^\\[\\s:]+)(?:\\[(?<pid>\\d+)\\])?:\\s+(?<body>.*)$",
    output: {
      source: "${prog}",
      msg: "${body}",
      fields: { host: "${host}", pid: "${pid}" },
    },
  },
  {
    id: "docker-cri",
    name: "Docker/CRI",
    order: 13,
    // 2024-01-15T10:30:45.123Z stdout F message
    pattern:
      "^(?<timestamp>\\S+)\\s+(?<stream>stdout|stderr)\\s+[FP]\\s+(?<body>.*)$",
    output: {
      msg: "${body}",
      fields: { stream: "${stream}" },
    },
  },

  // === Existing prefix-stripping rules (compose with above) ===
  {
    id: "turbo",
    name: "Turbo prefix",
    order: 14,
    pattern: "^(?<pkg>@?[\\w./-]+):(?<script>[\\w-]+):\\s?(?<body>.*)$",
    output: {
      source: "${pkg}",
      msg: "${body}",
      fields: { script: "${script}" },
    },
  },
  {
    id: "nodemon",
    name: "Nodemon",
    order: 15,
    pattern: "^\\[nodemon\\]\\s+(?<body>.*)$",
    output: { msg: "${body}", fields: { tag: "nodemon" } },
  },
  {
    id: "level-prefix",
    name: "Level prefix",
    order: 20,
    pattern: "^(?<lvl>INFO|WARN|ERROR|DEBUG|TRACE):\\s+(?<body>.*)$",
    output: { level: "${lvl}", msg: "${body}" },
  },
  {
    id: "bracket-tag",
    name: "Bracket tag",
    order: 30,
    pattern: "^\\[(?<tag>[^\\]]+)\\]\\s+(?<body>.*)$",
    output: { msg: "${body}", fields: { tag: "${tag}" } },
  },
  {
    id: "trailing-json",
    name: "Trailing JSON",
    order: 40,
    pattern: "^(?<body>.*?)\\s+(?<json>\\{.*\\})\\s*$",
    output: { msg: "${body}", merge_fields: "${json}" },
  },
];

export interface CompiledRule {
  rule: TransformerRule;
  re: RegExp | null;
  error?: string;
}

export function compileRules(rules: TransformerRule[]): CompiledRule[] {
  return rules
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((rule) => {
      try {
        const re = new RegExp(rule.pattern, rule.flags ?? "");
        return { rule, re };
      } catch (e) {
        return { rule, re: null, error: (e as Error).message };
      }
    });
}

export const COMPILED_BUILTINS: CompiledRule[] = compileRules(
  BUILTIN_TRANSFORMERS,
);

const LEVELS: ReadonlySet<Level> = new Set([
  "error",
  "warn",
  "info",
  "debug",
  "trace",
]);

function normalizeLevel(s: string): Level | null {
  const lc = s.toLowerCase().trim();
  if (LEVELS.has(lc as Level)) return lc as Level;
  switch (lc) {
    case "err":
    case "e":
    case "f":
    case "fatal":
    case "panic":
    case "crit":
    case "critical":
      return "error";
    case "w":
    case "warning":
      return "warn";
    case "i":
    case "notice":
      return "info";
    case "d":
    case "dbg":
      return "debug";
    case "v":
      return "trace";
    default:
      return null;
  }
}

function substitute(
  template: string,
  caps: Record<string, string>,
): string {
  return template.replace(/\$\{(\w+)\}/g, (_, name) => caps[name] ?? "");
}

function looksLikeJson(s: string): boolean {
  const t = s.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}

export function applyTransformers(
  ev: LogEvent,
  compiled: CompiledRule[],
): LogEvent {
  if (compiled.length === 0) return ev;
  let mutated = false;
  let out: LogEvent = ev;
  for (const c of compiled) {
    if (!c.re) continue;
    // Match against the running msg so rules compose: e.g. Turbo
    // strips "@pkg:script:" → Trailing JSON then strips the trailing
    // {...} from what remains. Matching against the original msg
    // would let later rules overwrite earlier rules' msg output.
    c.re.lastIndex = 0;
    const m = c.re.exec(out.msg);
    if (!m) continue;
    const caps: Record<string, string> = {};
    if (m.groups) {
      for (const [k, v] of Object.entries(m.groups)) {
        caps[k] = v ?? "";
      }
    }
    if (!mutated) {
      out = { ...ev };
      mutated = true;
    }
    const o = c.rule.output;
    if (o.source != null) {
      const v = substitute(o.source, caps);
      if (v) out.source = v;
    }
    if (o.msg != null) {
      const v = substitute(o.msg, caps);
      // Don't clobber a meaningful msg with an empty capture. Lines
      // that are just the prefix (e.g. "@pkg:script: ") yield empty
      // body — keep the canonical msg so the row renders text, not
      // the raw wire wrapper as a fallback.
      if (v) out.msg = v;
    }
    if (o.level != null) {
      const lvl = normalizeLevel(substitute(o.level, caps));
      if (lvl) out.level = lvl;
    }
    if (o.fields || o.merge_fields) {
      const base =
        out.fields && typeof out.fields === "object"
          ? { ...(out.fields as Record<string, unknown>) }
          : {};
      if (o.fields) {
        for (const [k, tpl] of Object.entries(o.fields)) {
          const v = substitute(tpl, caps);
          if (looksLikeJson(v)) {
            try {
              base[k] = JSON.parse(v);
              continue;
            } catch {
              // fall through to string
            }
          }
          base[k] = v;
        }
      }
      if (o.merge_fields) {
        const v = substitute(o.merge_fields, caps);
        if (v) {
          try {
            const parsed = JSON.parse(v);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              for (const [k, val] of Object.entries(
                parsed as Record<string, unknown>,
              )) {
                base[k] = val;
              }
            }
          } catch {
            // bad JSON — drop silently rather than dirty fields
          }
        }
      }
      out.fields = base;
    }
  }
  if (mutated) {
    // Keep fields in sync with the transformed top-level so the
    // inspector shows consistent values (e.g. fields.source matches
    // event.source after a Turbo prefix split). Backend may have
    // populated fields from a JSON wire line whose source/msg/level
    // were the pre-transform wire values.
    const base =
      out.fields && typeof out.fields === "object"
        ? { ...(out.fields as Record<string, unknown>) }
        : null;
    if (base) {
      base.source = out.source;
      base.level = out.level;
      base.msg = out.msg;
      out.fields = base;
    }
  }
  return out;
}

export function applyAll(
  events: LogEvent[],
  compiled: CompiledRule[],
): LogEvent[] {
  if (compiled.length === 0) return events;
  return events.map((e) => applyTransformers(e, compiled));
}
