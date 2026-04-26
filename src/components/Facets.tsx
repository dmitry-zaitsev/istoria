import { useMemo, useState } from "react";

import {
  computeFacets,
  pinnedFromAst,
  toggleFacetOr,
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
    onFilterChange(toggleFacetOr(filter, key, value));
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

  // Keep the original count-desc order. Toggling a checkbox must NOT
  // reorder the list — pinned values stay where they are. To keep
  // pinned values from disappearing off-screen when the cap kicks in,
  // we apply the cap by *count rank*: index 0..VISIBLE_CAP-1 OR
  // pinned regardless of position.
  const cappedSet = new Set<string>();
  let kept = 0;
  for (const v of matched) {
    const isPinned = pinnedSet.has(v.value);
    if (isPinned || showAll || search || kept < VISIBLE_CAP) {
      cappedSet.add(v.value);
      if (!isPinned) kept++;
    }
  }
  const visible = matched.filter((v) => cappedSet.has(v.value));
  const overflow = matched.length - visible.length;

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
