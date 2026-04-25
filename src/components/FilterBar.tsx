interface FilterBarProps {
  value: string;
  onChange: (value: string) => void;
}

export function FilterBar({ value, onChange }: FilterBarProps) {
  return (
    <div className="filterbar">
      <input
        className="filter-input"
        type="text"
        value={value}
        placeholder="Filter logs…"
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoComplete="off"
      />
    </div>
  );
}
