import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { useStore, type ColKey, type FieldColumn } from "../store";

interface ColumnHeaderProps {
  visibility: Record<ColKey, boolean>;
  fieldColumns: FieldColumn[];
  availableFieldKeys: string[];
}

type DragTarget = { kind: "builtin"; col: ColKey } | { kind: "field"; path: string };

interface DragState {
  target: DragTarget;
  startX: number;
  startW: number;
}

type MenuState =
  | { kind: "builtin"; col: ColKey; anchor: DOMRect }
  | { kind: "field"; path: string; anchor: DOMRect }
  | { kind: "picker"; anchor: DOMRect };

type PickerEntry =
  | { kind: "builtin"; key: ColKey; label: string; visible: boolean }
  | { kind: "field"; path: string; visible: boolean };

const BUILTIN_LABELS: Record<ColKey, string> = {
  ts: "time",
  lvl: "level",
  src: "source",
  br: "branch",
};

export function ColumnHeader({ visibility, fieldColumns, availableFieldKeys }: ColumnHeaderProps) {
  const widths = useStore((s) => s.columnWidths);
  const setColumnWidth = useStore((s) => s.setColumnWidth);
  const setColumnVisible = useStore((s) => s.setColumnVisible);
  const toggleFieldColumn = useStore((s) => s.toggleFieldColumn);
  const setFieldColumnWidth = useStore((s) => s.setFieldColumnWidth);
  const [activeDrag, setActiveDrag] = useState<DragTarget | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const next = d.startW + (e.clientX - d.startX);
      if (d.target.kind === "builtin") setColumnWidth(d.target.col, next);
      else setFieldColumnWidth(d.target.path, next);
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      setActiveDrag(null);
      document.body.classList.remove("col-resizing");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [setColumnWidth, setFieldColumnWidth]);

  const startDrag = (target: DragTarget, currentWidth: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    dragRef.current = {
      target,
      startX: e.clientX,
      startW: currentWidth,
    };
    setActiveDrag(target);
    document.body.classList.add("col-resizing");
  };

  const isDragging = (target: DragTarget) => {
    if (!activeDrag) return false;
    if (activeDrag.kind !== target.kind) return false;
    if (activeDrag.kind === "builtin" && target.kind === "builtin")
      return activeDrag.col === target.col;
    if (activeDrag.kind === "field" && target.kind === "field")
      return activeDrag.path === target.path;
    return false;
  };

  const closeMenu = () => setMenu(null);

  const buildPickerEntries = (): PickerEntry[] => {
    const entries: PickerEntry[] = [];
    for (const k of ["ts", "lvl", "src", "br"] as const) {
      entries.push({
        kind: "builtin",
        key: k,
        label: BUILTIN_LABELS[k],
        visible: visibility[k],
      });
    }
    const fieldSet = new Set(fieldColumns.map((c) => c.path));
    const seen = new Set<string>();
    for (const path of availableFieldKeys) {
      seen.add(path);
      entries.push({
        kind: "field",
        path,
        visible: fieldSet.has(path),
      });
    }
    for (const fc of fieldColumns) {
      if (seen.has(fc.path)) continue;
      entries.push({ kind: "field", path: fc.path, visible: true });
    }
    return entries;
  };

  const togglePickerEntry = (e: PickerEntry) => {
    if (e.kind === "builtin") setColumnVisible(e.key, !e.visible);
    else toggleFieldColumn(e.path);
  };

  return (
    <div className="col-header">
      {visibility.ts && (
        <ColCell
          label={BUILTIN_LABELS.ts}
          onLabelClick={(rect) => setMenu({ kind: "builtin", col: "ts", anchor: rect })}
          onHandleDown={startDrag({ kind: "builtin", col: "ts" }, widths.ts)}
          dragging={isDragging({ kind: "builtin", col: "ts" })}
        />
      )}
      {visibility.lvl && (
        <ColCell
          label={BUILTIN_LABELS.lvl}
          onLabelClick={(rect) => setMenu({ kind: "builtin", col: "lvl", anchor: rect })}
          onHandleDown={startDrag({ kind: "builtin", col: "lvl" }, widths.lvl)}
          dragging={isDragging({ kind: "builtin", col: "lvl" })}
        />
      )}
      {visibility.src && (
        <ColCell
          label={BUILTIN_LABELS.src}
          onLabelClick={(rect) => setMenu({ kind: "builtin", col: "src", anchor: rect })}
          onHandleDown={startDrag({ kind: "builtin", col: "src" }, widths.src)}
          dragging={isDragging({ kind: "builtin", col: "src" })}
        />
      )}
      {visibility.br && (
        <ColCell
          label={BUILTIN_LABELS.br}
          onLabelClick={(rect) => setMenu({ kind: "builtin", col: "br", anchor: rect })}
          onHandleDown={startDrag({ kind: "builtin", col: "br" }, widths.br)}
          dragging={isDragging({ kind: "builtin", col: "br" })}
        />
      )}
      {fieldColumns.map((fc) => (
        <ColCell
          key={fc.path}
          label={fc.path}
          onLabelClick={(rect) => setMenu({ kind: "field", path: fc.path, anchor: rect })}
          onHandleDown={startDrag({ kind: "field", path: fc.path }, fc.width)}
          dragging={isDragging({ kind: "field", path: fc.path })}
        />
      ))}
      <div className="col-cell">message</div>
      <div className="col-pin">
        <button
          type="button"
          className="col-add-btn"
          aria-label="Pick columns"
          title="Pick columns"
          onClick={(e) => {
            e.stopPropagation();
            setMenu({
              kind: "picker",
              anchor: e.currentTarget.getBoundingClientRect(),
            });
          }}
        >
          +
        </button>
      </div>
      {menu && (
        <ColPopover anchor={menu.anchor} onClose={closeMenu}>
          {menu.kind === "builtin" && (
            <>
              <button
                type="button"
                className="col-popover-item"
                onClick={() => {
                  setColumnVisible(menu.col, false);
                  closeMenu();
                }}
              >
                Hide column
              </button>
            </>
          )}
          {menu.kind === "field" && (
            <button
              type="button"
              className="col-popover-item"
              onClick={() => {
                toggleFieldColumn(menu.path);
                closeMenu();
              }}
            >
              Remove column
            </button>
          )}
          {menu.kind === "picker" && (
            <ColumnPicker entries={buildPickerEntries()} onToggle={togglePickerEntry} />
          )}
        </ColPopover>
      )}
    </div>
  );
}

