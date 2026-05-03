interface StatusBarProps {
  total: number;
  filtered: number;
  filterActive: boolean;
}

export function StatusBar({ total, filtered, filterActive }: StatusBarProps) {
  return (
    <div className="status">
      <span>{total.toLocaleString()} events</span>
      {filterActive && (
        <span style={{ color: "var(--muted-2)" }}>{filtered.toLocaleString()} match filter</span>
      )}
      <span className="right">
        <span>
          <kbd>⌘F</kbd> filter
        </span>
      </span>
    </div>
  );
}
