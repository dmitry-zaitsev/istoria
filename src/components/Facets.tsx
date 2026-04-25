import { useMemo, useState } from "react";

import {
  addClause,
  computeFacets,
  pinnedFromAst,
  removeClause,
  type FacetGroup,
} from "../lib/facets";
import type { LogEvent } from "../lib/ipc";
import { isError, parse, type Ast } from "../lib/query";

interface FacetsProps {
  events: LogEvent[];
  filter: string;
  onFilterChange: (q: string) => void;
}

const SEARCH_OVERFLOW = 10;

export function Facets({ events, filter, onFilterChange }: FacetsProps) {
  const groups = useMemo(() => computeFacets(events), [events]);
  const ast: Ast | null = useMemo(() => {
    const r = parse(filter);
    return isError(r) ? null : r;
  }, [filter]);
  const pinned = useMemo(() => pinnedFromAst(ast), [ast]);

  const toggle = (key: string, value: string) => {
    const set = pinned.get(key);
    if (set?.has(value)) {
      onFilterChange(removeClause(filter, key, value));
    } else {
      onFilterChange(addClause(filter, key, value));
    }
  };

  return (
    <aside className="facets">
      {groups.map((g) => (
        <Group key={g.key} group={g} pinned={pinned} onToggle={toggle} />
      ))}
    </aside>
  );
}

function Group({
  group,
  pinned,
  onToggle,
}: {
  group: FacetGroup;
  pinned: Map<string, Set<string>>;
  onToggle: (key: string, value: string) => void;
}) {
  const [search, setSearch] = useState("");
  const pinnedSet = pinned.get(group.key) ?? new Set<string>();
  const pinnedValues = group.values.filter((v) => pinnedSet.has(v.value));
  const others = group.values.filter((v) => !pinnedSet.has(v.value));
  const showSearch = others.length > SEARCH_OVERFLOW;
  const filteredOthers = showSearch && search
    ? others.filter((v) => v.value.toLowerCase().includes(search.toLowerCase()))
    : others;

  if (group.values.length === 0) return null;

  return (
    <div className="facet-group">
      <div className="facet-h">{group.label}</div>
      {pinnedValues.map((v) => (
        <FacetRow
          key={v.value}
          value={v.value}
          count={v.count}
          pinned
          onClick={() => onToggle(group.key, v.value)}
        />
      ))}
      {pinnedValues.length > 0 && others.length > 0 && (
        <div className="facet-others">OTHERS · {others.length}</div>
      )}
      {showSearch && (
        <input
          className="facet-search"
          placeholder="filter values…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}
      {filteredOthers.map((v) => (
        <FacetRow
          key={v.value}
          value={v.value}
          count={v.count}
          pinned={false}
          onClick={() => onToggle(group.key, v.value)}
        />
      ))}
    </div>
  );
}

function FacetRow({
  value,
  count,
  pinned,
  onClick,
}: {
  value: string;
  count: number;
  pinned: boolean;
  onClick: () => void;
}) {
  return (
    <div
      className={`facet-row${pinned ? " pinned" : ""}`}
      onClick={onClick}
      role="button"
    >
      <span className="facet-star" aria-hidden>
        {pinned ? "★" : "☆"}
      </span>
      <span className="facet-value">{value || "∅"}</span>
      <span className="facet-count">{count.toLocaleString()}</span>
    </div>
  );
}
