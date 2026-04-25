interface ChromeProps {
  live: boolean;
  count: number;
}

export function Chrome({ live, count }: ChromeProps) {
  return (
    <header className="chrome">
      <div className="chrome-spacer" />
      <div className="chrome-title">
        <span className={`live-dot${live ? " on" : ""}`} aria-hidden />
        <span className="chrome-title-text">istoria</span>
        <span className="chrome-count">{count.toLocaleString()} events</span>
      </div>
      <div className="chrome-spacer" />
    </header>
  );
}
