interface JsonViewProps {
  value: unknown;
}

export function JsonView({ value }: JsonViewProps) {
  return (
    <>
      <Node value={value} indent={0} />
    </>
  );
}

function Node({ value, indent }: { value: unknown; indent: number }) {
  if (value === null) return <span className="p">null</span>;
  if (typeof value === "string")
    return <span className="s">"{escape(value)}"</span>;
  if (typeof value === "number")
    return <span className="n">{String(value)}</span>;
  if (typeof value === "boolean")
    return <span className="b">{String(value)}</span>;
  if (Array.isArray(value)) return <Arr items={value} indent={indent} />;
  if (typeof value === "object")
    return <Obj obj={value as Record<string, unknown>} indent={indent} />;
  return <span>{String(value)}</span>;
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
          <Node value={v} indent={indent + 1} />
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
