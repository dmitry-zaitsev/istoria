interface ChromeProps {
  sessions?: string[];
}

/// Empty drag strip when single (or zero) sessions — only chrome
/// content shows up once the user is viewing more than one source.
export function Chrome({ sessions = [] }: ChromeProps) {
  // Single-session: no chrome at all. Traffic lights overlay the
  // tabs row (titleBarStyle: Overlay) and the tabs row carries the
  // drag region.
  if (sessions.length <= 1) return null;
  return (
    <header className="win-titlebar" data-tauri-drag-region>
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
