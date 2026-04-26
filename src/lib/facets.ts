import {
  extractKeyOrValues,
  flattenAnd,
  isError,
  parse,
  renderAst,
  renderValue,
  type Ast,
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
  const sourceGroup = group("source", "Source", events, (e) => [e.source]);
  // Single-source case: don't bother with the facet — there's nothing
  // to filter and it's redundant with the (also-hidden) row column.
  if (sourceGroup.values.length > 1) groups.push(sourceGroup);

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
  return `${key}:${renderValue(value)}`;
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

export interface RangeBucket {
  lo: number;
  hi: number;
  label: string;
}

const EPS = 1e-9;
const closeEnough = (a: number, b: number) => {
  if (a === b) return true; // covers Infinity == Infinity
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) < EPS;
};
const sameRange = (a: RangeBucket, b: { lo: number; hi: number }) =>
  closeEnough(a.lo, b.lo) && closeEnough(a.hi, b.hi);

/// Format a single bucket as a parser-round-trippable clause:
/// \`(field:>=lo AND field:<hi)\`. Open-ended bounds drop the
/// corresponding side.
function formatRangeClause(key: string, lo: number, hi: number): string {
  const parts: string[] = [];
  if (Number.isFinite(lo)) parts.push(`${key}:>=${lo}`);
  if (Number.isFinite(hi)) parts.push(`${key}:<${hi}`);
  if (parts.length === 0) return ""; // unbounded: nothing to filter
  if (parts.length === 1) return parts[0]!;
  return `(${parts.join(" AND ")})`;
}

/// Pull all numeric range pairs (>= lo, < hi) for \`key\` out of an
/// AST node. Handles:
///   - bare \`key:>=N\` or \`key:<M\` (returns one-sided range)
///   - bare \`key:>=N AND key:<M\` (single bucket, intersected)
///   - top-level OR-chain of such pairs (multiple buckets)
function extractRanges(ast: Ast, key: string): { lo: number; hi: number }[] {
  if (ast.kind === "or") {
    const left = extractRanges(ast.left, key);
    const right = extractRanges(ast.right, key);
    if (left.length > 0 && right.length > 0) return [...left, ...right];
    return [];
  }
  let lo: number = -Infinity;
  let hi: number = Infinity;
  let touched = false;
  let foreign = false;
  const walk = (a: Ast) => {
    if (a.kind === "and") {
      walk(a.left);
      walk(a.right);
      return;
    }
    if (a.kind === "key_cmp" && a.key === key) {
      touched = true;
      if (a.op === "gte") lo = Math.max(lo, a.value);
      if (a.op === "gt") lo = Math.max(lo, a.value);
      if (a.op === "lt") hi = Math.min(hi, a.value);
      if (a.op === "lte") hi = Math.min(hi, a.value);
      return;
    }
    foreign = true;
  };
  walk(ast);
  if (!touched || foreign) return [];
  return [{ lo, hi }];
}

/// Walk top-level conjuncts, pull out all range pieces for \`key\`,
/// and intersect any one-sided partials into bucket-shaped ranges.
/// Returns the consolidated range list plus the conjuncts that
/// did NOT contribute (foreign clauses to keep AND-joined).
function partitionConjuncts(
  conjuncts: Ast[],
  key: string,
): { ranges: { lo: number; hi: number }[]; others: Ast[] } {
  const ranges: { lo: number; hi: number }[] = [];
  const partials: { lo: number; hi: number }[] = [];
  const others: Ast[] = [];
  for (const c of conjuncts) {
    if (c.kind === "or") {
      const r = extractRanges(c, key);
      if (r.length > 0) ranges.push(...r);
      else others.push(c);
      continue;
    }
    if (c.kind === "key_cmp" && c.key === key) {
      const r = extractRanges(c, key);
      if (r.length > 0) partials.push(r[0]!);
      else others.push(c);
      continue;
    }
    others.push(c);
  }
  // Intersect all one-sided partials into one bucket. Top-level AND
  // semantics: every conjunct must hold, so bounds tighten.
  if (partials.length > 0) {
    let lo = -Infinity;
    let hi = Infinity;
    for (const p of partials) {
      lo = Math.max(lo, p.lo);
      hi = Math.min(hi, p.hi);
    }
    ranges.push({ lo, hi });
  }
  return { ranges, others };
}

/// Toggle a percentile bucket selection for a numeric facet. Multiple
/// active buckets are OR-joined; clearing the last bucket drops the
/// clause entirely. Cross-key clauses stay AND-joined.
export function toggleFacetRange(
  query: string,
  key: string,
  bucket: RangeBucket,
): string {
  const ast = parse(query);
  const isEmpty = !isError(ast) && ast.kind === "free" && ast.term === "";
  if (isError(ast) || isEmpty) {
    return formatRangeClause(key, bucket.lo, bucket.hi);
  }
  const conjuncts = flattenAnd(ast);
  const { ranges: collected, others } = partitionConjuncts(conjuncts, key);

  const idx = collected.findIndex((r) => sameRange(bucket, r));
  if (idx >= 0) collected.splice(idx, 1);
  else collected.push({ lo: bucket.lo, hi: bucket.hi });

  const otherText = others.map(renderAst).join(" AND ");
  if (collected.length === 0) return otherText;
  const rangeText =
    collected.length === 1
      ? formatRangeClause(key, collected[0]!.lo, collected[0]!.hi)
      : `(${collected
          .map((r) => formatRangeClause(key, r.lo, r.hi))
          .join(" OR ")})`;
  if (!otherText) return rangeText;
  return `${otherText} AND ${rangeText}`;
}

/// Which buckets out of \`buckets\` are currently active for \`key\` in
/// \`query\`? Used to render checked state in the UI.
export function activeBuckets(
  query: string,
  key: string,
  buckets: RangeBucket[],
): Set<string> {
  const out = new Set<string>();
  const ast = parse(query);
  if (isError(ast)) return out;
  const conjuncts = flattenAnd(ast);
  const { ranges } = partitionConjuncts(conjuncts, key);
  for (const b of buckets) {
    if (ranges.some((r) => sameRange(b, r))) out.add(b.label);
  }
  return out;
}
