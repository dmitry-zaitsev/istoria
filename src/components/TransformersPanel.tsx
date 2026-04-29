import { useEffect, useMemo, useRef, useState } from "react";

import { applyTransformers, compileSingle, emptyRule, MAX_TRANSFORMERS, resetBuiltins, saveTransformers, type TransformerRule } from "../lib/transformers";
import { toast } from "../lib/toast";
import { useStore } from "../store";
import type { LogEvent } from "../lib/ipc";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function TransformersPanel({ open, onClose }: Props) {
  const transformers = useStore((s) => s.transformers);
  const setTransformers = useStore((s) => s.setTransformers);
  const ref = useRef<HTMLDivElement | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [globalSample, setGlobalSample] = useState("");

  const sortedRules = transformers.slice().sort((a, b) => a.order - b.order);

  // Match map: rule id → captures (groups) when sample matches that
  // rule's regex. Lets each row badge its hit/miss + show captures.
  const matches = useMemo(() => {
    const m = new Map<string, Record<string, string> | null>();
    if (!globalSample) return m;
    for (const r of sortedRules) {
      const c = compileSingle(r);
      if (!c.re) {
        m.set(r.id, null);
        continue;
      }
      c.re.lastIndex = 0;
      const hit = c.re.exec(globalSample);
      if (!hit) {
        m.set(r.id, null);
        continue;
      }
      m.set(r.id, hit.groups ?? {});
    }
    return m;
  }, [globalSample, sortedRules]);

  const combinedPreview = useMemo(() => {
    if (!globalSample) return null;
    const compiled = sortedRules
      .filter((r) => r.enabled)
      .map((r) => compileSingle(r));
    const fake: LogEvent = {
      id: 0,
      ts: Date.now(),
      source: "test",
      level: "info",
      msg: globalSample,
      raw: globalSample,
    };
    return applyTransformers(fake, compiled);
  }, [globalSample, sortedRules]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const persist = (next: TransformerRule[]) => {
    saveTransformers(next);
    setTransformers(next);
  };

  const toggle = (id: string) => {
    persist(
      transformers.map((r) =>
        r.id === id ? { ...r, enabled: !r.enabled } : r,
      ),
    );
  };

  const remove = (id: string) => {
    if (editingId === id) setEditingId(null);
    persist(transformers.filter((r) => r.id !== id));
  };

  const move = (id: string, dir: -1 | 1) => {
    const sorted = transformers.slice().sort((a, b) => a.order - b.order);
    const idx = sorted.findIndex((r) => r.id === id);
    const swap = idx + dir;
    if (idx < 0 || swap < 0 || swap >= sorted.length) return;
    const a = sorted[idx]!;
    const b = sorted[swap]!;
    persist(
      transformers.map((r) => {
        if (r.id === a.id) return { ...r, order: b.order };
        if (r.id === b.id) return { ...r, order: a.order };
        return r;
      }),
    );
  };

  // Editing a seeded rule's pattern/output detaches it from the seed
  // refresh path so user edits aren't clobbered when SEED_MARKER bumps.
  // Toggle/reorder/rename leave seeded marker intact.
  const STRUCTURAL: ReadonlySet<keyof TransformerRule> = new Set([
    "pattern",
    "flags",
  ]);
  const update = (id: string, patch: Partial<TransformerRule>) => {
    persist(
      transformers.map((r) => {
        if (r.id !== id) return r;
        const detach = Object.keys(patch).some((k) =>
          STRUCTURAL.has(k as keyof TransformerRule),
        );
        return { ...r, ...patch, seeded: detach ? false : r.seeded };
      }),
    );
  };

  const updateOutput = (id: string, patch: Partial<TransformerRule["output"]>) => {
    persist(
      transformers.map((r) =>
        r.id === id
          ? {
              ...r,
              output: { ...r.output, ...patch },
              seeded: false,
            }
          : r,
      ),
    );
  };

  const addRule = () => {
    if (transformers.length >= MAX_TRANSFORMERS) {
      toast(`Limit ${MAX_TRANSFORMERS} rules`);
      return;
    }
    const maxOrder = transformers.reduce((m, r) => Math.max(m, r.order), 0);
    const r = emptyRule(maxOrder + 10);
    persist([...transformers, r]);
    setEditingId(r.id);
  };

  const reset = () => {
    const next = resetBuiltins(transformers);
    setTransformers(next);
    toast("Built-in rules restored");
  };

  return (
    <div
      className="transformers-panel"
      ref={ref}
      role="dialog"
      aria-label="Line transformers"
    >
      <div className="alerts-panel-h">
        Transformers
        <span style={{ color: "var(--muted-2)" }}>{transformers.length}</span>
        <span className="transformers-actions">
          <button
            type="button"
            className="sort-btn"
            onClick={addRule}
            title="Add a new rule"
          >
            + new
          </button>
          <button
            type="button"
            className="sort-btn"
            onClick={reset}
            title="Restore deleted built-in rules; user rules untouched"
          >
            reset built-ins
          </button>
        </span>
      </div>
      <div className="tx-global-test">
        <textarea
          className="tx-test"
          value={globalSample}
          onChange={(e) => setGlobalSample(e.target.value)}
          placeholder="Paste a sample line to see which rules match…"
          rows={2}
          spellCheck={false}
        />
        {globalSample && combinedPreview && (
          <div className="tx-preview">
            <div className="tx-preview-row">
              <span className="tx-preview-k">source</span>
              <code>{combinedPreview.source}</code>
            </div>
            <div className="tx-preview-row">
              <span className="tx-preview-k">level</span>
              <code>{combinedPreview.level}</code>
            </div>
            <div className="tx-preview-row">
              <span className="tx-preview-k">msg</span>
              <code>{combinedPreview.msg}</code>
            </div>
            {combinedPreview.fields != null && (
              <div className="tx-preview-row">
                <span className="tx-preview-k">fields</span>
                <code>{JSON.stringify(combinedPreview.fields)}</code>
              </div>
            )}
          </div>
        )}
      </div>
      {transformers.length === 0 && (
        <div className="alerts-empty">
          No transformer rules. Click <b>+ new</b> to add one.
        </div>
      )}
      {sortedRules.map((r) => {
        const sampleMatch = globalSample ? matches.get(r.id) ?? null : undefined;
        return (
          <RuleRow
            key={r.id}
            rule={r}
            editing={editingId === r.id}
            sampleMatch={sampleMatch}
            onToggleEdit={() => setEditingId(editingId === r.id ? null : r.id)}
            onToggle={() => toggle(r.id)}
            onDelete={() => remove(r.id)}
            onMoveUp={() => move(r.id, -1)}
            onMoveDown={() => move(r.id, 1)}
            onUpdate={(patch) => update(r.id, patch)}
            onUpdateOutput={(patch) => updateOutput(r.id, patch)}
          />
        );
      })}
    </div>
  );
}

interface RowProps {
  rule: TransformerRule;
  editing: boolean;
  /// `undefined` = no global sample entered. `null` = sample present
  /// but rule did not match. Object = matched, with named captures.
  sampleMatch: Record<string, string> | null | undefined;
  onToggleEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onUpdate: (patch: Partial<TransformerRule>) => void;
  onUpdateOutput: (patch: Partial<TransformerRule["output"]>) => void;
}

function RuleRow({
  rule,
  editing,
  sampleMatch,
  onToggleEdit,
  onToggle,
  onDelete,
  onMoveUp,
  onMoveDown,
  onUpdate,
  onUpdateOutput,
}: RowProps) {
  const compileError = useMemo(() => compileSingle(rule).error, [rule]);

  return (
    <div className={`tx-rule${rule.enabled ? "" : " disabled"}`}>
      <div className="tx-rule-h">
        <div className="tx-rule-name">
          {rule.name}
          {rule.seeded && <span className="tx-tag">default</span>}
          {sampleMatch !== undefined && sampleMatch !== null && (
            <span
              className="tx-tag tx-tag-hit"
              title={
                Object.keys(sampleMatch).length > 0
                  ? JSON.stringify(sampleMatch)
                  : "matched (no named captures)"
              }
            >
              match
            </span>
          )}
          {sampleMatch === null && (
            <span className="tx-tag tx-tag-miss">no match</span>
          )}
          {compileError && (
            <span className="tx-tag tx-tag-err" title={compileError}>
              regex error
            </span>
          )}
        </div>
        <div className="tx-rule-pat" title={rule.pattern}>
          <code>{rule.pattern || "(empty)"}</code>
        </div>
        <button
          type="button"
          className="sort-btn"
          onClick={onMoveUp}
          title="Move up"
        >
          ↑
        </button>
        <button
          type="button"
          className="sort-btn"
          onClick={onMoveDown}
          title="Move down"
        >
          ↓
        </button>
        <button
          type="button"
          className="sort-btn"
          onClick={onToggleEdit}
          title={editing ? "Close editor" : "Edit rule"}
        >
          {editing ? "done" : "edit"}
        </button>
        <button
          type="button"
          className="sort-btn"
          onClick={onToggle}
          title={rule.enabled ? "Disable" : "Enable"}
        >
          {rule.enabled ? "on" : "off"}
        </button>
        <button
          type="button"
          className="sort-btn"
          onClick={onDelete}
          title="Delete"
        >
          ×
        </button>
      </div>
      {editing && (
        <RuleEditor
          rule={rule}
          compileError={compileError}
          onUpdate={onUpdate}
          onUpdateOutput={onUpdateOutput}
        />
      )}
    </div>
  );
}

interface EditorProps {
  rule: TransformerRule;
  compileError: string | undefined;
  onUpdate: (patch: Partial<TransformerRule>) => void;
  onUpdateOutput: (patch: Partial<TransformerRule["output"]>) => void;
}

function RuleEditor({
  rule,
  compileError,
  onUpdate,
  onUpdateOutput,
}: EditorProps) {
  const [sample, setSample] = useState("");
  const compiled = useMemo(() => compileSingle(rule), [rule]);
  const preview = useMemo(() => {
    if (!sample) return null;
    const fake: LogEvent = {
      id: 0,
      ts: Date.now(),
      source: "test",
      level: "info",
      msg: sample,
      raw: sample,
    };
    return applyTransformers(fake, [compiled]);
  }, [sample, compiled]);
  const matched = useMemo(() => {
    if (!sample || !compiled.re) return null;
    compiled.re.lastIndex = 0;
    return compiled.re.exec(sample);
  }, [sample, compiled]);

  const fieldsEntries = Object.entries(rule.output.fields ?? {});

  const setField = (key: string, value: string) => {
    const fields = { ...(rule.output.fields ?? {}) };
    if (value === "") delete fields[key];
    else fields[key] = value;
    onUpdateOutput({
      fields: Object.keys(fields).length > 0 ? fields : undefined,
    });
  };

  const renameField = (oldKey: string, newKey: string) => {
    if (oldKey === newKey || !newKey) return;
    const fields = { ...(rule.output.fields ?? {}) };
    fields[newKey] = fields[oldKey] ?? "";
    delete fields[oldKey];
    onUpdateOutput({ fields });
  };

  const addField = () => {
    let key = "tag";
    let i = 1;
    const existing = rule.output.fields ?? {};
    while (existing[key] != null) key = `tag${++i}`;
    onUpdateOutput({
      fields: { ...(rule.output.fields ?? {}), [key]: "" },
    });
  };

  return (
    <div className="tx-editor">
      <label className="tx-row">
        <span>Name</span>
        <input
          type="text"
          value={rule.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
        />
      </label>
      <label className="tx-row">
        <span>Pattern</span>
        <input
          type="text"
          className="tx-mono"
          value={rule.pattern}
          onChange={(e) => onUpdate({ pattern: e.target.value })}
          placeholder="^(?<name>...)..."
          spellCheck={false}
        />
      </label>
      <label className="tx-row">
        <span>Flags</span>
        <input
          type="text"
          className="tx-mono"
          value={rule.flags ?? ""}
          onChange={(e) => onUpdate({ flags: e.target.value })}
          placeholder="i, s, …"
          spellCheck={false}
          style={{ maxWidth: 80 }}
        />
        {compileError && (
          <span className="tx-err-msg">{compileError}</span>
        )}
      </label>
      <div className="tx-section">Output overrides — leave blank to keep canonical</div>
      <label className="tx-row">
        <span>source</span>
        <input
          type="text"
          className="tx-mono"
          value={rule.output.source ?? ""}
          onChange={(e) =>
            onUpdateOutput({ source: e.target.value || undefined })
          }
          placeholder="${pkg}"
          spellCheck={false}
        />
      </label>
      <label className="tx-row">
        <span>level</span>
        <input
          type="text"
          className="tx-mono"
          value={rule.output.level ?? ""}
          onChange={(e) =>
            onUpdateOutput({ level: e.target.value || undefined })
          }
          placeholder="${lvl}"
          spellCheck={false}
        />
      </label>
      <label className="tx-row">
        <span>msg</span>
        <input
          type="text"
          className="tx-mono"
          value={rule.output.msg ?? ""}
          onChange={(e) =>
            onUpdateOutput({ msg: e.target.value || undefined })
          }
          placeholder="${body}"
          spellCheck={false}
        />
      </label>
      <label className="tx-row">
        <span>merge</span>
        <input
          type="text"
          className="tx-mono"
          value={rule.output.merge_fields ?? ""}
          onChange={(e) =>
            onUpdateOutput({ merge_fields: e.target.value || undefined })
          }
          placeholder="${json} — parsed and spread onto fields"
          spellCheck={false}
        />
      </label>
      <div className="tx-section">
        Fields
        <button type="button" className="sort-btn" onClick={addField}>
          + field
        </button>
      </div>
      {fieldsEntries.length === 0 && (
        <div className="tx-hint">No fields. Add one to extract structured data.</div>
      )}
      {fieldsEntries.map(([k, v]) => (
        <div key={k} className="tx-row tx-field-row">
          <input
            type="text"
            className="tx-mono"
            value={k}
            onChange={(e) => renameField(k, e.target.value)}
            spellCheck={false}
            style={{ maxWidth: 120 }}
          />
          <input
            type="text"
            className="tx-mono"
            value={v}
            onChange={(e) => setField(k, e.target.value)}
            placeholder="${capture}"
            spellCheck={false}
          />
          <button
            type="button"
            className="sort-btn"
            onClick={() => setField(k, "")}
            title="Remove field"
          >
            ×
          </button>
        </div>
      ))}
      <div className="tx-section">Test</div>
      <textarea
        className="tx-test"
        value={sample}
        onChange={(e) => setSample(e.target.value)}
        placeholder="Paste a sample line to preview output…"
        rows={2}
        spellCheck={false}
      />
      {sample && (
        <div className="tx-preview">
          {!matched && (
            <div className="tx-hint">No match.</div>
          )}
          {matched && preview && (
            <>
              {matched.groups && Object.keys(matched.groups).length > 0 && (
                <div className="tx-preview-row">
                  <span className="tx-preview-k">captures</span>
                  <code>{JSON.stringify(matched.groups)}</code>
                </div>
              )}
              <div className="tx-preview-row">
                <span className="tx-preview-k">source</span>
                <code>{preview.source}</code>
              </div>
              <div className="tx-preview-row">
                <span className="tx-preview-k">level</span>
                <code>{preview.level}</code>
              </div>
              <div className="tx-preview-row">
                <span className="tx-preview-k">msg</span>
                <code>{preview.msg}</code>
              </div>
              {preview.fields != null && (
                <div className="tx-preview-row">
                  <span className="tx-preview-k">fields</span>
                  <code>{JSON.stringify(preview.fields)}</code>
                </div>
              )}
            </>
          )}
        </div>
      )}
      <div className="tx-hint">
        Each enabled rule matches against the original raw line.
        References use <code>{"${name}"}</code> for named captures.
      </div>
    </div>
  );
}
