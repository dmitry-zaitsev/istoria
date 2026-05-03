import type { Level, LogEvent } from "./ipc";
import rulesJson from "../../transformer_rules.json";

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

// Rules live in transformer_rules.json at the repo root so the Rust
// coalescer can read the same spec. See transformer_rules.README.md.
export const BUILTIN_TRANSFORMERS: TransformerRule[] = rulesJson as TransformerRule[];

export interface CompiledRule {
  rule: TransformerRule;
  re: RegExp | null;
  error?: string;
}

export function compileRules(rules: TransformerRule[]): CompiledRule[] {
  return rules
    .slice()
    .toSorted((a, b) => a.order - b.order)
    .map((rule) => {
      try {
        const re = new RegExp(rule.pattern, rule.flags ?? "");
        return { rule, re };
      } catch (e) {
        return { rule, re: null, error: (e as Error).message };
      }
    });
}

export const COMPILED_BUILTINS: CompiledRule[] = compileRules(BUILTIN_TRANSFORMERS);

const LEVELS: ReadonlySet<Level> = new Set(["error", "warn", "info", "debug", "trace"]);

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

function substitute(template: string, caps: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (_, name) => caps[name] ?? "");
}

function looksLikeJson(s: string): boolean {
  const t = s.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}

export function applyTransformers(ev: LogEvent, compiled: CompiledRule[]): LogEvent {
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
              for (const [k, val] of Object.entries(parsed as Record<string, unknown>)) {
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

export function applyAll(events: LogEvent[], compiled: CompiledRule[]): LogEvent[] {
  if (compiled.length === 0) return events;
  return events.map((e) => applyTransformers(e, compiled));
}
