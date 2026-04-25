interface JsonViewProps {
  value: unknown;
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

export function JsonView({ value }: JsonViewProps) {
  return (
    <>
      <Node value={value} indent={0} />
    </>
  );
}

function Node({
  value,
  indent,
  keyName,
}: {
  value: unknown;
  indent: number;
  keyName?: string;
}) {
  if (value === null) return <span className="p">null</span>;
  if (typeof value === "string")
    return <span className="s">"{escape(value)}"</span>;
  if (typeof value === "number") {
    return <NumberNode value={value} keyName={keyName} />;
  }
  if (typeof value === "boolean")
    return <span className="b">{String(value)}</span>;
  if (Array.isArray(value)) return <Arr items={value} indent={indent} />;
  if (typeof value === "object")
    return <Obj obj={value as Record<string, unknown>} indent={indent} />;
  return <span>{String(value)}</span>;
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
}: {
  obj: Record<string, unknown>;
  indent: number;
}) {
  const entries = Object.entries(obj);
  if (entries.length === 0) return <span className="p">{"{}"}</span>;
  return (
    <>
      <span className="p">{"{"}</span>
      {entries.map(([k, v], i) => (
        <div key={k} className="row indent">
          <span className="k">"{k}"</span>
          <span className="p">: </span>
          <Node value={v} indent={indent + 1} keyName={k} />
          {i < entries.length - 1 && <span className="p">,</span>}
        </div>
      ))}
      <span className="p">{"}"}</span>
    </>
  );
}

function Arr({ items, indent }: { items: unknown[]; indent: number }) {
  if (items.length === 0) return <span className="p">[]</span>;
  return (
    <>
      <span className="p">{"["}</span>
      {items.map((v, i) => (
        <div key={i} className="row indent">
          <Node value={v} indent={indent + 1} />
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
