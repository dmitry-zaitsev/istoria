interface ChromeProps {
  count: number;
}

export function Chrome({ count }: ChromeProps) {
  return (
    <header className="win-titlebar">
      <div className="spacer" />
      <div className="win-side">
        <span>{count.toLocaleString()} events</span>
      </div>
    </header>
  );
}
