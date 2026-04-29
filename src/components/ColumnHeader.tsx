import { useEffect, useRef, useState } from "react";

import { useStore, type ColKey } from "../store";

interface ColumnHeaderProps {
  showSource: boolean;
}

interface DragState {
  col: ColKey;
  startX: number;
  startW: number;
}

export function ColumnHeader({ showSource }: ColumnHeaderProps) {
  const widths = useStore((s) => s.columnWidths);
  const setColumnWidth = useStore((s) => s.setColumnWidth);
  const [active, setActive] = useState<ColKey | null>(null);
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setColumnWidth(d.col, d.startW + (e.clientX - d.startX));
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      setActive(null);
      document.body.classList.remove("col-resizing");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [setColumnWidth]);

  const onHandleDown = (col: ColKey) => (e: React.PointerEvent) => {
    e.preventDefault();
    dragRef.current = { col, startX: e.clientX, startW: widths[col] };
    setActive(col);
    document.body.classList.add("col-resizing");
  };

  return (
    <div className={`col-header${showSource ? "" : " no-src"}`}>
      <div className="col-cell">
        time
        <div
          className={`col-handle${active === "ts" ? " active" : ""}`}
          onPointerDown={onHandleDown("ts")}
        />
      </div>
      <div className="col-cell">
        level
        <div
          className={`col-handle${active === "lvl" ? " active" : ""}`}
          onPointerDown={onHandleDown("lvl")}
        />
      </div>
      {showSource && (
        <div className="col-cell">
          source
          <div
            className={`col-handle${active === "src" ? " active" : ""}`}
            onPointerDown={onHandleDown("src")}
          />
        </div>
      )}
      <div className="col-cell">message</div>
      <div className="col-pin" />
    </div>
  );
}
