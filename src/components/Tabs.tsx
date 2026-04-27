import { useEffect, useRef, useState } from "react";

import { useStore } from "../store";
import {
  createView,
  deleteView,
  duplicateView,
  listViews,
  setMeta,
  updateView,
  type View,
} from "../lib/ipc";

export function Tabs() {
  const views = useStore((s) => s.views);
  const activeId = useStore((s) => s.activeViewId);
  const setViews = useStore((s) => s.setViews);
  const setActiveId = useStore((s) => s.setActiveViewId);
  const setFilter = useStore((s) => s.setFilter);
  const filter = useStore((s) => s.filter);

  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const renameRef = useRef<HTMLInputElement | null>(null);

  // Persist filter edits back to the active view (debounced via effect).
  useEffect(() => {
    if (activeId == null) return;
    const v = views.find((x) => x.id === activeId);
    if (!v || v.query === filter) return;
    const handle = window.setTimeout(() => {
      void updateView(activeId, v.name, filter).then(async () => {
        const all = await listViews();
        setViews(all);
      });
    }, 400);
    return () => window.clearTimeout(handle);
  }, [filter, activeId, views, setViews]);

  useEffect(() => {
    if (renaming != null) renameRef.current?.focus();
  }, [renaming]);

  const onSelect = (v: View) => {
    setActiveId(v.id);
    setFilter(v.query);
    void setMeta("active_view", String(v.id));
  };

  const onCreate = async () => {
    const name = `View ${views.length + 1}`;
    const created = await createView(name, "");
    const all = await listViews();
    setViews(all);
    onSelect(created);
  };

  const onClose = async (e: React.MouseEvent, v: View) => {
    e.stopPropagation();
    if (views.length <= 1) return;
    await deleteView(v.id);
    const all = await listViews();
    setViews(all);
    if (activeId === v.id) {
      const next = all[0];
      if (next) onSelect(next);
    }
  };

  const onDuplicate = async (v: View) => {
    const dup = await duplicateView(v.id);
    const all = await listViews();
    setViews(all);
    setMenuFor(null);
    onSelect(dup);
  };

  const onRenameSubmit = async (v: View, value: string) => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== v.name) {
      await updateView(v.id, trimmed, v.query);
      const all = await listViews();
      setViews(all);
    }
    setRenaming(null);
  };

  return (
    <div className="tabs" data-tauri-drag-region>
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
    </div>
  );
}