function ColCell({
  label,
  onLabelClick,
  onHandleDown,
  dragging,
}: {
  label: string;
  onLabelClick: (anchor: DOMRect) => void;
  onHandleDown: (e: React.PointerEvent) => void;
  dragging: boolean;
}) {
  return (
    <div className="col-cell">
      <span
        className="col-cell-label"
        title={`Click for column options on ${label}`}
        onClick={(e) => {
          e.stopPropagation();
          onLabelClick(e.currentTarget.getBoundingClientRect());
        }}
      >
        {label}
      </span>
      <div className={`col-handle${dragging ? " active" : ""}`} onPointerDown={onHandleDown} />
    </div>
  );
}

function ColumnPicker({
  entries,
  onToggle,
}: {
  entries: PickerEntry[];
  onToggle: (e: PickerEntry) => void;
}) {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const labelOf = (e: PickerEntry) => (e.kind === "builtin" ? e.label : e.path);
  const filtered = q
    ? entries.filter((e) => labelOf(e).toLowerCase().includes(q.toLowerCase()))
    : entries;
  return (
    <div className="col-picker">
      <input
        ref={inputRef}
        type="text"
        className="col-picker-input"
        placeholder="Search columns…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <div className="col-picker-list">
        {filtered.length === 0 && <div className="col-popover-empty">No matches.</div>}
        {filtered.map((e) => (
          <PickerRow key={pickerEntryKey(e)} entry={e} label={labelOf(e)} onToggle={onToggle} />
        ))}
      </div>
    </div>
  );
}

function pickerEntryKey(e: PickerEntry): string {
  return e.kind === "builtin" ? `b:${e.key}` : `f:${e.path}`;
}

function PickerRow({
  entry,
  label,
  onToggle,
}: {
  entry: PickerEntry;
  label: string;
  onToggle: (e: PickerEntry) => void;
}) {
  return (
    <button
      type="button"
      className={`col-picker-item${entry.visible ? " on" : ""}`}
      onClick={() => onToggle(entry)}
      title={label}
    >
      <span className="col-picker-check">{entry.visible ? "✓" : ""}</span>
      <span className="col-picker-label">{label}</span>
    </button>
  );
}

function ColPopover({
  anchor,
  onClose,
  children,
}: {
  anchor: DOMRect;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({
    top: anchor.bottom + 4,
    left: anchor.left,
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let top = anchor.bottom + 4;
    let left = anchor.left;
    if (left + rect.width > window.innerWidth - pad) {
      left = Math.max(pad, window.innerWidth - rect.width - pad);
    }
    if (top + rect.height > window.innerHeight - pad) {
      top = Math.max(pad, anchor.top - rect.height - 4);
    }
    setPos({ top, left });
  }, [anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="col-popover"
      role="menu"
      style={{ top: pos.top, left: pos.left }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}
