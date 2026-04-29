import type { Level, LogEvent } from "./ipc";

export type TransformerEngine = "regex";

export interface TransformerOutput {
  source?: string;
  level?: string;
  msg?: string;
  fields?: Record<string, string>;
  /// Template that resolves to a JSON object literal. The object is
  /// parsed and its keys spread onto the event's fields. Use this for
  /// embedded structured payloads (e.g. trailing `{...}` blobs) so
  /// each key shows up as a top-level field instead of a nested blob.
  merge_fields?: string;
}

export interface TransformerRule {
  id: string;
  name: string;
  engine: TransformerEngine;
  enabled: boolean;
  order: number;
  seeded?: boolean;
  pattern: string;
  flags?: string;
  output: TransformerOutput;
  created_at: number;
}

const STORAGE_KEY = "transformers.v1";
// Bump the marker version when seed rules' patterns/outputs change so
// existing seeded rules in localStorage get refreshed from code on
// next load. User-added rules (seeded !== true) are never touched.
const SEED_MARKER_KEY = "transformers.seeded.v2";

export const MAX_TRANSFORMERS = 50;

const SEED_RULES: TransformerRule[] = [
  {
    id: "seed-turbo",
    name: "Turbo prefix",
    engine: "regex",
    enabled: true,
    order: 10,
    seeded: true,
    pattern: "^(?<pkg>@?[\\w./-]+):(?<script>[\\w-]+):\\s?(?<body>.*)$",
    flags: "",
    output: {
      source: "${pkg}",
      msg: "${body}",
      fields: { script: "${script}" },
    },
    created_at: 0,
  },
  {
    id: "seed-level-prefix",
    name: "Level prefix",
    engine: "regex",
    enabled: true,
    order: 20,
    seeded: true,
    pattern: "^(?<lvl>INFO|WARN|ERROR|DEBUG|TRACE):\\s+(?<body>.*)$",
    flags: "",
    output: { level: "${lvl}", msg: "${body}" },
    created_at: 0,
  },
  {
    id: "seed-bracket-tag",
    name: "Bracket tag",
    engine: "regex",
    enabled: true,
    order: 30,
    seeded: true,
    pattern: "^\\[(?<tag>[^\\]]+)\\]\\s+(?<body>.*)$",
    flags: "",
    output: { msg: "${body}", fields: { tag: "${tag}" } },
    created_at: 0,
  },
  {
    id: "seed-trailing-json",
    name: "Trailing JSON",
    engine: "regex",
    enabled: true,
    order: 40,
    seeded: true,
    pattern: "^(?<body>.*?)\\s+(?<json>\\{.*\\})\\s*$",
    flags: "",
    output: { msg: "${body}", merge_fields: "${json}" },
    created_at: 0,
  },
  {
    id: "seed-nodemon",
    name: "Nodemon",
    engine: "regex",
    enabled: true,
    order: 25,
    seeded: true,
    pattern: "^\\[nodemon\\]\\s+(?<body>.*)$",
    flags: "",
    output: { msg: "${body}", fields: { tag: "nodemon" } },
    created_at: 0,
  },
];

function isValidRule(x: unknown): x is TransformerRule {
  if (x == null || typeof x !== "object") return false;
  const r = x as Partial<TransformerRule>;
  return (
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    typeof r.pattern === "string" &&
    r.output != null &&
    typeof r.output === "object"
  );
}

function coerceRule(r: TransformerRule): TransformerRule {
  return {
    id: r.id,
    name: r.name,
    engine: r.engine === "regex" ? "regex" : "regex",
    enabled: r.enabled !== false,
    order: typeof r.order === "number" ? r.order : 100,
    seeded: r.seeded === true || undefined,
    pattern: r.pattern,
    flags: typeof r.flags === "string" ? r.flags : "",
    output: {
      source: typeof r.output.source === "string" ? r.output.source : undefined,
      level: typeof r.output.level === "string" ? r.output.level : undefined,
      msg: typeof r.output.msg === "string" ? r.output.msg : undefined,
      fields:
        r.output.fields && typeof r.output.fields === "object"
          ? Object.fromEntries(
              Object.entries(r.output.fields).filter(
                ([, v]) => typeof v === "string",
              ),
            )
          : undefined,
      merge_fields:
        typeof r.output.merge_fields === "string"
          ? r.output.merge_fields
          : undefined,
    },
    created_at:
      typeof r.created_at === "number" ? r.created_at : Date.now(),
  };
}

function readRaw(): TransformerRule[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidRule).map(coerceRule);
  } catch {
    return [];
  }
}

function writeRaw(rules: TransformerRule[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
  } catch (e) {
    console.warn("transformers persist failed", e);
  }
}

export function loadTransformers(): TransformerRule[] {
  let rules = readRaw();
  if (!localStorage.getItem(SEED_MARKER_KEY)) {
    // Refresh: any existing seeded rule gets replaced with the latest
    // SEED_RULES definition (preserving enabled + order + created_at
    // so user toggles and reorderings survive). Missing seed rules
    // get added. User-added rules (seeded !== true) untouched.
    const seedById = new Map(SEED_RULES.map((s) => [s.id, s]));
    rules = rules.map((r) => {
      if (!r.seeded) return r;
      const latest = seedById.get(r.id);
      if (!latest) return r;
      return {
        ...latest,
        enabled: r.enabled,
        order: r.order,
        created_at: r.created_at,
      };
    });
    const present = new Set(rules.map((r) => r.id));
    const fresh = SEED_RULES.filter((s) => !present.has(s.id)).map((r) => ({
      ...r,
      created_at: Date.now(),
    }));
    rules = [...rules, ...fresh].sort((a, b) => a.order - b.order);
    writeRaw(rules);
    try {
      localStorage.setItem(SEED_MARKER_KEY, "1");
    } catch {
      // ignore
    }
  }
  return rules.slice().sort((a, b) => a.order - b.order);
}

export function saveTransformers(rules: TransformerRule[]): void {
  writeRaw(rules.slice().sort((a, b) => a.order - b.order));
}

export function newRuleId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function emptyRule(order: number): TransformerRule {
  return {
    id: newRuleId(),
    name: "New rule",
    engine: "regex",
    enabled: true,
    order,
    pattern: "",
    flags: "",
    output: {},
    created_at: Date.now(),
  };
}

export function resetBuiltins(current: TransformerRule[]): TransformerRule[] {
  const userOnly = current.filter((r) => !r.seeded);
  const fresh = SEED_RULES.map((r) => ({ ...r, created_at: Date.now() }));
  const next = [...userOnly, ...fresh].sort((a, b) => a.order - b.order);
  writeRaw(next);
  return next;
}

export interface CompiledRule {
  rule: TransformerRule;
  re: RegExp | null;
  error?: string;
}

export function compileRules(rules: TransformerRule[]): CompiledRule[] {
  return rules
    .filter((r) => r.enabled)
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

export function compileSingle(rule: TransformerRule): CompiledRule {
  try {
    return { rule, re: new RegExp(rule.pattern, rule.flags ?? "") };
  } catch (e) {
    return { rule, re: null, error: (e as Error).message };
  }
}

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
    case "fatal":
    case "panic":
    case "crit":
    case "critical":
      return "error";
    case "warning":
      return "warn";
    case "notice":
      return "info";
    case "dbg":
      return "debug";
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
