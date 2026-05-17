import { useMemo, useRef, useState } from "react";

import { isFacetActive, toggleFacetOr } from "../lib/facets";
import { listEditors, openUrl, type RelevanceSite } from "../lib/ipc";
import { useStore } from "../store";
import { highlightLine, languageForPath } from "../lib/syntax";

// Tabs-mounted pill: clicking toggles `relevant:true` in the filter;
// hovering reveals a popover listing the touched + indirect-referrer
// log call sites grouped by source.

export function RelevancePill() {
  const relevantIds = useStore((s) => s.relevantIds);
  const sites = useStore((s) => s.relevanceSites);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const sources = useStore((s) => s.sources);

  const [hover, setHover] = useState(false);
  const hideTimer = useRef<number | null>(null);

  const count = relevantIds.size;
  const active = isFacetActive(filter, "relevant", "true");

  // Group sites: source → kind → list. Direct sites first within each
  // source.
  const grouped = useMemo(() => groupSites(sites), [sites]);

  if (count === 0) return null;

  const openHover = () => {
    if (hideTimer.current != null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    setHover(true);
  };
  const scheduleClose = () => {
    if (hideTimer.current != null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setHover(false), 120);
  };

  const handleClick = () => {
    setFilter(toggleFacetOr(filter, "relevant", "true"));
  };

  const multiSource = sources.length > 1;

  return (
    <div className="relevance-pill-wrap" onMouseEnter={openHover} onMouseLeave={scheduleClose}>
      <button
        type="button"
        className={`relevance-pill${active ? " active" : ""}`}
        onClick={handleClick}
        title={`${count} log event${count === 1 ? "" : "s"} from your branch changes`}
        aria-pressed={active}
      >
        <span className="relevance-dot" aria-hidden="true" />
        <span className="relevance-count">{count}</span>
      </button>
      {hover && (
        <div className="relevance-popover" onMouseEnter={openHover} onMouseLeave={scheduleClose}>
          <div className="relevance-popover-title">Logs from your branch changes</div>
          {grouped.map((g) => (
            <div key={g.source} className="relevance-source-group">
              {multiSource && <div className="relevance-source-head">{g.source}</div>}
              {g.direct.length > 0 && <SiteList kindLabel={null} sites={g.direct} />}
              {g.indirect.length > 0 && <SiteList kindLabel="Indirect" sites={g.indirect} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface Grouped {
  source: string;
  direct: RelevanceSite[];
  indirect: RelevanceSite[];
}

function groupSites(sites: RelevanceSite[]): Grouped[] {
  const bySource = new Map<string, Grouped>();
  for (const s of sites) {
    let g = bySource.get(s.source);
    if (!g) {
      g = { source: s.source, direct: [], indirect: [] };
      bySource.set(s.source, g);
    }
    if (s.kind.kind === "direct") g.direct.push(s);
    else g.indirect.push(s);
  }
  for (const g of bySource.values()) {
    g.direct.sort(siteCmp);
    g.indirect.sort(siteCmp);
  }
  return [...bySource.values()].toSorted((a, b) => a.source.localeCompare(b.source));
}

function siteCmp(a: RelevanceSite, b: RelevanceSite) {
  return a.rel_path.localeCompare(b.rel_path) || a.line - b.line;
}

interface SiteListProps {
  kindLabel: string | null;
  sites: RelevanceSite[];
}

function SiteList({ kindLabel, sites }: SiteListProps) {
  return (
    <div className="relevance-site-list">
      {kindLabel && <div className="relevance-kind-label">{kindLabel}</div>}
      {sites.map((s) => (
        <SiteRow key={`${s.rel_path}:${s.line}`} site={s} />
      ))}
    </div>
  );
}

function SiteRow({ site }: { site: RelevanceSite }) {
  const lang = languageForPath(site.rel_path);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const filterValue = useMemo(() => buildFilterValue(site.raw_call), [site.raw_call]);
  const filterActive = filterValue != null && isFacetActive(filter, "msg", filterValue);

  const openEditor = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const editors = await listEditors();
      const editor = editors[0];
      if (!editor) return;
      const url = editor.url_template
        .replace("{path}", encodeURI(site.abs_path))
        .replace("{line}", String(site.line));
      await openUrl(url);
    } catch {
      // best-effort
    }
  };

  const toggleFilter = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (filterValue == null) return;
    setFilter(toggleFacetOr(filter, "msg", filterValue));
  };

  const via = site.kind.kind === "indirect" ? site.kind.via_files.join(", ") : null;
  return (
    <div className="relevance-site">
      <button
        type="button"
        className="relevance-site-head"
        onClick={openEditor}
        title="Open in editor"
      >
        <span className="relevance-site-path">
          {site.rel_path}
          <span className="relevance-site-line">:{site.line}</span>
        </span>
        <span className="relevance-site-count">×{site.emitted_count}</span>
      </button>
      {via && (
        <div className="relevance-site-via">
          <span className="relevance-site-via-tag">via</span> {via}
        </div>
      )}
      <pre className="code-preview relevance-site-snippet hljs">
        {site.snippet.map((ln) => (
          <div key={ln.line} className="code-row">
            <span className="code-row-no">{ln.line}</span>
            <span
              className="code-row-text"
              dangerouslySetInnerHTML={{ __html: highlightLine(ln.text, lang) }}
            />
          </div>
        ))}
      </pre>
      {filterValue != null && (
        <div className="relevance-site-actions">
          <button
            type="button"
            className={`relevance-filter-btn${filterActive ? " active" : ""}`}
            onClick={toggleFilter}
            title={
              filterActive ? "Remove this pattern from the filter" : "Show only logs from this call"
            }
          >
            <FunnelIcon />
            <span>{filterActive ? "Filtering" : "Filter"}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function FunnelIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M2.5 3h11l-4 5v4l-3 1.5V8z" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/// Derive a `msg:` glob value from the call's source text. Picks each
/// string-literal segment, splits on format placeholders / template
/// expressions, keeps pieces with >=2 alphanumeric chars, joins with
/// `*` so order-preserving runtime messages still match.
function buildFilterValue(rawCall: string): string | null {
  const pieces: string[] = [];
  let i = 0;
  while (i < rawCall.length) {
    const c = rawCall[i];
    if (c === '"' || c === "'" || c === "`") {
      const delim = c;
      const start = i + 1;
      let j = start;
      while (j < rawCall.length) {
        if (rawCall[j] === "\\") {
          j += 2;
          continue;
        }
        if (rawCall[j] === delim) break;
        j++;
      }
      if (j >= rawCall.length) break;
      const inner = rawCall.slice(start, j);
      const parts =
        delim === "`" ? inner.split(/\$\{[^}]*\}/g) : inner.split(/\{[^}]*\}|%[a-zA-Z]/g);
      for (const p of parts) {
        const cleaned = p.trim();
        const alnum = (cleaned.match(/[a-zA-Z0-9]/g) ?? []).length;
        if (alnum >= 2) pieces.push(cleaned);
      }
      i = j + 1;
    } else {
      i++;
    }
  }
  if (pieces.length === 0) return null;
  return `*${pieces.join("*")}*`;
}
