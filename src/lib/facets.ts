import {
  detectTimestampMs,
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

/// Cross-cutting autocomplete match. Emitted by `FacetIndex.suggest()`
/// when the user types a bare substring in the filter input.
export interface SuggestionMatch {
  kind: "key" | "kv" | "msg";
  key?: string;
  value?: string;
  msg?: string;
  score: number;
}

const TOP_N_KEYS = 5;
const ALL_KEYS_CAP = 50;
const TOP_N_VALUES = 50;
/// At suggest time, ignore field paths whose value Map exceeds this.
/// Fields like request_id / trace_id grow ~1:1 with events and aren't
/// useful for substring autocomplete — they'd flood the dropdown and
/// dominate the scan. Mirrored top-level fields are already excluded
/// from `fieldCounts` via `MIRRORED_KEYS` below.
const PER_FIELD_VALUE_CAP = 1000;
// Top-level event fields are mirrored into facet groups
// (Level / Source / Branch) explicitly. Skip them in auto-discovery so
// they don't show up twice when the JSON payload also carries the value.
const MIRRORED_KEYS = new Set(["level", "source", "branch", "msg", "raw", "ts", "id", "timestamp"]);

/// A field whose values are timestamps is useless as a facet — every
/// event lands in its own bucket. Detect at index time (cheap leaf-key
/// check) and skip indexing entirely. A value-shape backstop in
/// `snapshot()` catches anything that slips through under a custom
/// key name.
const TS_DIM_LEAVES = new Set([
  "ts",
  "timestamp",
  "time",
  "created_at",
  "updated_at",
  "started_at",
  "ended_at",
  "expires_at",
  "deleted_at",
]);
const TS_DIM_SUFFIX = /(^|_)(at|ts|time)$/i;

function leafOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i < 0 ? path : path.slice(i + 1);
}

function isTimestampDimensionKey(path: string): boolean {
  const leaf = leafOf(path);
  return TS_DIM_LEAVES.has(leaf) || TS_DIM_SUFFIX.test(leaf);
}

// Heuristic priority list for auto-discovered keys. Lower index =
// higher priority. Anything not listed inherits Infinity and falls
// back to cardinality-rank order.
const KEY_PRIORITY = [
  "method",
  "status_code",
  "status",
  "code",
  "path",
  "endpoint",
  "url",
  "request_id",
  "trace_id",
  "user.id",
  "user_id",
];
const PRIORITY_RANK = new Map(KEY_PRIORITY.map((k, i) => [k, i]));

/// Incremental facet store. The full-array `computeFacets()` below
/// stays for cold-start / tests, but the live UI maintains a single
/// `FacetIndex` and feeds it per-event deltas. Snapshot then assembles
/// `FacetGroup[]` in the same shape `computeFacets()` returns, so
/// consumers don't need to know which path produced it.
///
/// Counts of distinct field paths are bounded by event payload shape,
/// not by the ring size — adding/removing one event is O(payload
/// depth), not O(n).
export class FacetIndex {
  private levelCounts = new Map<string, number>();
  private sourceCounts = new Map<string, number>();
  private branchCounts = new Map<string, number>();
  /// Auto-discovered fields: path → (value → count).
  private fieldCounts = new Map<string, Map<string, number>>();
  /// Trigram inverted index over distinct msg strings.
  /// `msgRefs` is the refcount per distinct msg (events alive with that
  /// msg); when it drops to 0 the trigrams are released. `msgTrigrams`
  /// maps each lowercased length-3 ngram to the set of msgs containing
  /// it, supporting O(query) substring autocomplete across the full
  /// ring without scanning every event.
  private msgRefs = new Map<string, number>();
  private msgTrigrams = new Map<string, Set<string>>();
  /// Queries shorter than this skip the trigram path and fall back to a
  /// linear scan over `msgRefs.keys()` (bounded by distinct-msg count,
  /// not event count).
  private readonly MSG_FALLBACK_LEN = 3;

  private *trigramsOf(s: string): Iterable<string> {
    const lower = s.toLowerCase();
    if (lower.length < 3) {
      yield `short:${lower}`;
      return;
    }
    for (let i = 0; i <= lower.length - 3; i++) yield lower.slice(i, i + 3);
  }

