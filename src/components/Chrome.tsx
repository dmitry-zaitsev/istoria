interface ChromeProps {
  sessions?: string[];
}

/// Empty drag strip when single (or zero) sessions — only chrome
/// content shows up once the user is viewing more than one source.
export function Chrome({ sessions = [] }: ChromeProps) {
  if (sessions.length <= 1) {
    return <header className="win-titlebar empty" />;
  }
  return (
    <header className="win-titlebar">
      <div className="spacer" />
      <div className="win-side">
        {sessions.map((s) => (
          <span key={s} className="session-tag">
            {s}
          </span>
        ))}
      </div>
    </header>
  );
}
