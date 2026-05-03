import type { ReactNode } from "react";

import type { Ast } from "./query";

export interface HighlightTerm {
  regex: RegExp;
}

export function termsFromAst(ast: Ast): HighlightTerm[] {
  const out: HighlightTerm[] = [];
  walk(ast, out);
  return out;
}

function walk(ast: Ast, out: HighlightTerm[]): void {
  switch (ast.kind) {
    case "free":
      if (ast.term) out.push({ regex: makeFreeRegex(ast.term) });
      return;
    case "key_regex":
      if (ast.key === "msg" || ast.key === "raw") {
        try {
          out.push({ regex: new RegExp(ast.pattern, "g") });
        } catch {
          // bad regex — skip silently; query bar already surfaces error
        }
      }
      return;
    case "and":
    case "or":
      walk(ast.left, out);
      walk(ast.right, out);
      return;
    case "not":
      // matches inside NOT branches are excluded from results;
      // highlighting them would point at the wrong thing.
      return;
    default:
      return;
  }
}

function makeFreeRegex(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped, "gi");
}

export function highlight(text: string, terms: HighlightTerm[]): ReactNode {
  if (!text || terms.length === 0) return text;
  const ranges: [number, number][] = [];
  for (const { regex } of terms) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) != null) {
      if (m[0].length === 0) {
        regex.lastIndex++;
        continue;
      }
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  if (ranges.length === 0) return text;
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      merged.push([r[0], r[1]]);
    }
  }
  const nodes: ReactNode[] = [];
  let cursor = 0;
  merged.forEach(([s, e], i) => {
    if (cursor < s) nodes.push(text.slice(cursor, s));
    nodes.push(
      <mark key={i} className="hl">
        {text.slice(s, e)}
      </mark>
    );
    cursor = e;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}
