interface StatusBarProps {
  live: boolean;
  total: number;
  filtered: number;
  filterActive: boolean;
}

export function StatusBar({
  live,
  total,
  filtered,
  filterActive,
}: StatusBarProps) {
  return (
    <div className="status">
      <span className={`live${live ? "" : " idle"}`}>
        <span className="dot" />
        {live ? "live · stdin" : "idle"}
      </span>
      <span>{total.toLocaleString()} events</span>
      {filterActive && (
        <span style={{ color: "var(--muted-2)" }}>
          {filtered.toLocaleString()} match filter
        </span>
      )}
      <span className="right">
        <span>
          <kbd>⌘F</kbd> filter
        </span>
        <span>
          <kbd>Esc</kbd> close
        </span>
      </span>
    </div>
  );
}
