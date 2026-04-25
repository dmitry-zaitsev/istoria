import type { Ast } from "./query";
import {
  extractKeyOrValues,
  flattenAnd,
  isError,
  parse,
  renderAst,
} from "./query";
import type { LogEvent } from "./ipc";

export interface FacetValue {
  value: string;
  count: number;
}

export interface FacetGroup {
  key: string;
  label: string;
  values: FacetValue[];
}

const TOP_N_KEYS = 5;
const TOP_N_VALUES = 50;

/// Compute facet groups from a list of events. Always emits Level
/// and Source first; then auto-discovered JSON keys ordered by
/// cardinality (count of distinct values × frequency).
export function computeFacets(events: LogEvent[]): FacetGroup[] {
  const groups: FacetGroup[] = [];

  groups.push(group("level", "Level", events, (e) => [e.level]));
  groups.push(group("source", "Source", events, (e) => [e.source]));

  // Top-N JSON keys by cardinality
  const keyStats = new Map<string, Set<string>>();
  for (const e of events) {
    const fields = e.fields as Record<string, unknown> | undefined;
    if (!fields || typeof fields !== "object") continue;
    walkPaths(fields, "", (path, value) => {
      const v = String(value ?? "");
      let set = keyStats.get(path);
      if (!set) {
        set = new Set();
        keyStats.set(path, set);
      }
      set.add(v);
    });
  }
  const ranked = [...keyStats.entries()]
    .filter(([, set]) => set.size > 1 && set.size <= 200)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, TOP_N_KEYS)
    .map(([k]) => k);

  for (const key of ranked) {
    groups.push(
      group(key, prettyKey(key), events, (e) => {
        const v = lookupPath(e.fields, key);
        if (v == null) return [];
        return [String(v)];
      }),
    );
  }

  return groups;
}

function group(
  key: string,
  label: string,
  events: LogEvent[],
  pluck: (e: LogEvent) => string[],
): FacetGroup {
  const counts = new Map<string, number>();
  for (const e of events) {
    for (const v of pluck(e)) {
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
  const values: FacetValue[] = [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_N_VALUES);
  return { key, label, values };
}

function walkPaths(
  obj: Record<string, unknown>,
  prefix: string,
  emit: (path: string, value: unknown) => void,
): void {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      walkPaths(v as Record<string, unknown>, path, emit);
    } else {
      emit(path, v);
    }
  }
}

function lookupPath(fields: unknown, path: string): unknown {
  let cur = fields;
  for (const part of path.split(".")) {
    if (cur && typeof cur === "object")
      cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

function prettyKey(key: string): string {
  return key
    .split(".")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" · ");
}

/// Walk an AST and collect `key:value` selections so the facets UI
/// knows which values are pinned.
export function pinnedFromAst(ast: Ast | null): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!ast) return out;
  walk(ast, out);
  return out;
}

function walk(ast: Ast, out: Map<string, Set<string>>): void {
  switch (ast.kind) {
    case "key_exact": {
      let s = out.get(ast.key);
      if (!s) {
        s = new Set();
        out.set(ast.key, s);
      }
      s.add(ast.value);
      return;
    }
    case "and":
      walk(ast.left, out);
      walk(ast.right, out);
      return;
    case "or": {
      // OR of key:value clauses for the same key — record all values.
      walk(ast.left, out);
      walk(ast.right, out);
      return;
    }
    case "not":
      walk(ast.expr, out);
      return;
    default:
      return;
  }
}

/// Append a `key:value` clause to a query string. If query is empty
/// or only whitespace, the clause becomes the whole query.
export function addClause(query: string, key: string, value: string): string {
  const clause = formatClause(key, value);
  if (!query.trim()) return clause;
  return `${query.trim()} AND ${clause}`;
}

/// Remove a `key:value` clause from a query string. We work
/// textually since round-tripping through AST loses NOT/OR nuance.
export function removeClause(query: string, key: string, value: string): string {
  const clause = formatClause(key, value);
  // Patterns to strip: ` AND clause`, `clause AND `, or bare `clause`.
  const escaped = clause.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = query;
  out = out.replace(new RegExp(`\\s+AND\\s+${escaped}`, "g"), "");
  out = out.replace(new RegExp(`${escaped}\\s+AND\\s+`, "g"), "");
  out = out.replace(new RegExp(`^${escaped}$`), "").trim();
  return out;
}

function formatClause(key: string, value: string): string {
  // Quote values containing whitespace/parens.
  const needsQuotes = /[\s()"]/.test(value);
  return `${key}:${needsQuotes ? `"${value.replace(/"/g, '\\"')}"` : value}`;
}

/// Toggle a facet value for \`key\` while combining same-key selections
/// as OR. Existing nodes for the same key (bare or OR-chain of
/// \`key:v\`) are merged with the toggle target; everything else stays
/// AND-joined. Empty selection drops the clause entirely.
export function toggleFacetOr(
  query: string,
  key: string,
  value: string,
): string {
  const ast = parse(query);
  // Empty / unparseable: just emit the bare clause.
  if (isError(ast)) return formatClause(key, value);
  if (ast.kind === "free" && ast.term === "") {
    return formatClause(key, value);
  }
  const conjuncts = flattenAnd(ast);
  const otherConjuncts: Ast[] = [];
  const collected = new Set<string>();
  for (const c of conjuncts) {
    const vals = extractKeyOrValues(c, key);
    if (vals) {
      for (const v of vals) collected.add(v);
    } else {
      otherConjuncts.push(c);
    }
  }
  if (collected.has(value)) collected.delete(value);
  else collected.add(value);

  const otherText = otherConjuncts.map(renderAst).join(" AND ");
  if (collected.size === 0) return otherText;
  const sorted = [...collected];
  const keyClause =
    sorted.length === 1
      ? formatClause(key, sorted[0]!)
      : `(${sorted.map((v) => formatClause(key, v)).join(" OR ")})`;
  if (!otherText) return keyClause;
  return `${otherText} AND ${keyClause}`;
}
