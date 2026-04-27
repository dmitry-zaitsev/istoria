import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";

import { useStore } from "../store";
import {
  createViewLocal,
  deleteViewLocal,
  duplicateViewLocal,
  loadViews,
  saveActiveViewId,
  updateViewLocal,
  type View,
} from "../lib/views";
import { toast } from "../lib/toast";

export function Tabs() {
  const views = useStore((s) => s.views);
  const activeId = useStore((s) => s.activeViewId);
  const setViews = useStore((s) => s.setViews);
  const setActiveId = useStore((s) => s.setActiveViewId);
  const setFilter = useStore((s) => s.setFilter);
  const filter = useStore((s) => s.filter);
  const sources = useStore((s) => s.sources);

  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const renameRef = useRef<HTMLInputElement | null>(null);

  // Persist filter edits back to the active view (debounced via effect).
  useEffect(() => {
    if (activeId == null) return;
    const v = views.find((x) => x.id === activeId);
    if (!v || v.query === filter) return;
    const handle = window.setTimeout(() => {
      try {
        updateViewLocal(activeId, v.name, filter);
        setViews(loadViews());
      } catch (e) {
        toast(`view persist failed: ${String(e)}`);
      }
    }, 400);
    return () => window.clearTimeout(handle);
  }, [filter, activeId, views, setViews]);

  useEffect(() => {
    if (renaming != null) renameRef.current?.focus();
  }, [renaming]);

  const onSelect = (v: View) => {
    setActiveId(v.id);
    setFilter(v.query);
    saveActiveViewId(v.id);
  };

  const onCreate = () => {
    try {
      const name = `View ${views.length + 1}`;
      const created = createViewLocal(name, "");
      setViews(loadViews());
      onSelect(created);
    } catch (e) {
      toast(`new view failed: ${String(e)}`);
    }
  };

  const onClose = (e: React.MouseEvent, v: View) => {
    e.stopPropagation();
    if (views.length <= 1) return;
    deleteViewLocal(v.id);
    const all = loadViews();
    setViews(all);
    if (activeId === v.id) {
      const next = all[0];
      if (next) onSelect(next);
    }
  };

  const onDuplicate = (v: View) => {
    const dup = duplicateViewLocal(v.id);
    setViews(loadViews());
    setMenuFor(null);
    if (dup) onSelect(dup);
  };

  const onRenameSubmit = (v: View, value: string) => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== v.name) {
      updateViewLocal(v.id, trimmed, v.query);
      setViews(loadViews());
    }
    setRenaming(null);
  };

  return (
    <div className="tabs">
      {views.map((v) => {
        const active = v.id === activeId;
        return (
          <div
            key={v.id}
            className={`tab${active ? " active" : ""}`}
            onClick={() => onSelect(v)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenuFor(v.id);
            }}
          >
            {renaming === v.id ? (
              <input
                ref={renameRef}
                className="tab-rename"
                defaultValue={v.name}
                onKeyDown={(e) => {
                  if (e.key === "Enter")
                    void onRenameSubmit(v, e.currentTarget.value);
                  if (e.key === "Escape") setRenaming(null);
                }}
                onBlur={(e) => void onRenameSubmit(v, e.currentTarget.value)}
              />
            ) : (
              <span className="tab-name">{v.name}</span>
            )}
            <span
              className="tab-close"
              role="button"
              aria-label={`close ${v.name}`}
              onClick={(e) => void onClose(e, v)}
            >
              ×
            </span>
            {menuFor === v.id && (
              <div className="tab-menu" onClick={(e) => e.stopPropagation()}>
                <div
                  className="tab-menu-item"
                  onClick={() => {
                    setRenaming(v.id);
                    setMenuFor(null);
                  }}
                >
                  Rename
                </div>
                <div className="tab-menu-item" onClick={() => onDuplicate(v)}>
                  Duplicate
                </div>
                {views.length > 1 && (
                  <div
                    className="tab-menu-item danger"
                    onClick={(e) => {
                      setMenuFor(null);
                      void onClose(e, v);
                    }}
                  >
                    Delete
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      <button
        type="button"
        className="tab-add"
        title="New view"
        onClick={onCreate}
      >
        +
      </button>
      {/* Leaf drag-region: explicit startDragging() on mousedown is
          the reliable path — the data-tauri-drag-region attribute
          alone has been hit-or-miss on this build. Keep the attribute
          too as a fallback. The handler runs only on the empty fill
          area so buttons/tabs above stay interactive. */}
      <div
        className="tabs-drag-fill"
        data-tauri-drag-region
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          getCurrentWindow()
            .startDragging()
            .catch(() => {});
        }}
      />
      {sources.length > 0 && (
        <div className="tabs-sources" title="Active log sources">
          {sources.map((s) => (
            <span key={s} className="session-tag">
              {s}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
