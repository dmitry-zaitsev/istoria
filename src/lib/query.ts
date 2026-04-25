// Query AST type — mirrors the Rust definition in `src-tauri/src/query.rs`.
// Same semantics as the SQL lowering, evaluated client-side for live tail.

import type { LogEvent } from "./ipc";

export type CmpOp = "lt" | "lte" | "gt" | "gte";

export type Ast =
  | { kind: "key_exact"; key: string; value: string }
  | { kind: "key_cmp"; key: string; op: CmpOp; value: number }
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
  kind: "key_exact" | "key_cmp" | "key_regex" | "free" | "op";
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
    } else break;
  }
  return left;
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
    // numeric cmp?
    const cmp = matchCmpOp(c);
    if (cmp) {
      const numStart = c.pos;
      const numStr = consumeBareValue(c);
      const value = Number(numStr);
      if (Number.isNaN(value))
        throw new Error(`expected number, got '${numStr}' at ${numStart}`);
      return { kind: "key_cmp", key, op: cmp, value };
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
  // Free term — rewind to startPos and consume non-ws
  c.pos = startPos;
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

/// Walk a path like `user.id` against an event's `fields` JSON.
function lookup(ev: LogEvent, key: string): unknown {
  if (key === "level") return ev.level;
  if (key === "source") return ev.source;
  if (key === "msg") return ev.msg;
  if (key === "raw") return ev.raw;
  let cur: unknown = ev.fields;
  for (const part of key.split(".")) {
    if (cur && typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[part];
    } else return undefined;
  }
  return cur;
}

export function evalAst(ast: Ast, ev: LogEvent): boolean {
  switch (ast.kind) {
    case "free":
      if (!ast.term) return true;
      return ev.msg.toLowerCase().includes(ast.term.toLowerCase());
    case "key_exact": {
      const v = lookup(ev, ast.key);
      return String(v) === ast.value;
    }
    case "key_cmp": {
      const v = Number(lookup(ev, ast.key));
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
      const v = String(lookup(ev, ast.key) ?? "");
      try {
        return new RegExp(ast.pattern).test(v);
      } catch {
        return false;
      }
    }
    case "and":
      return evalAst(ast.left, ev) && evalAst(ast.right, ev);
    case "or":
      return evalAst(ast.left, ev) || evalAst(ast.right, ev);
    case "not":
      return !evalAst(ast.expr, ev);
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

function astToToken(ast: Ast): Token {
  switch (ast.kind) {
    case "key_exact":
      return { kind: "key_exact", text: `${ast.key}:${ast.value}` };
    case "key_cmp":
      return { kind: "key_cmp", text: `${ast.key}:${cmpStr(ast.op)}${ast.value}` };
    case "key_regex":
      return { kind: "key_regex", text: `${ast.key}~/${ast.pattern}/` };
    case "free":
      return { kind: "free", text: ast.term };
    case "or":
    case "not":
    case "and":
      return { kind: "op", text: render(ast) };
  }
}

function cmpStr(op: CmpOp): string {
  return op === "lt" ? "<" : op === "lte" ? "<=" : op === "gt" ? ">" : ">=";
}

function render(ast: Ast): string {
  switch (ast.kind) {
    case "key_exact":
      return `${ast.key}:${ast.value}`;
    case "key_cmp":
      return `${ast.key}:${cmpStr(ast.op)}${ast.value}`;
    case "key_regex":
      return `${ast.key}~/${ast.pattern}/`;
    case "free":
      return ast.term;
    case "and":
      return `(${render(ast.left)} AND ${render(ast.right)})`;
    case "or":
      return `(${render(ast.left)} OR ${render(ast.right)})`;
    case "not":
      return `NOT ${render(ast.expr)}`;
  }
}