  add(e: LogEvent): void {
    bump(this.levelCounts, e.level);
    bump(this.sourceCounts, e.source);
    if (e.branch) bump(this.branchCounts, e.branch);
    const fields = e.fields as Record<string, unknown> | undefined;
    if (fields && typeof fields === "object") {
      walkPaths(fields, "", (path, value) => {
        if (MIRRORED_KEYS.has(path)) return;
        if (isTimestampDimensionKey(path)) return;
        let m = this.fieldCounts.get(path);
        if (!m) {
          m = new Map();
          this.fieldCounts.set(path, m);
        }
        bump(m, String(value ?? ""));
      });
    }
    const msg = e.msg ?? "";
    if (msg.length > 0) {
      const prev = this.msgRefs.get(msg) ?? 0;
      this.msgRefs.set(msg, prev + 1);
      if (prev === 0) {
        for (const tg of this.trigramsOf(msg)) {
          let s = this.msgTrigrams.get(tg);
          if (!s) {
            s = new Set();
            this.msgTrigrams.set(tg, s);
          }
          s.add(msg);
        }
      }
    }
  }

  remove(e: LogEvent): void {
    drop(this.levelCounts, e.level);
    drop(this.sourceCounts, e.source);
    if (e.branch) drop(this.branchCounts, e.branch);
    const fields = e.fields as Record<string, unknown> | undefined;
    if (fields && typeof fields === "object") {
      walkPaths(fields, "", (path, value) => {
        if (MIRRORED_KEYS.has(path)) return;
        if (isTimestampDimensionKey(path)) return;
        const m = this.fieldCounts.get(path);
        if (!m) return;
        drop(m, String(value ?? ""));
        if (m.size === 0) this.fieldCounts.delete(path);
      });
    }
    const msg = e.msg ?? "";
    if (msg.length > 0) {
      const prev = this.msgRefs.get(msg);
      if (prev !== undefined) {
        if (prev <= 1) {
          this.msgRefs.delete(msg);
          for (const tg of this.trigramsOf(msg)) {
            const s = this.msgTrigrams.get(tg);
            if (!s) continue;
            s.delete(msg);
            if (s.size === 0) this.msgTrigrams.delete(tg);
          }
        } else {
          this.msgRefs.set(msg, prev - 1);
        }
      }
    }
  }

  clear(): void {
    this.levelCounts.clear();
    this.sourceCounts.clear();
    this.branchCounts.clear();
    this.fieldCounts.clear();
    this.msgRefs.clear();
    this.msgTrigrams.clear();
  }

  /// Return msgs matching `q` as substring. Length-3+ queries use the
  /// trigram index; shorter queries linear-scan the distinct msg set.
  /// Caller-provided `cap` bounds the candidate harvest (the result is
  /// usually further ranked + trimmed by `suggest`).
  private queryMsgs(q: string, cap: number): string[] {
    const ql = q.toLowerCase();
    if (ql.length === 0) return [];
    if (ql.length < this.MSG_FALLBACK_LEN) {
      const out: string[] = [];
      for (const msg of this.msgRefs.keys()) {
        if (msg.toLowerCase().includes(ql)) {
          out.push(msg);
          if (out.length >= cap) break;
        }
      }
      return out;
    }
    const tgs = [...new Set(this.trigramsOf(ql))];
    const lists: Set<string>[] = [];
    for (const tg of tgs) {
      const s = this.msgTrigrams.get(tg);
      if (!s) return []; // any missing trigram → no possible match
      lists.push(s);
    }
    lists.sort((a, b) => a.size - b.size);
    // Trigram membership is necessary but not sufficient for substring
    // (e.g., q="abcd" → trigrams "abc","bcd" both appear in "abc-bcd"
    // without "abcd" as substring), so final .includes() verify runs.
    const out: string[] = [];
    for (const candidate of lists[0]!) {
      let inAll = true;
      for (let i = 1; i < lists.length; i++) {
        if (!lists[i]!.has(candidate)) {
          inAll = false;
          break;
        }
      }
      if (!inAll) continue;
      if (!candidate.toLowerCase().includes(ql)) continue;
      out.push(candidate);
      if (out.length >= cap) break;
    }
    return out;
  }

