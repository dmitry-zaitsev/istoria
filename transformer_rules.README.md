# transformer_rules.json

Single source of truth for log-prefix detection. Two readers:

- `src/lib/transformers.ts` — full transform pass at render (rewrites `source`, `level`, `msg`, `fields`).
- `src-tauri/src/transformers.rs` — `extract_body()` used by the ingest coalescer to detect indented stack-frame continuations beneath a wrapper prefix.

Edit rules here. Both readers reload on app restart.

## Schema

Array of `RuleSpec`:

| Field                             | Notes                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| `id`                              | Stable identifier.                                                                            |
| `name`                            | Human-readable label.                                                                         |
| `order`                           | Evaluation order — lower runs first. Specific formats before generic.                         |
| `pattern`                         | Rust/JS-compatible regex. Use `(?<name>...)` for named groups.                                |
| `flags`                           | Optional. Currently only `i` (case-insensitive) is honored backend-side.                      |
| `output.source` / `level` / `msg` | Templates with `${groupName}` substitution. Frontend-only.                                    |
| `output.fields`                   | Map of field-name → template. Frontend-only.                                                  |
| `output.merge_fields`             | Template that resolves to a JSON object literal whose keys spread onto fields. Frontend-only. |

## Backend contract

If a rule wants to participate in coalescing, its pattern **must** capture a `body` named group. The coalescer treats the matched `body` as the "logical content" of the line and checks whether it begins with whitespace (or matches a runtime stack-frame marker) to decide if the line continues the prior event.

All current rules capture `body`.

## Adding a rule

1. Append to the array. Keep `order` consistent with the precedence you want.
2. Run `cargo test --lib transformers` to confirm the regex compiles in Rust.
3. Run `npm run build` (or `tsc`) to confirm the JSON still type-checks against `TransformerRule[]`.
