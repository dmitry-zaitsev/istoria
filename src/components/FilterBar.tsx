import { useEffect, useMemo, useRef } from "react";

import { registerFilterFocus } from "../lib/filterFocus";
import { isError, parse, tokenize, wrapAsAndGroup } from "../lib/query";

interface FilterBarProps {
  value: string;
  onChange: (value: string) => void;
}

export function FilterBar({ value, onChange }: FilterBarProps) {
  const parsed = useMemo(() => parse(value), [value]);
  const error = isError(parsed) ? parsed : null;
  const tokens = error || isError(parsed) ? [] : tokenize(parsed);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    registerFilterFocus(() => {
      const el = inputRef.current;
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
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onAndGroup = () => {
    onChange(wrapAsAndGroup(value));
    queueMicrotask(() => inputRef.current?.focus());
  };

  const showGroupButton = !error && value.trim().length > 0;

  return (
    <div className="filter-bar">
      <div className={`query-input${error ? " err" : ""}`}>
        <span className="query-icon">⌕</span>
        <input
          ref={inputRef}
          type="text"
          value={value}
          placeholder='filter — e.g. (level:info OR level:debug) AND msg:GET'
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        {!error && tokens.length > 0 && tokens[0]!.text && (
          <span className="chips">
            {tokens.map((t, i) => (
              <span key={i} className={`chip chip-${t.kind}`}>
                {t.text}
              </span>
            ))}
          </span>
        )}
        {showGroupButton && (
          <button
            type="button"
            className="filter-group-btn"
            onClick={onAndGroup}
            title="Wrap current query in parens and AND a new clause"
          >
            + AND group
          </button>
        )}
      </div>
      {error && (
        <span className="filter-err">
          parse error: {error.message}
        </span>
      )}
    </div>
  );
}
