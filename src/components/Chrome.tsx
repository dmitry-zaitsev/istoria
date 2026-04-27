import { useStore } from "../store";

/// Always-on macOS titlebar strip. titleBarStyle: "Overlay" hides the
/// native bar, so the WebView owns the top edge — we render a
/// dedicated 28px draggable header with the active view name. Without
/// this strip, dragging the window relies on whatever empty space
/// happens to be left in the tabs row, which fails as soon as views
/// fill the row.
export function Chrome() {
  const views = useStore((s) => s.views);
  const activeId = useStore((s) => s.activeViewId);
  const active = views.find((v) => v.id === activeId);

  return (
    <header className="titlebar" data-tauri-drag-region>
      {/* Left spacer reserves room for the macOS traffic-light overlay. */}
      <div className="titlebar-traffic-spacer" data-tauri-drag-region />
      <div className="titlebar-center" data-tauri-drag-region>
        {active && <span className="session-tag">{active.name}</span>}
      </div>
      <div className="titlebar-right" data-tauri-drag-region />
    </header>
  );
}
