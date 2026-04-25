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
import { RangeSlider, detectNumericFacets } from "./RangeSlider";

interface FacetsProps {
  events: LogEvent[];
  filter: string;
  onFilterChange: (q: string) => void;
}

const VISIBLE_CAP = 8;
const SEARCH_OVERFLOW = 10;

export function Facets({ events, filter, onFilterChange }: FacetsProps) {
  const groups = useMemo(() => computeFacets(events), [events]);
  const numericKeys = useMemo(() => new Set(detectNumericFacets(events)), [events]);
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
      {groups.map((g) =>
        numericKeys.has(g.key) ? (
          <RangeSlider
            key={g.key}
            events={events}
            fieldKey={g.key}
            label={g.label}
            filter={filter}
            onFilterChange={onFilterChange}
          />
        ) : (
          <Group key={g.key} group={g} pinned={pinned} onToggle={toggle} />
        ),
      )}
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
  const [showAll, setShowAll] = useState(false);
  const pinnedSet = pinned.get(group.key) ?? new Set<string>();
  const showSearch = group.values.length > SEARCH_OVERFLOW;

  const matched = search
    ? group.values.filter((v) =>
        v.value.toLowerCase().includes(search.toLowerCase()),
      )
    : group.values;

  // Always show pinned values regardless of cap so a checked value
  // never disappears off-screen. Then fill up to VISIBLE_CAP with the
  // top-count remaining values (or the full matched list when the
  // user has typed a search / clicked "show all").
  const pinnedVisible = matched.filter((v) => pinnedSet.has(v.value));
  const restRanked = matched.filter((v) => !pinnedSet.has(v.value));
  const capped = showAll || search ? restRanked : restRanked.slice(0, VISIBLE_CAP);
  const overflow = restRanked.length - capped.length;
  const visible = [...pinnedVisible, ...capped];

  if (group.values.length === 0) return null;

  return (
    <div className="facet-group">
      <div className="facet-h">{group.label}</div>
      {showSearch && (
        <input
          className="facet-search"
          placeholder="filter values…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}
      {visible.map((v) => (
        <FacetRow
          key={v.value}
          value={v.value}
          count={v.count}
          checked={pinnedSet.has(v.value)}
          onClick={() => onToggle(group.key, v.value)}
        />
      ))}
      {overflow > 0 && !search && (
        <div
          className="facet-more"
          role="button"
          onClick={() => setShowAll((x) => !x)}
        >
          {showAll ? "show less" : `show ${overflow.toLocaleString()} more`}
        </div>
      )}
    </div>
  );
}

function FacetRow({
  value,
  count,
  checked,
  onClick,
}: {
  value: string;
  count: number;
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <div
      className={`facet-row${checked ? " checked" : ""}`}
      onClick={onClick}
      role="button"
    >
      <span className={`facet-check${checked ? " on" : ""}`} aria-hidden>
        {checked ? "✓" : ""}
      </span>
      <span className="facet-value">{value || "∅"}</span>
      <span className="facet-count">{count.toLocaleString()}</span>
    </div>
  );
}
