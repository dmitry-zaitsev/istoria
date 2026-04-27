import { highlight, type HighlightTerm } from "../lib/highlight";

interface JsonViewProps {
  value: unknown;
  onFilter?: (path: string, value: unknown) => void;
  onKeyFilter?: (path: string) => void;
  highlightTerms?: HighlightTerm[];
}

const TS_KEYS = new Set([
  "ts",
  "timestamp",
  "time",
  "created_at",
  "updated_at",
  "ended_at",
  "started_at",
]);
const TS_MS_FLOOR = 1_000_000_000_000; // 2001-09-09 — anything above this is plausibly Unix-ms.

export function JsonView({
  value,
  onFilter,
  onKeyFilter,
  highlightTerms,
}: JsonViewProps) {
  return (
    <>
      <Node
        value={value}
        indent={0}
        path=""
        onFilter={onFilter}
        onKeyFilter={onKeyFilter}
        highlightTerms={highlightTerms}
      />
    </>
  );
}

interface NodeProps {
  value: unknown;
  indent: number;
  keyName?: string;
  path: string;
  onFilter?: (path: string, value: unknown) => void;
  onKeyFilter?: (path: string) => void;
  highlightTerms?: HighlightTerm[];
}

function Node({
  value,
  indent,
  keyName,
  path,
  onFilter,
  onKeyFilter,
  highlightTerms,
}: NodeProps) {
  if (value === null) return <span className="p">null</span>;
  if (typeof value === "string")
    return (
      <Filterable path={path} value={value} onFilter={onFilter}>
        <span className="s">
          "{highlightTerms && highlightTerms.length > 0
            ? highlight(escape(value), highlightTerms)
            : escape(value)}"
        </span>
      </Filterable>
    );
  if (typeof value === "number") {
    return (
      <Filterable path={path} value={value} onFilter={onFilter}>
        <NumberNode value={value} keyName={keyName} />
      </Filterable>
    );
  }
  if (typeof value === "boolean")
    return (
      <Filterable path={path} value={value} onFilter={onFilter}>
        <span className="b">{String(value)}</span>
      </Filterable>
    );
  if (Array.isArray(value))
    return (
      <Arr
        items={value}
        indent={indent}
        path={path}
        onFilter={onFilter}
        onKeyFilter={onKeyFilter}
        highlightTerms={highlightTerms}
      />
    );
  if (typeof value === "object")
    return (
      <Obj
        obj={value as Record<string, unknown>}
        indent={indent}
        path={path}
        onFilter={onFilter}
        onKeyFilter={onKeyFilter}
        highlightTerms={highlightTerms}
      />
    );
  return <span>{String(value)}</span>;
}

function Filterable({
  path,
  value,
  onFilter,
  children,
}: {
  path: string;
  value: unknown;
  onFilter?: (p: string, v: unknown) => void;
  children: React.ReactNode;
}) {
  if (!onFilter || !path) return <>{children}</>;
  return (
    <span
      className="filterable"
      title={`Click to filter by ${path}`}
      onClick={(e) => {
        e.stopPropagation();
        onFilter(path, value);
      }}
    >
      {children}
    </span>
  );
}

function NumberNode({ value, keyName }: { value: number; keyName?: string }) {
  const isTs =
    keyName != null &&
    TS_KEYS.has(keyName) &&
    Number.isFinite(value) &&
    value >= TS_MS_FLOOR;
  if (!isTs) return <span className="n">{String(value)}</span>;
  return (
    <>
      <span className="n">{String(value)}</span>
      <span className="p" title="ISO local time">
        {" · "}
        {formatIso(value)}
      </span>
    </>
  );
}

function formatIso(unixMs: number): string {
  const d = new Date(unixMs);
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(
      d.getMilliseconds(),
      3,
    )}`
  );
}

function Obj({
  obj,
  indent,
  path,
  onFilter,
  onKeyFilter,
  highlightTerms,
}: {
  obj: Record<string, unknown>;
  indent: number;
  path: string;
  onFilter?: (p: string, v: unknown) => void;
  onKeyFilter?: (p: string) => void;
  highlightTerms?: HighlightTerm[];
}) {
  const entries = Object.entries(obj);
  if (entries.length === 0) return <span className="p">{"{}"}</span>;
  return (
    <>
      <span className="p">{"{"}</span>
      {entries.map(([k, v], i) => {
        const childPath = path ? `${path}.${k}` : k;
        const keyClickable = onKeyFilter != null;
        return (
          <div key={k} className="row indent">
            {keyClickable ? (
              <span
                className="k filterable filterable-key"
                title={`Click to filter by ${childPath}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onKeyFilter!(childPath);
                }}
              >
                "{k}"
              </span>
            ) : (
              <span className="k">"{k}"</span>
            )}
            <span className="p">: </span>
            <Node
              value={v}
              indent={indent + 1}
              keyName={k}
              path={childPath}
              onFilter={onFilter}
              onKeyFilter={onKeyFilter}
              highlightTerms={highlightTerms}
            />
            {i < entries.length - 1 && <span className="p">,</span>}
          </div>
        );
      })}
      <span className="p">{"}"}</span>
    </>
  );
}

function Arr({
  items,
  indent,
  path,
  onFilter,
  onKeyFilter,
  highlightTerms,
}: {
  items: unknown[];
  indent: number;
  path: string;
  onFilter?: (p: string, v: unknown) => void;
  onKeyFilter?: (p: string) => void;
  highlightTerms?: HighlightTerm[];
}) {
  if (items.length === 0) return <span className="p">[]</span>;
  return (
    <>
      <span className="p">{"["}</span>
      {items.map((v, i) => (
        <div key={i} className="row indent">
          <Node
            value={v}
            indent={indent + 1}
            path={`${path}.${i}`}
            onFilter={onFilter}
            onKeyFilter={onKeyFilter}
            highlightTerms={highlightTerms}
          />
          {i < items.length - 1 && <span className="p">,</span>}
        </div>
      ))}
      <span className="p">{"]"}</span>
    </>
  );
}

function escape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}
