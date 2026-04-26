import { useEffect, useMemo, useRef, useState } from "react";

import { registerFilterFocus } from "../lib/filterFocus";
import { isError, parse, tokenize, type Token } from "../lib/query";
import { toast } from "../lib/toast";
import { useStore } from "../store";

interface FilterBarProps {
  value: string;
  onChange: (value: string) => void;
  suggestKeys?: string[];
  suggestValuesByKey?: Map<string, string[]>;
}

const OPERATORS = ["AND", "OR", "NOT"] as const;

export function FilterBar({
  value,
  onChange,
  suggestKeys = [],
  suggestValuesByKey,
}: FilterBarProps) {
  const parsed = useMemo(() => parse(value), [value]);
  const error = isError(parsed) ? parsed : null;
  const tokens: Token[] = error || isError(parsed) ? [] : tokenize(parsed);
  const usefulTokens = tokens.filter((t) => t.text.length > 0);

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
    const next =
      usefulTokens.length === 0
        ? trimmed
        : `${usefulTokens.map((t) => t.text).join(" AND ")} AND ${trimmed}`;
    onChange(next);
    setTrailing("");
    setSuggestIdx(0);
  };

  // ── Autocomplete ─────────────────────────────────────────────
  const [suggestIdx, setSuggestIdx] = useState(0);
  const suggestions = useMemo(
    () => buildSuggestions(trailing, suggestKeys, suggestValuesByKey),
    [trailing, suggestKeys, suggestValuesByKey],
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
            ),
          )}
        </span>
        <input
          ref={trailingRef}
          className="trailing-input"
          type="text"
          value={trailing}
          placeholder={
            usefulTokens.length === 0
              ? "filter — e.g. level:error AND status_code:>=400"
              : "+ AND…"
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
              setSuggestIdx(
                (i) =>
                  (i + dir + suggestions.items.length) % suggestions.items.length,
              );
              return;
            }
            if (showSuggestions && (e.key === "Enter" || e.key === "Tab")) {
              e.preventDefault();
              applySuggestion(suggestIdx);
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
          </div>
        )}
      </div>
      {error && (
        <span className="filter-err">parse error: {error.message}</span>
      )}
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
): SuggestionResult {
  // Find the last "token" boundary (whitespace or ')').
  const m = input.match(/(?:^|[\s)])([^\s()]*)$/);
  const tail = m?.[1] ?? "";
  const replaceFrom = input.length - tail.length;

  // Top-level operator suggestion when no partial token at end.
  if (tail === "") {
    return {
      replaceFrom,
      items: OPERATORS.map<SuggestionItem>((op) => ({
        kind: "op",
        label: op,
        completion: `${op} `,
      })),
    };
  }

  // After `key:` → suggest values for that key.
  const colon = tail.indexOf(":");
  if (colon > 0 && !tail.includes("~")) {
    const key = tail.slice(0, colon);
    const partial = tail.slice(colon + 1);
    const vals = valuesByKey?.get(key) ?? defaultValuesFor(key);
    const matched = vals
      .filter((v) => v.toLowerCase().startsWith(partial.toLowerCase()))
      .slice(0, 8);
    return {
      replaceFrom,
      items: matched.map<SuggestionItem>((v) => ({
        kind: "value",
        label: `${key}:${v}`,
        completion: `${key}:${quoteIfNeeded(v)} `,
        commit: true,
      })),
    };
  }

  // Bare token → suggest keys (and operators if the token looks like
  // an operator prefix).
  const lower = tail.toLowerCase();
  const keyMatches = keys
    .filter((k) => k.toLowerCase().startsWith(lower))
    .slice(0, 8)
    .map<SuggestionItem>((k) => ({
      kind: "key",
      label: k,
      completion: `${k}:`,
    }));
  const opMatches = OPERATORS.filter((o) =>
    o.toLowerCase().startsWith(lower),
  ).map<SuggestionItem>((o) => ({
    kind: "op",
    label: o,
    completion: `${o} `,
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

function quoteIfNeeded(v: string): string {
  if (/[\s()"]/.test(v)) return `"${v.replace(/"/g, '\\"')}"`;
  return v;
}
