interface FilterBarProps {
  value: string;
  onChange: (value: string) => void;
}

export function FilterBar({ value, onChange }: FilterBarProps) {
  return (
    <div className="filter-bar">
      <div className="query-input">
        <span className="query-icon">⌕</span>
        <input
          type="text"
          value={value}
          placeholder="filter — type to substring-match (M2: key:value chips)"
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    </div>
  );
}
