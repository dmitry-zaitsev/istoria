interface StreamHeaderProps {
  total: number;
  filtered: number;
  filterActive: boolean;
}

export function StreamHeader({ total, filtered, filterActive }: StreamHeaderProps) {
  return (
    <div className="stream-h">
      <span className="count">
        <b>{filtered.toLocaleString()}</b> events
        {filterActive && (
          <span style={{ color: "var(--muted-2)" }}>
            {" "}
            · of {total.toLocaleString()}
          </span>
        )}
      </span>
      <span className="right">
        <span style={{ color: "var(--muted)" }}>sort: time ▾</span>
      </span>
    </div>
  );
}
