import { useMemo, useState } from "react";

import { pinnedFromAst, TOP_N_FACET_GROUPS, toggleFacetOr, type FacetGroup } from "../lib/facets";
import type { LogEvent } from "../lib/ipc";
import { isError, parse, type Ast } from "../lib/query";
import { RangeSlider, detectNumericFacets } from "./RangeSlider";

interface FacetsProps {
  events: LogEvent[];
  /// Pre-computed facet groups from App.tsx, which maintains a
  /// `FacetIndex` incrementally as events arrive. Avoids a second
  /// O(n × payload-depth) walk inside this component.
  groups: FacetGroup[];
  filter: string;
  onFilterChange: (q: string) => void;
}

const VISIBLE_CAP = 8;
const SEARCH_OVERFLOW = 10;

export function Facets({ events, groups, filter, onFilterChange }: FacetsProps) {
  const numericKeys = useMemo(() => new Set(detectNumericFacets(events)), [events]);
  const ast: Ast | null = useMemo(() => {
    const r = parse(filter);
    return isError(r) ? null : r;
  }, [filter]);
  const pinned = useMemo(() => pinnedFromAst(ast), [ast]);
  const [keySearch, setKeySearch] = useState("");

  const toggle = (key: string, value: string) => {
    onFilterChange(toggleFacetOr(filter, key, value));
  };

  // When the user types in the top-level search, surface ANY group
  // (or any value within a group) that matches; otherwise cap at the
  // top N groups by cardinality + level/source.
  const q = keySearch.trim().toLowerCase();
  const matchedGroups: FacetGroup[] = q
    ? groups.filter(
        (g) =>
          g.key.toLowerCase().includes(q) ||
          g.label.toLowerCase().includes(q) ||
          g.values.some((v) => v.value.toLowerCase().includes(q))
      )
    : groups.slice(0, TOP_N_FACET_GROUPS);
  const hidden = q ? 0 : Math.max(0, groups.length - matchedGroups.length);

  return (
    <aside className="facets">
      <div className="facet-key-search-wrap">
        <input
          className="facet-key-search"
          placeholder={hidden > 0 ? `search facets (+${hidden} hidden)…` : "search facets…"}
          value={keySearch}
          onChange={(e) => setKeySearch(e.target.value)}
        />
      </div>
      {matchedGroups.map((g) =>
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
          <Group key={g.key} group={g} pinned={pinned} onToggle={toggle} valueFilter={q} />
        )
      )}
      {matchedGroups.length === 0 && <div className="facet-empty">No facets match.</div>}
    </aside>
  );
}

function Group({
  group,
  pinned,
  onToggle,
  valueFilter,
}: {
  group: FacetGroup;
  pinned: Map<string, Set<string>>;
  onToggle: (key: string, value: string) => void;
  valueFilter?: string;
}) {
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const pinnedSet = pinned.get(group.key) ?? new Set<string>();
  // Hide the per-group "filter values…" input while the top-level
  // facet search is engaged — one filter at a time keeps the mental
  // model simple. Stale per-group `search` state is ignored too.
  const showSearch = group.values.length > SEARCH_OVERFLOW && !valueFilter;
  const effectiveSearch = showSearch ? search : "";
  const effective = valueFilter || effectiveSearch;
  const matched = effective
    ? group.values.filter((v) => v.value.toLowerCase().includes(effective.toLowerCase()))
    : group.values;
  // Top-level search hit the group by key/label but no value text
  // matched — fall back to top values so the user can actually see
  // what's in the facet instead of staring at an empty header.
  const nameOnlyHit = !!valueFilter && matched.length === 0 && group.values.length > 0;
  const displayed = nameOnlyHit ? group.values : matched;

  // Keep the original count-desc order. Toggling a checkbox must NOT
  // reorder the list — pinned values stay where they are. To keep
  // pinned values from disappearing off-screen when the cap kicks in,
  // we apply the cap by *count rank*: index 0..VISIBLE_CAP-1 OR
  // pinned regardless of position.
  const cappedSet = new Set<string>();
  let kept = 0;
  for (const v of displayed) {
    const isPinned = pinnedSet.has(v.value);
    if (isPinned || showAll || effectiveSearch || kept < VISIBLE_CAP) {
      cappedSet.add(v.value);
      if (!isPinned) kept++;
    }
  }
  const visible = displayed.filter((v) => cappedSet.has(v.value));
  const overflow = displayed.length - visible.length;

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
      {overflow > 0 && !effectiveSearch && (
        <div className="facet-more" role="button" onClick={() => setShowAll((x) => !x)}>
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
    <div className={`facet-row${checked ? " checked" : ""}`} onClick={onClick} role="button">
      <span className={`facet-check${checked ? " on" : ""}`} aria-hidden>
        {checked ? "✓" : ""}
      </span>
      <span className="facet-value">{value || "∅"}</span>
      <span className="facet-count">{count.toLocaleString()}</span>
    </div>
  );
}
