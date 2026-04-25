import { useEffect, useMemo, useRef, useState } from "react";

import { registerFilterFocus } from "../lib/filterFocus";
import { isError, parse, tokenize, type Token } from "../lib/query";
import { useStore } from "../store";

interface FilterBarProps {
  value: string;
  onChange: (value: string) => void;
}

export function FilterBar({ value, onChange }: FilterBarProps) {
  const parsed = useMemo(() => parse(value), [value]);
  const error = isError(parsed) ? parsed : null;
  const tokens: Token[] = error || isError(parsed) ? [] : tokenize(parsed);
  const usefulTokens = tokens.filter((t) => t.text.length > 0);

  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [trailing, setTrailing] = useState("");
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
        // If the trailing input has more than zero chars and not the
        // whole field selected, let native Cmd+A select that input first.
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
        const pillsEl = el.querySelector(".pills");
        if (!pillsEl) return;
        const range = document.createRange();
        range.selectNodeContents(pillsEl);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  const commitTrailing = () => {
    const trimmed = trailing.trim();
    if (!trimmed) return;
    const next =
      usefulTokens.length === 0
        ? trimmed
        : `${usefulTokens.map((t) => t.text).join(" AND ")} AND ${trimmed}`;
    onChange(next);
    setTrailing("");
  };

  const onCopy = (e: React.ClipboardEvent) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    // Only override when the selection is entirely inside .pills —
    // otherwise let native copy fall through (e.g. selecting text in
    // a pill-edit input).
    const range = sel.getRangeAt(0);
    const pills = (e.currentTarget as HTMLElement).querySelector(".pills");
    if (!pills || !pills.contains(range.commonAncestorContainer)) return;
    e.preventDefault();
    const full = useStore.getState().filter;
    if (full) e.clipboardData.setData("text/plain", full);
  };

  return (
    <div className="filter-bar" onCopy={onCopy}>
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
                className={`pill pill-${t.kind}`}
                onClick={() => startEdit(i)}
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
          onChange={(e) => setTrailing(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitTrailing();
            if (e.key === "Backspace" && trailing === "" && usefulTokens.length > 0) {
              removeToken(usefulTokens.length - 1);
            }
          }}
          onBlur={commitTrailing}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      {error && (
        <span className="filter-err">parse error: {error.message}</span>
      )}
    </div>
  );
}
