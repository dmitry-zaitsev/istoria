import { useEffect, useMemo, useRef, useState } from "react";

import { addAlert, hashColor, loadAlerts } from "../lib/alerts";
import type { SuggestionMatch } from "../lib/facets";
import { registerFilterFocus } from "../lib/filterFocus";
import { isError, parse, renderValue, tokenize, type Token } from "../lib/query";
import { toast } from "../lib/toast";
import { useStore } from "../store";

interface FilterBarProps {
  value: string;
  onChange: (value: string) => void;
  suggestKeys?: string[];
  suggestValuesByKey?: Map<string, string[]>;
  /// Cross-cutting substring autocomplete. When provided and the user
  /// is typing a bare token of length ≥ 2 with no colon yet, the result
  /// list replaces the prefix-keys-only suggestions with a merged set
  /// of key / key:value / msg matches.
  suggest?: (query: string) => SuggestionMatch[];
}

/// Cap displayed msg label width so a giant log line doesn't blow up
/// the dropdown. The full msg is still used in the completion string.
const MSG_LABEL_MAX = 80;

const OPERATORS = ["AND", "OR", "NOT"] as const;

export function FilterBar({
  value,
  onChange,
  suggestKeys = [],
  suggestValuesByKey,
  suggest,
}: FilterBarProps) {
  const parsed = useMemo(() => parse(value), [value]);
  const error = isError(parsed) ? parsed : null;
  const tokens: Token[] = error || isError(parsed) ? [] : tokenize(parsed);
  const usefulTokens = tokens.filter((t) => t.text.length > 0);

  const setAlerts = useStore((s) => s.setAlerts);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [trailing, setTrailing] = useState("");
  const [allSelected, setAllSelected] = useState(false);
  const editRef = useRef<HTMLInputElement | null>(null);
  const trailingRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    registerFilterFocus(() => {
      const el = trailingRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
    return () => registerFilterFocus(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        const el = trailingRef.current;
        if (!el) return;
        el.focus();
        el.select();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "a") {
        const target = e.target as HTMLElement | null;
        const el = target?.closest(".filter-bar");
        if (!el) return;
        const ti = trailingRef.current;
        if (
          ti &&
          document.activeElement === ti &&
          ti.value.length > 0 &&
          (ti.selectionStart !== 0 || ti.selectionEnd !== ti.value.length)
        ) {
          return;
        }
        e.preventDefault();
        setAllSelected(true);
        // Take focus away from any inner input so keyboard events
        // route to our window listener (Cmd+C/Esc).
        ti?.blur();
        editRef.current?.blur();
      }
      if (allSelected && (e.metaKey || e.ctrlKey) && e.key === "c") {
        e.preventDefault();
        const full = useStore.getState().filter;
        if (full) {
          navigator.clipboard
            ?.writeText(full)
            .then(() => toast("Copied"))
            .catch(() => toast("Copy failed"));
        }
        setAllSelected(false);
      }
      if (allSelected && (e.key === "Backspace" || e.key === "Delete")) {
        e.preventDefault();
        onChange("");
        setAllSelected(false);
      }
      if (allSelected && e.key === "Escape") {
        setAllSelected(false);
      }
    };
    window.addEventListener("keydown", onKey);
    const onMouseDown = (e: MouseEvent) => {
      if (!allSelected) return;
      const t = e.target as HTMLElement | null;
      if (!t?.closest(".filter-bar")) setAllSelected(false);
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [allSelected, onChange]);

  useEffect(() => {
    if (editing != null) editRef.current?.focus();
  }, [editing]);

  const startEdit = (i: number) => {
    setEditing(i);
    setDraft(usefulTokens[i]!.text);
  };

  const commitEdit = (i: number, next: string) => {
    const trimmed = next.trim();
    const newTokens = [...usefulTokens];
    if (trimmed === "") {
      newTokens.splice(i, 1);
    } else {
      newTokens[i] = { kind: usefulTokens[i]!.kind, text: trimmed };
    }
    onChange(newTokens.map((t) => t.text).join(" AND "));
    setEditing(null);
    setDraft("");
  };

  const removeToken = (i: number) => {
    const newTokens = [...usefulTokens];
    newTokens.splice(i, 1);
    onChange(newTokens.map((t) => t.text).join(" AND "));
  };

  const commitTrailing = (override?: string) => {
    const text = override ?? trailing;
    const trimmed = text.trim();
    if (!trimmed) return;
    const prev = usefulTokens.map((t) => t.text).join(" AND ");
    let next: string;
    if (!prev) {
      next = trimmed;
    } else if (/^(OR|AND)\b/i.test(trimmed)) {
      // User explicitly typed a connector — don't double up.
      next = `${prev} ${trimmed}`;
    } else if (/^NOT\b/i.test(trimmed)) {
      // NOT is unary; AND-join.
      next = `${prev} AND ${trimmed}`;
    } else {
      next = `${prev} AND ${trimmed}`;
    }
    onChange(next);
    setTrailing("");
    setSuggestIdx(0);
  };

  // ── Autocomplete ─────────────────────────────────────────────
  const [suggestIdx, setSuggestIdx] = useState(0);
  const suggestions = useMemo(
    () => buildSuggestions(trailing, suggestKeys, suggestValuesByKey, suggest),
    [trailing, suggestKeys, suggestValuesByKey, suggest]
  );
  const showSuggestions = trailing.length > 0 && suggestions.items.length > 0;
  useEffect(() => setSuggestIdx(0), [trailing]);

  const applySuggestion = (idx: number) => {
    const item = suggestions.items[idx];
    if (!item) return;
    const before = trailing.slice(0, suggestions.replaceFrom);
    const after = item.completion;
    const newTrailing = before + after;
    if (item.commit) {
      commitTrailing(newTrailing);
    } else {
      setTrailing(newTrailing);
      queueMicrotask(() => trailingRef.current?.focus());
    }
  };

  return (
    <div className="filter-bar">
      <div className={`query-input${error ? " err" : ""}`}>
        <span className="query-icon">⌕</span>
        <span className="pills">
          {usefulTokens.map((t, i) =>
            editing === i ? (
              <input
                key={i}
                ref={editRef}
                className="pill-edit"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEdit(i, draft);
                  if (e.key === "Escape") setEditing(null);
                }}
                onBlur={() => commitEdit(i, draft)}
                style={{ width: `${Math.max(8, draft.length + 1)}ch` }}
              />
            ) : (
              <span
                key={i}
                className={`pill pill-${t.kind}${allSelected ? " selected" : ""}`}
                onClick={() => {
                  setAllSelected(false);
                  startEdit(i);
                }}
                title="Click to edit"
              >
                <span className="pill-text">{t.text}</span>
                <span
                  className="pill-x"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeToken(i);
                  }}
                  aria-label="remove clause"
                >
                  ×
                </span>
              </span>
            )
          )}
        </span>
        <input
          ref={trailingRef}
          className="trailing-input"
          type="text"
          value={trailing}
          placeholder={
            usefulTokens.length === 0 ? "filter — e.g. level:error AND status_code:>=400" : "+ AND…"
          }
          onChange={(e) => {
            setAllSelected(false);
            setTrailing(e.target.value);
          }}
          onFocus={() => setAllSelected(false)}
          onKeyDown={(e) => {
            if (showSuggestions && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              const dir = e.key === "ArrowDown" ? 1 : -1;
              setSuggestIdx((i) => (i + dir + suggestions.items.length) % suggestions.items.length);
              return;
            }
            if (
              showSuggestions &&
              (e.key === "Enter" || e.key === "Tab") &&
              !(e.metaKey || e.ctrlKey)
            ) {
              e.preventDefault();
              applySuggestion(suggestIdx);
              return;
            }
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              // Commit current trailing as-is, ignoring suggestions.
              e.preventDefault();
              commitTrailing();
              return;
            }
            if (showSuggestions && e.key === "Escape") {
              setTrailing("");
              return;
            }
            if (e.key === "Enter") commitTrailing();
            if (e.key === "Backspace" && trailing === "" && usefulTokens.length > 0) {
              if (allSelected) {
                onChange("");
                setAllSelected(false);
              } else {
                removeToken(usefulTokens.length - 1);
              }
            }
          }}
          onBlur={() => commitTrailing()}
          spellCheck={false}
          autoComplete="off"
        />
        {showSuggestions && (
          <div className="suggestions">
            {suggestions.items.map((it, i) => (
              <div
                key={i}
                className={`suggestion${i === suggestIdx ? " active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applySuggestion(i);
                }}
              >
                <span className={`suggestion-kind ${it.kind}`}>{it.kind}</span>
                <span className="suggestion-text">{it.label}</span>
              </div>
            ))}
            <div className="suggestion-hint">
              <span>
                <kbd>↵</kbd> apply
              </span>
              <span>
                <kbd>⌘↵</kbd> submit
              </span>
              <span>
                <kbd>⎋</kbd> close
              </span>
            </div>
          </div>
        )}
      </div>
      {!error && usefulTokens.length > 0 && (
        <button
          type="button"
          className="notify-btn"
          title="Notify me on matches for this filter"
          onClick={() => {
            const q = value.trim();
            if (!q) return;
            try {
              addAlert({
                name: q,
                query: q,
                color: hashColor(q),
                notify: true,
                debounce_ms: 5000,
              });
              setAlerts(loadAlerts());
              toast("notify on");
            } catch (e) {
              toast(`notify failed: ${String(e)}`);
            }
          }}
        >
          notify
        </button>
      )}
      {error && <span className="filter-err">parse error: {error.message}</span>}
    </div>
  );
}

interface SuggestionItem {
  kind: "key" | "value" | "op";
  label: string;
  /// Text to insert at replaceFrom..end of trailing input.
  completion: string;
  /// True → commit trailing as a clause immediately.
  commit?: boolean;
}

interface SuggestionResult {
  replaceFrom: number;
  items: SuggestionItem[];
}

/// Inspect the current trailing-input string and surface a small set
/// of completions: keys when typing the LHS, values when after a
/// \`key:\`, operators between completed clauses.
function buildSuggestions(
  input: string,
  keys: string[],
  valuesByKey?: Map<string, string[]>,
  suggest?: (q: string) => SuggestionMatch[]
): SuggestionResult {
  // Skip suggestions when the user is typing inside an unclosed
  // function call — \`last(15 min)\`, \`percentile(50)\`, etc. Otherwise
  // every keystroke surfaces an irrelevant key list.
  let depth = 0;
  for (const ch of input) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
  }
  if (depth > 0) return { replaceFrom: input.length, items: [] };

  // Find the last "token" boundary (whitespace or ')').
  const m = input.match(/(?:^|[\s)])([^\s()]*)$/);
  const tail = m?.[1] ?? "";
  const replaceFrom = input.length - tail.length;

  // Pure-substring mode: trailing has no `:`, parens, or operators, so
  // the whole input is one free-text search. Without this, picking an
  // msg autocomplete via Enter leaves the un-replaced prefix words as
  // bare implicit-AND pills next to the new `msg:"…"` pill.
  const pureSubstring = input.length > 0 && !/[:()]/.test(input) && !/\b(AND|OR|NOT)\b/.test(input);

  // Top-level operator suggestion when no partial token at end —
  // but only after the user has added a separator (whitespace), not
  // immediately after a `)` closing a fn call. Otherwise pressing
  // Enter to commit gets swallowed by an autocomplete pick.
  if (tail === "") {
    if (input.length > 0 && !/\s$/.test(input)) {
      return { replaceFrom, items: [] };
    }
    return {
      replaceFrom,
      items: OPERATORS.map<SuggestionItem>((op) => ({
        kind: "op",
        label: op,
        completion: `${op} `,
      })),
    };
  }

  // After `key:` → suggest values for that key, plus aggregation
  // functions where they make sense (last() for ts/timestamp, and
  // percentile() for numeric keys with a cmp op).
  const colon = tail.indexOf(":");
  if (colon > 0 && !tail.includes("~")) {
    const key = tail.slice(0, colon);
    const afterColon = tail.slice(colon + 1);
    // Strip leading cmp op (>=, <=, >, <) to get the value partial.
    const opMatch = afterColon.match(/^(>=|<=|>|<)?(.*)$/);
    const cmp = opMatch?.[1] ?? "";
    const partial = opMatch?.[2] ?? afterColon;
    const items: SuggestionItem[] = [];

    // last() — for time keys; op is implicit (>=), so don't render it.
    if (key === "ts" || key === "timestamp") {
      const presets = ["5 min", "15 min", "1 h", "24 h", "7 d"];
      for (const p of presets) {
        if (`last(${p})`.toLowerCase().startsWith(partial.toLowerCase())) {
          items.push({
            kind: "value",
            label: `${key}:last(${p})`,
            completion: `${key}:last(${p}) `,
            commit: true,
          });
        }
      }
    }

    // percentile() — only when a cmp op is present (semantics need it).
    if (cmp) {
      for (const p of [50, 75, 90, 95, 99]) {
        if (`percentile(${p})`.startsWith(partial)) {
          items.push({
            kind: "value",
            label: `${key}:${cmp}percentile(${p})`,
            completion: `${key}:${cmp}percentile(${p}) `,
            commit: true,
          });
        }
      }
    }

    // Plain values from facets.
    const vals = valuesByKey?.get(key) ?? defaultValuesFor(key);
    const matched = vals
      .filter((v) => v.toLowerCase().startsWith(partial.toLowerCase()))
      .slice(0, 8);
    for (const v of matched) {
      items.push({
        kind: "value",
        label: `${key}:${cmp}${v}`,
        completion: `${key}:${cmp}${renderValue(v)} `,
        commit: true,
      });
    }
    return { replaceFrom, items };
  }

  // Bare token → cross-cutting substring suggest (keys + kv + msg) if
  // available and the partial is ≥ 2 chars. Falls back to legacy
  // prefix-key matching when `suggest` is absent or the partial is too
  // short to scan meaningfully.
  const lower = tail.toLowerCase();
  const opMatches = OPERATORS.filter((o) => o.toLowerCase().startsWith(lower)).map<SuggestionItem>(
    (o) => ({
      kind: "op",
      label: o,
      completion: `${o} `,
    })
  );

  const suggestQuery = pureSubstring ? input.trim() : tail;
  const suggestReplaceFrom = pureSubstring ? 0 : replaceFrom;
  if (suggest && suggestQuery.length >= 2) {
    const matches = suggest(suggestQuery);
    if (matches.length > 0) {
      const items = matches.map<SuggestionItem>((m) => {
        if (m.kind === "key") {
          return { kind: "key", label: m.key!, completion: `${m.key}:` };
        }
        if (m.kind === "kv") {
          return {
            kind: "value",
            label: `${m.key}:${m.value}`,
            completion: `${m.key}:${renderValue(m.value!)} `,
            commit: true,
          };
        }
        // msg: label is truncated for display; completion stays full.
        const full = m.msg!;
        const label =
          full.length > MSG_LABEL_MAX ? `msg:${full.slice(0, MSG_LABEL_MAX)}…` : `msg:${full}`;
        return {
          kind: "value",
          label,
          completion: `msg:${renderValue(full)} `,
          commit: true,
        };
      });
      return { replaceFrom: suggestReplaceFrom, items: [...items, ...opMatches] };
    }
  }

  const keyMatches = keys
    .filter((k) => k.toLowerCase().startsWith(lower))
    .slice(0, 8)
    .map<SuggestionItem>((k) => ({
      kind: "key",
      label: k,
      completion: `${k}:`,
    }));
  return {
    replaceFrom,
    items: [...keyMatches, ...opMatches],
  };
}

function defaultValuesFor(key: string): string[] {
  if (key === "level") return ["error", "warn", "info", "debug", "trace"];
  return [];
}
