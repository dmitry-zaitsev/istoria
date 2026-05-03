// Query AST type — mirrors the Rust definition in `src-tauri/src/query.rs`.
// Same semantics as the SQL lowering, evaluated client-side for live tail.

import type { LogEvent } from "./ipc";

export type CmpOp = "lt" | "lte" | "gt" | "gte";

export type Ast =
  | { kind: "key_exact"; key: string; value: string }
  | { kind: "key_cmp"; key: string; op: CmpOp; value: number }
  | {
      kind: "key_cmp_fn";
      key: string;
      op: CmpOp;
      fn: "percentile" | "last";
      arg: number;
      argText?: string;
    }
  | { kind: "key_regex"; key: string; pattern: string }
  | { kind: "free"; term: string }
  | { kind: "and"; left: Ast; right: Ast }
  | { kind: "or"; left: Ast; right: Ast }
  | { kind: "not"; expr: Ast };

export interface ParseError {
  message: string;
  pos: number;
}

export interface Token {
  kind: "key_exact" | "key_cmp" | "key_regex" | "free" | "op" | "group";
  text: string;
}

interface Cursor {
  src: string;
  pos: number;
}

function isWs(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

function eatWs(c: Cursor): void {
  while (c.pos < c.src.length && isWs(c.src[c.pos]!)) c.pos++;
}

function peek(c: Cursor): string | undefined {
  return c.src[c.pos];
}

function consumeIdent(c: Cursor): string {
  let s = "";
  while (c.pos < c.src.length) {
    const ch = c.src[c.pos]!;
    if (/[A-Za-z0-9._]/.test(ch)) {
      s += ch;
      c.pos++;
    } else break;
  }
  return s;
}

function consumeBareValue(c: Cursor): string {
  let s = "";
  while (c.pos < c.src.length) {
    const ch = c.src[c.pos]!;
    if (isWs(ch) || ch === "(" || ch === ")") break;
    s += ch;
    c.pos++;
  }
  return s;
}

function consumeQuoted(c: Cursor): string {
  c.pos++; // opening "
  let s = "";
  while (c.pos < c.src.length && c.src[c.pos] !== '"') {
    s += c.src[c.pos];
    c.pos++;
  }
  if (c.src[c.pos] === '"') c.pos++;
  return s;
}

function consumeRegex(c: Cursor): string {
  let s = "";
  while (c.pos < c.src.length) {
    const ch = c.src[c.pos]!;
    if (ch === "\\" && c.pos + 1 < c.src.length) {
      s += ch + c.src[c.pos + 1]!;
      c.pos += 2;
      continue;
    }
    if (ch === "/") break;
    s += ch;
    c.pos++;
  }
  return s;
}

export function parse(input: string): Ast | ParseError {
  if (!input.trim()) return { kind: "free", term: "" };
  const cur: Cursor = { src: input, pos: 0 };
  try {
    const ast = parseExpr(cur);
    eatWs(cur);
    if (cur.pos !== cur.src.length) {
      return { message: `unexpected '${cur.src[cur.pos]}'`, pos: cur.pos };
    }
    return ast;
  } catch (e) {
    return { message: (e as Error).message, pos: cur.pos };
  }
}

function parseExpr(c: Cursor): Ast {
  let left = parseAnd(c);
  for (;;) {
    eatWs(c);
    if (matchKeyword(c, "OR")) {
      const right = parseAnd(c);
      left = { kind: "or", left, right };
    } else break;
  }
  return left;
}

function parseAnd(c: Cursor): Ast {
  let left = parseUnary(c);
  for (;;) {
    eatWs(c);
    if (matchKeyword(c, "AND")) {
      const right = parseUnary(c);
      left = { kind: "and", left, right };
      continue;
    }
    // Implicit AND: adjacent atoms with no explicit connector get
    // AND-joined (e.g. \`request mismatch\` → both must match msg).
    // Stop on end-of-input, closing paren, or an OR that the parent
    // parseExpr is responsible for.
    if (c.pos >= c.src.length) break;
    if (peek(c) === ")") break;
    if (peekKeyword(c, "OR")) break;
    const right = parseUnary(c);
    left = { kind: "and", left, right };
  }
  return left;
}

function peekKeyword(c: Cursor, kw: string): boolean {
  const start = c.pos;
  const ok = matchKeyword(c, kw);
  c.pos = start;
  return ok;
}

function parseUnary(c: Cursor): Ast {
  eatWs(c);
  if (matchKeyword(c, "NOT")) {
    const expr = parseUnary(c);
    return { kind: "not", expr };
  }
  return parseAtom(c);
}

function parseAtom(c: Cursor): Ast {
  eatWs(c);
  if (peek(c) === "(") {
    c.pos++;
    const inner = parseExpr(c);
    eatWs(c);
    if (peek(c) !== ")") throw new Error("expected ')'");
    c.pos++;
    return inner;
  }
  // Try key:* / key~/regex/ / free
  const startPos = c.pos;
  const key = consumeIdent(c);
  if (key && peek(c) === "~") {
    c.pos++;
    if (peek(c) !== "/") {
      // not a regex; rewind and treat as free
      c.pos = startPos;
    } else {
      c.pos++;
      const pattern = consumeRegex(c);
      if (peek(c) !== "/") throw new Error("unterminated regex");
      c.pos++;
      return { kind: "key_regex", key, pattern };
    }
  }
  if (key && peek(c) === ":") {
    c.pos++;
    // Tolerate `key: value` with whitespace after the colon. Common
    // typing pattern; without this `relevant: true` falls back to two
    // free-term atoms and the filter silently matches nothing.
    eatWs(c);
    // numeric cmp?
    const cmp = matchCmpOp(c);
    if (cmp) {
      const fnNode = tryParseFnCall(c, key, cmp);
      if (fnNode) return fnNode;
      const numStart = c.pos;
      const numStr = peek(c) === '"' ? consumeQuoted(c) : consumeBareValue(c);
      const value = parseNumberOrDate(numStr);
      if (value == null)
        throw new Error(`expected number or datetime, got '${numStr}' at ${numStart}`);
      return { kind: "key_cmp", key, op: cmp, value };
    }
    // No cmp op — but maybe shorthand `ts:duration(15 min)` which
    // implies "within the last 15 min" → expands to ts:>=now-15min.
    {
      const fnNode = tryParseFnCall(c, key, "gte");
      if (fnNode) return fnNode;
    }
    const value = peek(c) === '"' ? consumeQuoted(c) : consumeBareValue(c);
    if (!value) {
      // empty value → treat token as free `key:`
      c.pos = startPos;
      const term = consumeBareValue(c);
      return { kind: "free", term };
    }
    return { kind: "key_exact", key, value };
  }
  // Free term — rewind to startPos and consume non-ws.
  // A leading `"` opens a quoted free term so multi-word substrings
  // (e.g. `"query result"`) stay as one search term instead of
  // collapsing into N implicit-AND'd singletons.
  c.pos = startPos;
  if (peek(c) === '"') {
    const quoted = consumeQuoted(c);
    return { kind: "free", term: quoted };
  }
  const term = consumeBareValue(c);
  if (!term) throw new Error("expected expression");
  if (term === "AND" || term === "OR" || term === "NOT")
    throw new Error(`operator '${term}' in atom position`);
  return { kind: "free", term };
}

function matchKeyword(c: Cursor, kw: string): boolean {
  eatWs(c);
  const next = c.src.slice(c.pos, c.pos + kw.length);
  if (next !== kw) return false;
  // ensure not part of identifier
  const after = c.src[c.pos + kw.length];
  if (after && /[A-Za-z0-9._]/.test(after)) return false;
  c.pos += kw.length;
  return true;
}

function matchCmpOp(c: Cursor): CmpOp | null {
  if (c.src.slice(c.pos, c.pos + 2) === ">=") {
    c.pos += 2;
    return "gte";
  }
  if (c.src.slice(c.pos, c.pos + 2) === "<=") {
    c.pos += 2;
    return "lte";
  }
  if (c.src[c.pos] === ">") {
    c.pos++;
    return "gt";
  }
  if (c.src[c.pos] === "<") {
    c.pos++;
    return "lt";
  }
  return null;
}

/// Parse a comparison RHS as either a JS number or a date-like
/// string. Date-like values resolve to Unix ms via Date.parse so the
/// AST stays uniformly numeric. Accepts shorthand human forms:
///   `14:02`, `14:02:31`, `14:02:31.500` → today at that time
///   `May 6`, `May 6 14:02` → most-recent past May 6
function parseNumberOrDate(s: string): number | null {
  const trimmed = s.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isNaN(n)) return n;
  const smart = parseSmartDate(trimmed);
  if (smart != null) return smart;
  const ms = Date.parse(trimmed);
  if (!Number.isNaN(ms)) return ms;
  return null;
}

