interface JsonViewProps {
  value: unknown;
}

export function JsonView({ value }: JsonViewProps) {
  return (
    <pre className="json">
      <Node value={value} />
    </pre>
  );
}

function Node({ value }: { value: unknown }) {
  if (value === null) return <span className="null">null</span>;
  if (typeof value === "string")
    return <span className="s">"{escape(value)}"</span>;
  if (typeof value === "number")
    return <span className="n">{String(value)}</span>;
  if (typeof value === "boolean")
    return <span className="b">{String(value)}</span>;
  if (Array.isArray(value)) return <Arr items={value} />;
  if (typeof value === "object")
    return <Obj obj={value as Record<string, unknown>} />;
  return <span>{String(value)}</span>;
}

function Obj({ obj }: { obj: Record<string, unknown> }) {
  const entries = Object.entries(obj);
  if (entries.length === 0) return <>{"{}"}</>;
  return (
    <>
      {"{"}
      {entries.map(([k, v], i) => (
        <div className="json-line" key={k}>
          <span className="k">"{k}"</span>
          {": "}
          <Node value={v} />
          {i < entries.length - 1 ? "," : ""}
        </div>
      ))}
      {"}"}
    </>
  );
}

function Arr({ items }: { items: unknown[] }) {
  if (items.length === 0) return <>{"[]"}</>;
  return (
    <>
      {"["}
      {items.map((v, i) => (
        <div className="json-line" key={i}>
          <Node value={v} />
          {i < items.length - 1 ? "," : ""}
        </div>
      ))}
      {"]"}
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
