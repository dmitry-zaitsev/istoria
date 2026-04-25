import { useMemo } from "react";

import { isError, parse, tokenize } from "../lib/query";

interface FilterBarProps {
  value: string;
  onChange: (value: string) => void;
}

export function FilterBar({ value, onChange }: FilterBarProps) {
  const parsed = useMemo(() => parse(value), [value]);
  const error = isError(parsed) ? parsed : null;
  const tokens = error || isError(parsed) ? [] : tokenize(parsed);

  return (
    <div className="filter-bar">
      <div className={`query-input${error ? " err" : ""}`}>
        <span className="query-icon">⌕</span>
        <input
          type="text"
          value={value}
          placeholder='filter — e.g. level:error AND source:api'
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
      </div>
      {error && (
        <span className="filter-err">
          parse error: {error.message}
        </span>
      )}
    </div>
  );
}
