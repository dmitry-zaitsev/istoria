import { describe, expect, it } from "vitest";

import { addClause, addNotClause } from "./facets";
import { isError, parse, renderAst, renderValue, tokenize, type Ast } from "./query";

// Regression coverage for the "Filter by value" quote round-trip bug:
// a value containing a `"` used to escape as `\"` on write but the
// parser didn't un-escape it, so the quoted string terminated early and
// the remainder became a chain of implicit-AND free terms — i.e. a bunch
// of disjoint filter chips instead of one. See consumeQuoted / escapeQuoted
// in query.ts.

function asExact(ast: Ast | { message: string; pos: number }) {
  if (isError(ast)) throw new Error(`parse error: ${ast.message}`);
  return ast;
}

describe("filter clause round-trip", () => {
  // The exact value from the bug report.
  const LAUNCHDARKLY =
    'error: [LaunchDarkly] Unknown feature flag "auto-deprioritize-tasks"; returning default value';

  it("filters by a quoted value as a single clause (the report)", () => {
    const query = addClause("", "msg", LAUNCHDARKLY);
    const ast = asExact(parse(query));

    // One chip, not many.
    expect(tokenize(ast)).toHaveLength(1);
    expect(ast).toEqual({ kind: "key_exact", key: "msg", value: LAUNCHDARKLY });
  });

  it("excludes a quoted value as a single clause", () => {
    // Mirrors onExcludeFilter in Inspector.tsx: build the clause, then negate.
    const query = addNotClause("", `msg:${renderValue(LAUNCHDARKLY)}`);
    const ast = asExact(parse(query));

    expect(tokenize(ast)).toHaveLength(1);
    expect(ast.kind).toBe("not");
    if (ast.kind === "not") {
      expect(ast.expr).toEqual({ kind: "key_exact", key: "msg", value: LAUNCHDARKLY });
    }
  });

  it("appends a quoted-value clause to an existing query without corrupting it", () => {
    const query = addClause("level:error", "msg", LAUNCHDARKLY);
    const ast = asExact(parse(query));
    // level:error AND msg:"…" → two top-level clauses, nothing extra.
    expect(tokenize(ast)).toHaveLength(2);
  });
});

describe("renderValue → parse round-trip", () => {
  const values = [
    "plain",
    "with spaces",
    'has "inner quotes"',
    "trailing backslash\\",
    "back\\\\slash",
    'quote\\"then more',
    "in (parens)",
    "<not-an-op",
    "~tilde-leading",
    "colon:inside",
    "unicode ✓ ☃",
    "   ",
  ];

  for (const v of values) {
    it(`round-trips ${JSON.stringify(v)}`, () => {
      const ast = asExact(parse(`msg:${renderValue(v)}`));
      expect(tokenize(ast)).toHaveLength(1);
      expect(ast).toEqual({ kind: "key_exact", key: "msg", value: v });
    });
  }
});

describe("renderAst → parse round-trip for free terms", () => {
  const terms: string[] = [
    "multi word",
    'said "hello" loudly',
    "path with \\ backslash",
    "trailing\\",
  ];

  for (const term of terms) {
    it(`round-trips free term ${JSON.stringify(term)}`, () => {
      const original: Ast = { kind: "free", term };
      const ast = asExact(parse(renderAst(original)));
      expect(ast).toEqual(original);
    });
  }
});

describe("existing query behavior (regression guard)", () => {
  it("parses a plain key:value into one clause", () => {
    const ast = asExact(parse("level:error"));
    expect(ast).toEqual({ kind: "key_exact", key: "level", value: "error" });
    expect(tokenize(ast)).toHaveLength(1);
  });

  it("keeps a whitespace-only quoted value as one term", () => {
    const ast = asExact(parse('msg:"multi word value"'));
    expect(ast).toEqual({ kind: "key_exact", key: "msg", value: "multi word value" });
    expect(tokenize(ast)).toHaveLength(1);
  });

  it("still AND-joins adjacent bare terms", () => {
    const ast = asExact(parse("request mismatch"));
    expect(tokenize(ast)).toHaveLength(2);
  });
});
