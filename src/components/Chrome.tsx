interface ChromeProps {
  live: boolean;
  count: number;
  session: string;
}

export function Chrome({ live, count, session }: ChromeProps) {
  return (
    <header className="win-titlebar">
      <div className="spacer" />
      <div className="win-title">
        logs · session #{session}
      </div>
      <div className="win-side">
        <span className={`live-dot${live ? "" : " idle"}`} />
        <span>{live ? "live" : "idle"} · {count.toLocaleString()}</span>
      </div>
    </header>
  );
}