  /// Cross-cutting autocomplete: given a bare substring (no key:),
  /// surface matching keys, key:value pairs, and msg strings. Returns
  /// up to `limit` items already ranked and merged in render order.
  ///
  /// Returns `[]` for queries shorter than 2 chars — caller falls back
  /// to the existing prefix-key suggestion path.
  suggest(query: string, limit = 8): SuggestionMatch[] {
    const q = query.toLowerCase();
    if (q.length < 2) return [];

    // ── Keys ─────────────────────────────────────────────────────
    // Walk the union of mirrored top-level keys and discovered field
    // paths. Prefix match scores highest; substring at a `.`-segment
    // boundary beats mid-segment substring.
    const allKeys = new Set<string>();
    for (const k of ["msg", "raw", "ts", "level", "source", "branch"]) allKeys.add(k);
    for (const k of this.fieldCounts.keys()) allKeys.add(k);
    const keyHits: SuggestionMatch[] = [];
    for (const k of allKeys) {
      const lk = k.toLowerCase();
      const idx = lk.indexOf(q);
      if (idx < 0) continue;
      let score = 5;
      if (idx === 0) score = 20;
      else if (lk[idx - 1] === ".") score = 10;
      keyHits.push({ kind: "key", key: k, score });
    }
    keyHits.sort((a, b) => b.score - a.score || a.key!.localeCompare(b.key!));

    // ── Key:value ────────────────────────────────────────────────
    // For each field path with bounded cardinality, find values whose
    // lowercased form contains `q`. Keep top-2 per path so one chatty
    // path (e.g. `path`, `endpoint`) can't drown the dropdown.
    const kvHits: SuggestionMatch[] = [];
    for (const [path, valueMap] of this.fieldCounts) {
      if (valueMap.size > PER_FIELD_VALUE_CAP) continue;
      const perKey: SuggestionMatch[] = [];
      for (const [value, count] of valueMap) {
        const lv = value.toLowerCase();
        const idx = lv.indexOf(q);
        if (idx < 0) continue;
        const score = Math.log1p(count) + 3 + (idx === 0 ? 10 : 0);
        perKey.push({ kind: "kv", key: path, value, score });
      }
      perKey.sort((a, b) => b.score - a.score || a.value!.localeCompare(b.value!));
      for (let i = 0; i < Math.min(2, perKey.length); i++) kvHits.push(perKey[i]!);
    }
    kvHits.sort(
      (a, b) => b.score - a.score || `${a.key}:${a.value}`.localeCompare(`${b.key}:${b.value}`)
    );

    // ── Msg ──────────────────────────────────────────────────────
    const msgs = this.queryMsgs(q, limit * 4);
    const msgHits: SuggestionMatch[] = [];
    for (const m of msgs) {
      const startsWith = m.toLowerCase().startsWith(q);
      const refs = this.msgRefs.get(m) ?? 0;
      const score = Math.log1p(refs) + (startsWith ? 6 : 2);
      msgHits.push({ kind: "msg", msg: m, score });
    }
    msgHits.sort((a, b) => b.score - a.score || a.msg!.localeCompare(b.msg!));

    // ── Merge by category ────────────────────────────────────────
    const out: SuggestionMatch[] = [];
    const keyCap = Math.min(keyHits.length, 3);
    const kvCap = Math.min(kvHits.length, Math.max(2, limit - keyCap - 3));
    const msgCap = Math.min(msgHits.length, 3);
    for (let i = 0; i < keyCap; i++) out.push(keyHits[i]!);
    for (let i = 0; i < kvCap; i++) out.push(kvHits[i]!);
    for (let i = 0; i < msgCap; i++) out.push(msgHits[i]!);
    return out.slice(0, limit);
  }

  snapshot(): FacetGroup[] {
    const groups: FacetGroup[] = [];
    groups.push(materialize("level", "Level", this.levelCounts));
    const src = materialize("source", "Source", this.sourceCounts);
    if (src.values.length > 1) groups.push(src);
    const br = materialize("branch", "Branch", this.branchCounts);
    if (br.values.length > 0) groups.push(br);

    const ranked = [...this.fieldCounts.entries()]
      .filter(([k, m]) => m.size > 1 && !groupLooksLikeTimestamps(k, m))
      .toSorted((a, b) => {
        const ra = PRIORITY_RANK.get(a[0]) ?? Number.POSITIVE_INFINITY;
        const rb = PRIORITY_RANK.get(b[0]) ?? Number.POSITIVE_INFINITY;
        if (ra !== rb) return ra - rb;
        return b[1].size - a[1].size;
      })
      .slice(0, ALL_KEYS_CAP)
      .map(([k]) => k);

    for (const key of ranked) {
      groups.push(materialize(key, prettyKey(key), this.fieldCounts.get(key)!));
    }
    return groups;
  }
}