export function parseSmartDate(s: string, ref = new Date()): number | null {
  // HH:MM[:SS[.mmm]] → today at that time
  const t = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if (t) {
    const d = new Date(ref);
    d.setHours(+t[1]!, +t[2]!, t[3] ? +t[3] : 0, t[4] ? +t[4]!.padEnd(3, "0") : 0);
    return d.getTime();
  }
  // `Mon D[ HH:MM[:SS]]` → most recent occurrence on or before ref.
  const m = s.match(/^([A-Za-z]{3})\s+(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const idx = MONTHS_SHORT.findIndex((mn) => mn.toLowerCase() === m[1]!.toLowerCase());
    if (idx < 0) return null;
    const day = +m[2]!;
    const hh = m[3] ? +m[3] : 0;
    const mm = m[4] ? +m[4] : 0;
    const ss = m[5] ? +m[5] : 0;
    let cand = new Date(ref.getFullYear(), idx, day, hh, mm, ss);
    if (cand.getTime() > ref.getTime()) {
      cand = new Date(ref.getFullYear() - 1, idx, day, hh, mm, ss);
    }
    return cand.getTime();
  }
  return null;
}

/// Recognize `percentile(N)` or `duration(N unit)` after the cmp
/// position. Returns null if the cursor doesn't sit at a function
/// call. Consumes through the closing paren on success.
function tryParseFnCall(c: Cursor, key: string, op: CmpOp): Ast | null {
  if (c.src.startsWith("percentile(", c.pos)) {
    c.pos += "percentile(".length;
    const inner = readUntil(c, ")");
    if (peek(c) === ")") c.pos++;
    const arg = Number(inner.trim());
    if (Number.isNaN(arg) || arg < 0 || arg > 100)
      throw new Error(`percentile expects 0..100, got '${inner}'`);
    return { kind: "key_cmp_fn", key, op, fn: "percentile", arg };
  }
  if (c.src.startsWith("last(", c.pos)) {
    c.pos += "last(".length;
    const inner = readUntil(c, ")");
    if (peek(c) === ")") c.pos++;
    const ms = parseDurationMs(inner.trim());
    if (ms == null) throw new Error(`last expects \`N unit\`, got '${inner}'`);
    return {
      kind: "key_cmp_fn",
      key,
      op,
      fn: "last",
      arg: ms,
      argText: inner.trim(),
    };
  }
  return null;
}

function readUntil(c: Cursor, ch: string): string {
  let s = "";
  while (c.pos < c.src.length && c.src[c.pos] !== ch) {
    s += c.src[c.pos];
    c.pos++;
  }
  return s;
}

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

function parseDurationMs(s: string): number | null {
  const m = s.match(/^([\d.]+)\s*([A-Za-z]+)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (Number.isNaN(n)) return null;
  const mult = DURATION_UNITS[m[2]!.toLowerCase()];
  if (mult == null) return null;
  return Math.round(n * mult);
}

/// Translate a glob-style value (`*` wildcard) into an anchored
/// case-insensitive regex. `source:*` → /^.*$/i; `path:/api*` →
/// /^\/api.*$/i. Wildcards on values are mostly used in the inspector
/// "click key" flow and ad-hoc typing.
function wildcardToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const pattern = "^" + escaped.replace(/\*/g, ".*") + "$";
  return new RegExp(pattern, "i");
}

/// Per-evaluation context for keys that need state outside the event
/// (e.g. `pinned` reads the user's pin set, not a field on the row).
export interface EvalCtx {
  pinnedIds?: Set<number>;
  /// Single OR-joined regex compiled from the relevance regex list.
  /// `relevant:true` matches when this regex hits ev.msg or ev.raw.
  relevanceRe?: RegExp | null;
}

const STACK_KEYS = ["stack", "stacktrace", "stack_trace", "trace"];

function hasStackTrace(ev: LogEvent): boolean {
  const f = ev.fields as Record<string, unknown> | undefined;
  if (!f) return false;
  for (const k of STACK_KEYS) {
    const v = f[k];
    if (Array.isArray(v) && v.length > 0) return true;
    if (typeof v === "string" && v.trim().length > 0) return true;
  }
  return false;
}

/// Walk a path like `user.id` against an event's `fields` JSON.
function lookup(ev: LogEvent, key: string, ctx?: EvalCtx): unknown {
  if (key === "level") return ev.level;
  if (key === "source") return ev.source;
  if (key === "branch") return ev.branch;
  if (key === "msg") return ev.msg;
  if (key === "raw") return ev.raw;
  if (key === "ts" || key === "timestamp") return ev.ts;
  if (key === "id") return ev.id;
  if (key === "pinned") return ctx?.pinnedIds?.has(ev.id) ?? false;
  if (key === "hasStackTrace" || key === "stack") return hasStackTrace(ev);
  if (key === "relevant") {
    const re = ctx?.relevanceRe;
    if (!re) return false;
    return re.test(ev.msg) || re.test(ev.raw);
  }
  let cur: unknown = ev.fields;
  for (const part of key.split(".")) {
    if (cur && typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[part];
    } else return undefined;
  }
  return cur;
}

export function evalAst(ast: Ast, ev: LogEvent, ctx?: EvalCtx): boolean {
  switch (ast.kind) {
    case "free":
      if (!ast.term) return true;
      return ev.msg.toLowerCase().includes(ast.term.toLowerCase());
    case "key_exact": {
      const v = lookup(ev, ast.key, ctx);
      // Wildcards: `*` anywhere in the value switches to glob match
      // (anchored), so `source:*` matches any present value and
      // `path:/api*` matches a prefix.
      if (ast.value.includes("*")) {
        const re = wildcardToRegex(ast.value);
        return re.test(String(v ?? ""));
      }
      // Free-form text columns: case-insensitive substring match.
      if (ast.key === "msg" || ast.key === "raw") {
        return String(v ?? "")
          .toLowerCase()
          .includes(ast.value.toLowerCase());
      }
      return String(v) === ast.value;
    }
    case "key_cmp": {
      const v = Number(lookup(ev, ast.key, ctx));
      if (Number.isNaN(v)) return false;
      switch (ast.op) {
        case "lt":
          return v < ast.value;
        case "lte":
          return v <= ast.value;
        case "gt":
          return v > ast.value;
        case "gte":
          return v >= ast.value;
      }
    }
    case "key_regex": {
      const v = String(lookup(ev, ast.key, ctx) ?? "");
      try {
        return new RegExp(ast.pattern).test(v);
      } catch {
        return false;
      }
    }
    case "key_cmp_fn":
      // Should be replaced by resolveAst before eval. Be safe.
      return false;
    case "and":
      return evalAst(ast.left, ev, ctx) && evalAst(ast.right, ev, ctx);
    case "or":
      return evalAst(ast.left, ev, ctx) || evalAst(ast.right, ev, ctx);
    case "not":
      return !evalAst(ast.expr, ev, ctx);
  }
}

export function isError(x: Ast | ParseError): x is ParseError {
  return "message" in x;
}

/// Surface the parsed query as a flat list of chip tokens (top-level
/// AND-clauses) for the filter bar. `OR`/`NOT`/parens collapse into a
/// single composite chip.
export function tokenize(ast: Ast): Token[] {
  const out: Token[] = [];
  walkAnd(ast, out);
  return out;
}

function walkAnd(ast: Ast, out: Token[]): void {
  if (ast.kind === "and") {
    walkAnd(ast.left, out);
    walkAnd(ast.right, out);
    return;
  }
  out.push(astToToken(ast));
}

const TS_KEYS = new Set(["ts", "timestamp", "time", "created_at", "updated_at"]);
const TS_MS_FLOOR = 1_000_000_000_000;
const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function chipValue(key: string, value: number | string): string {
  if (TS_KEYS.has(key) && typeof value === "number" && value >= TS_MS_FLOOR) {
    return formatSmartDate(value);
  }
  return String(value);
}

/// Pretty timestamp: shortest unambiguous form. Same day → `HH:MM`
/// (or `HH:MM:SS[.mmm]` if sub-minute precision is meaningful);
/// same year → `Mon D HH:MM`; otherwise full `YYYY-MM-DD HH:MM`.
export function formatSmartDate(unixMs: number, ref = new Date()): string {
  const d = new Date(unixMs);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const ss = d.getSeconds();
  const ms = d.getMilliseconds();
  const time =
    ss === 0 && ms === 0
      ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
      : `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(ss)}${ms ? "." + pad(ms, 3) : ""}`;
  const sameDay = d.toDateString() === ref.toDateString();
  if (sameDay) return time;
  const sameYear = d.getFullYear() === ref.getFullYear();
  const monthDay = `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
  if (sameYear) return `${monthDay} ${time}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

function quoteIfNeeded(s: string): string {
  return renderValue(s);
}

function astToToken(ast: Ast): Token {
  switch (ast.kind) {
    case "key_exact":
      return {
        kind: "key_exact",
        text: `${ast.key}:${quoteIfNeeded(chipValue(ast.key, ast.value))}`,
      };
    case "key_cmp":
      return {
        kind: "key_cmp",
        text: `${ast.key}:${cmpStr(ast.op)}${quoteIfNeeded(chipValue(ast.key, ast.value))}`,
      };
    case "key_cmp_fn": {
      const inner = ast.argText ?? String(ast.arg);
      const op = ast.fn === "last" ? "" : cmpStr(ast.op);
      return {
        kind: "key_cmp",
        text: `${ast.key}:${op}${ast.fn}(${inner})`,
      };
    }
    case "key_regex":
      return { kind: "key_regex", text: `${ast.key}~/${ast.pattern}/` };
    case "free":
      // Quote multi-word terms so the chip text can be re-parsed as
      // one Free node instead of N implicit-AND'd singletons.
      return {
        kind: "free",
        text: /\s/.test(ast.term) ? `"${ast.term.replace(/"/g, '\\"')}"` : ast.term,
      };
    case "or":
      return {
        kind: "group",
        text: `(${render(ast.left)} OR ${render(ast.right)})`,
      };
    case "not":
      return { kind: "op", text: `NOT ${render(ast.expr)}` };
    case "and":
      return { kind: "op", text: render(ast) };
  }
}

/// Wrap an existing query in parens and append " AND " so the user can
/// type a new clause that ANDs with the whole previous expression.
/// Used by the "+ AND group" button in the filter bar.
export function wrapAsAndGroup(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return "";
  return `(${trimmed}) AND `;
}

/// Render an AST back to canonical query text. Exported so callers
/// (toggleFacetOr) can rebuild a query after manipulating the AST.
export function renderAst(ast: Ast): string {
  return render(ast);
}

/// Flatten a left-leaning AND chain into the list of top-level
/// conjuncts. \`a AND b AND c\` → [a, b, c].
export function flattenAnd(ast: Ast): Ast[] {
  if (ast.kind === "and") return [...flattenAnd(ast.left), ...flattenAnd(ast.right)];
  return [ast];
}

/// Return the list of values bound to \`key\` if this node is either a
/// bare \`key:value\` or an OR-chain of such bindings, else null.
export function extractKeyOrValues(ast: Ast, key: string): string[] | null {
  if (ast.kind === "key_exact" && ast.key === key) return [ast.value];
  if (ast.kind === "or") {
    const left = extractKeyOrValues(ast.left, key);
    const right = extractKeyOrValues(ast.right, key);
    if (left && right) return [...left, ...right];
  }
  return null;
}

function cmpStr(op: CmpOp): string {
  return op === "lt" ? "<" : op === "lte" ? "<=" : op === "gt" ? ">" : ">=";
}

/// Render a value so it round-trips through the parser. Quoted form
/// is used for anything containing whitespace, parens, quotes, or a
/// leading char the parser would otherwise consume as an operator
/// (\`>\`, \`<\`, \`~\`). Exported for callers that build clauses by hand.
export function renderValue(v: string): string {
  if (v === "") return '""';
  if (/[\s()"]/.test(v)) return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  if (/^[<>~]/.test(v)) return `"${v.replace(/"/g, '\\"')}"`;
  return v;
}

function render(ast: Ast): string {
  switch (ast.kind) {
    case "key_exact":
      return `${ast.key}:${renderValue(ast.value)}`;
    case "key_cmp":
      return `${ast.key}:${cmpStr(ast.op)}${renderValue(String(ast.value))}`;
    case "key_cmp_fn": {
      const inner = ast.argText ?? String(ast.arg);
      // \`last\` always means "within the last N" — implicit >=.
      // Hide the op so the chip / canonical text reads cleanly.
      const op = ast.fn === "last" ? "" : cmpStr(ast.op);
      return `${ast.key}:${op}${ast.fn}(${inner})`;
    }
    case "key_regex":
      return `${ast.key}~/${ast.pattern}/`;
    case "free":
      return /\s/.test(ast.term) ? `"${ast.term.replace(/"/g, '\\"')}"` : ast.term;
    case "and":
      return `(${render(ast.left)} AND ${render(ast.right)})`;
    case "or":
      return `(${render(ast.left)} OR ${render(ast.right)})`;
    case "not":
      return `NOT ${render(ast.expr)}`;
  }
}

/// Resolve aggregation functions (\`percentile(N)\`) against the
/// supplied events so the rest of the evaluator only has to handle
/// concrete numeric cmp clauses. Cached per (key, fn, arg) tuple.
export function resolveAst(ast: Ast, events: LogEvent[]): Ast {
  const cache = new Map<string, number>();
  const valueAt = (key: string, fn: "percentile" | "last", arg: number) => {
    const ck = `${key}|${fn}|${arg}`;
    let v = cache.get(ck);
    if (v != null) return v;
    if (fn === "last") {
      // duration(N) is "events within the last N ms" — emit a lower
      // bound at now − arg.
      v = Date.now() - arg;
    } else {
      const nums: number[] = [];
      for (const e of events) {
        const x = lookup(e, key);
        const n = typeof x === "number" ? x : Number(x);
        if (!Number.isNaN(n)) nums.push(n);
      }
      nums.sort((a, b) => a - b);
      if (nums.length === 0) v = 0;
      else {
        const idx = Math.min(nums.length - 1, Math.max(0, Math.floor((arg / 100) * nums.length)));
        v = nums[idx]!;
      }
    }
    cache.set(ck, v);
    return v;
  };
  const walk = (a: Ast): Ast => {
    switch (a.kind) {
      case "key_cmp_fn":
        return {
          kind: "key_cmp",
          key: a.key,
          op: a.op,
          value: valueAt(a.key, a.fn, a.arg),
        };
      case "and":
        return { kind: "and", left: walk(a.left), right: walk(a.right) };
      case "or":
        return { kind: "or", left: walk(a.left), right: walk(a.right) };
      case "not":
        return { kind: "not", expr: walk(a.expr) };
      default:
        return a;
    }
  };
  return walk(ast);
}