/// Backstop for custom-named fields that carry timestamp values. The
/// leaf-key check in `isTimestampDimensionKey` covers conventional
/// names; this peeks at one sample value and treats the group as time
/// if it parses as plausible unix-ms.
function groupLooksLikeTimestamps(key: string, counts: Map<string, number>): boolean {
  if (isTimestampDimensionKey(key)) return true;
  const first = counts.keys().next().value;
  if (first == null) return false;
  return detectTimestampMs(key, first) != null;
}

function setLooksLikeTimestamps(key: string, set: Set<string>): boolean {
  const first = set.values().next().value;
  if (first == null) return false;
  return detectTimestampMs(key, first) != null;
}

function bump(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1);
}

function drop(m: Map<string, number>, key: string): void {
  const n = m.get(key);
  if (n == null) return;
  if (n <= 1) m.delete(key);
  else m.set(key, n - 1);
}

function materialize(key: string, label: string, counts: Map<string, number>): FacetGroup {
  const values: FacetValue[] = [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .toSorted((a, b) => b.count - a.count)
    .slice(0, TOP_N_VALUES);
  return { key, label, values };
}

/// Compute facet groups from a list of events. Always emits Level
/// and Source first; then auto-discovered JSON keys ordered by
/// cardinality (count of distinct values × frequency). Returns
/// up to ALL_KEYS_CAP groups; the UI can decide how many to show
/// at a time vs surface via search.
export function computeFacets(events: LogEvent[]): FacetGroup[] {
  const groups: FacetGroup[] = [];

  groups.push(group("level", "Level", events, (e) => [e.level]));
  const sourceGroup = group("source", "Source", events, (e) => [e.source]);
  if (sourceGroup.values.length > 1) groups.push(sourceGroup);
  // Show the Branch group whenever at least one non-empty branch is
  // present, even when there's only one — branch is identity-level
  // metadata users want visible, not a "filter only when ambiguous"
  // facet like Source.
  const branchGroup = group("branch", "Branch", events, (e) => (e.branch ? [e.branch] : []));
  if (branchGroup.values.length > 0) groups.push(branchGroup);

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
    // Skip top-level mirrors and degenerate single-value keys.
    // Numeric / high-cardinality keys (status_code, dur_ms, ids) are
    // surfaced too — the cardinality cap previously dropped them
    // outright, which hid useful range facets like dur_ms.
    // Timestamp-dimension fields are also dropped — every value is a
    // unique bucket, useless to filter on.
    .filter(
      ([k, set]) =>
        set.size > 1 &&
        !MIRRORED_KEYS.has(k) &&
        !isTimestampDimensionKey(k) &&
        !setLooksLikeTimestamps(k, set)
    )
    // Two-stage sort: KEY_PRIORITY heuristic first, then by raw
    // cardinality. So method/status_code/path land at the top
    // regardless of how many distinct values they have, while
    // unknown keys still fall back to cardinality.
    .toSorted((a, b) => {
      const ra = PRIORITY_RANK.get(a[0]) ?? Number.POSITIVE_INFINITY;
      const rb = PRIORITY_RANK.get(b[0]) ?? Number.POSITIVE_INFINITY;
      if (ra !== rb) return ra - rb;
      return b[1].size - a[1].size;
    })
    .slice(0, ALL_KEYS_CAP)
    .map(([k]) => k);

  for (const key of ranked) {
    groups.push(
      group(key, prettyKey(key), events, (e) => {
        const v = lookupPath(e.fields, key);
        if (v == null) return [];
        return [String(v)];
      })
    );
  }

  return groups;
}

export const TOP_N_FACET_GROUPS = TOP_N_KEYS + 2; // level + source + top N

function group(
  key: string,
  label: string,
  events: LogEvent[],
  pluck: (e: LogEvent) => string[]
): FacetGroup {
  const counts = new Map<string, number>();
  for (const e of events) {
    for (const v of pluck(e)) {
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
  const values: FacetValue[] = [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .toSorted((a, b) => b.count - a.count)
    .slice(0, TOP_N_VALUES);
  return { key, label, values };
}

function walkPaths(
  obj: Record<string, unknown>,
  prefix: string,
  emit: (path: string, value: unknown) => void
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
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[part];
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

/// True iff `key:value` is one of the active selections in `query`,
/// using the same semantics as `toggleFacetOr` — a value counts as
/// active when it appears as a top-level conjunct or inside a
/// top-level OR-chain of `key:vN` bindings. NOT clauses are exclusion
/// and don't count. Use this anywhere the UI needs to highlight a
/// term as "currently being filtered for".
export function isFacetActive(query: string, key: string, value: string): boolean {
  const ast = parse(query);
  if (isError(ast)) return false;
  if (ast.kind === "free" && ast.term === "") return false;
  for (const c of flattenAnd(ast)) {
    const vals = extractKeyOrValues(c, key);
    if (vals && vals.includes(value)) return true;
  }
  return false;
}

/// Append a `key:value` clause to a query string. If query is empty
/// or only whitespace, the clause becomes the whole query.
export function addClause(query: string, key: string, value: string): string {
  const clause = formatClause(key, value);
  if (!query.trim()) return clause;
  return `${query.trim()} AND ${clause}`;
}

/// Append a `NOT clause` to a query string, AND-joined.
export function addNotClause(query: string, clause: string): string {
  if (!query.trim()) return `NOT ${clause}`;
  return `${query.trim()} AND NOT ${clause}`;
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
export function toggleFacetOr(query: string, key: string, value: string): string {
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
  key: string
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
export function toggleFacetRange(query: string, key: string, bucket: RangeBucket): string {
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
      : `(${collected.map((r) => formatRangeClause(key, r.lo, r.hi)).join(" OR ")})`;
  if (!otherText) return rangeText;
  return `${otherText} AND ${rangeText}`;
}

/// Which buckets out of \`buckets\` are currently active for \`key\` in
/// \`query\`? Used to render checked state in the UI.
/// Toggle a percentile threshold clause for \`key\`. Multi-select OR-
/// joined as \`(key:>=percentile(p1) OR key:>=percentile(p2))\`.
export function toggleFacetPct(query: string, key: string, p: number): string {
  const ast = parse(query);
  const isEmpty = !isError(ast) && ast.kind === "free" && ast.term === "";
  const seed = `${key}:>=percentile(${p})`;
  if (isError(ast) || isEmpty) return seed;
  const conjuncts = flattenAnd(ast);
  const others: Ast[] = [];
  const collected = new Set<number>();
  for (const c of conjuncts) {
    const ps = extractPctArgs(c, key);
    if (ps.length > 0) for (const x of ps) collected.add(x);
    else others.push(c);
  }
  if (collected.has(p)) collected.delete(p);
  else collected.add(p);
  const otherText = others.map(renderAst).join(" AND ");
  if (collected.size === 0) return otherText;
  const sorted = [...collected].toSorted((a, b) => a - b);
  const clauses = sorted.map((x) => `${key}:>=percentile(${x})`);
  const joined = clauses.length === 1 ? clauses[0]! : `(${clauses.join(" OR ")})`;
  return otherText ? `${otherText} AND ${joined}` : joined;
}

/// Walk a node and pull all percentile args bound to \`key:>=\`.
function extractPctArgs(ast: Ast, key: string): number[] {
  if (ast.kind === "or") {
    const left = extractPctArgs(ast.left, key);
    const right = extractPctArgs(ast.right, key);
    if (left.length > 0 && right.length > 0) return [...left, ...right];
    return [];
  }
  if (
    ast.kind === "key_cmp_fn" &&
    ast.key === key &&
    ast.fn === "percentile" &&
    (ast.op === "gte" || ast.op === "gt")
  ) {
    return [ast.arg];
  }
  return [];
}

export function activePctSet(query: string, key: string): Set<number> {
  const out = new Set<number>();
  const ast = parse(query);
  if (isError(ast)) return out;
  const conjuncts = flattenAnd(ast);
  for (const c of conjuncts) for (const p of extractPctArgs(c, key)) out.add(p);
  return out;
}

export function activeBuckets(query: string, key: string, buckets: RangeBucket[]): Set<string> {
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
