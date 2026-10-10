# Atom conformance matrix

Issue #150 closes the canonical authoring catalog. Every row uses the strict recursive
[`AtomNodeSchema`](../../packages/protocol/src/atom.ts) branch plus complete
[`SurfaceSchema`](../../packages/protocol/src/surface.ts) validation of bindings, owning
inputs, Action plans, and bound values. The validator column names the type-specific contract.
The exhaustive renderer map is in [`render.tsx`](../../packages/catalog/src/render.tsx).

Paths in the table are relative to `packages/protocol/src` for validators,
`packages/catalog/src` for renderers and catalog tests, and `packages/e2e/tests` for browser tests.

| Atom          | Validator          | Renderer               | Interaction/value contract                                            | Accessibility                                                 | Catalog tests                                          | Browser evidence                          |
| ------------- | ------------------ | ---------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------- |
| `Button`      | `control-atoms.ts` | `atoms-selection.tsx`  | One empty-input fast command or captured Agent request                | Named button; pending status and linked alert                 | `control-contracts.test.tsx`                           | `controls.spec.ts, agent-actions.spec.ts` |
| `DatePicker`  | `control-atoms.ts` | `atoms-selection.tsx`  | Real calendar date; declared change input                             | Labelled native date input; required/disabled/error           | `control-contracts.test.tsx`                           | `controls.spec.ts`                        |
| `Select`      | `control-atoms.ts` | `atoms-selection.tsx`  | Select only an offered value                                          | Labelled native select; pending/error                         | `control-contracts.test.tsx`                           | `controls.spec.ts`                        |
| `Checkbox`    | `control-atoms.ts` | `atoms-selection.tsx`  | Canonical boolean toggle                                              | Labelled checkbox; checked/disabled/error                     | `control-contracts.test.tsx`                           | `controls.spec.ts`                        |
| `Switch`      | `atom.ts`          | `atoms-controls.tsx`   | Canonical boolean toggle                                              | Labelled switch; keyboard, checked, pending/error             | `atoms-new.test.tsx, action-feedback.test.tsx`         | `action-controls.spec.ts`                 |
| `RadioGroup`  | `control-atoms.ts` | `atoms-selection.tsx`  | Select one offered value                                              | Named radiogroup; native radio keyboard interaction           | `control-contracts.test.tsx`                           | `controls.spec.ts`                        |
| `Combobox`    | `atom.ts`          | `atoms-controls.tsx`   | Local search; only offered selection is durable                       | Labelled combobox/listbox; arrow/Enter, canonical retry/error | `atoms-new.test.tsx`                                   | `action-controls.spec.ts`                 |
| `Input`       | `atom.ts`          | `atoms-form.tsx`       | Local text draft; owning Form submits text or finite number           | Associated label; disabled/busy feedback from Form            | `atoms-form.test.tsx, form-number.test.tsx`            | `local-vps.spec.ts, fast-actions.spec.ts` |
| `Textarea`    | `atom.ts`          | `atoms-form.tsx`       | Local multiline draft owned by Form                                   | Associated label; Form pending/error                          | `atoms-form.test.tsx`                                  | `local-vps.spec.ts`                       |
| `Form`        | `atom.ts`          | `atoms-form.tsx`       | Complete typed submit; ordered atomic fast plan                       | Named form; submit keyboard, linked error, busy status        | `atoms-form-confirmation.test.tsx`                     | `local-vps.spec.ts, fast-actions.spec.ts` |
| `Box`         | `layout-atoms.ts`  | `atoms-layout.tsx`     | Validated layout children and token spacing                           | Preserves semantic descendants and DOM order                  | `layout-contracts.test.tsx`                            | `layout-atoms.spec.ts`                    |
| `Row`         | `layout-atoms.ts`  | `atoms-layout.tsx`     | Validated horizontal layout and wrapping                              | Preserves descendant roles; narrow-screen wrapping            | `layout-contracts.test.tsx`                            | `layout-atoms.spec.ts`                    |
| `Col`         | `layout-atoms.ts`  | `atoms-layout.tsx`     | Validated vertical layout                                             | Preserves descendant roles and reading order                  | `layout-contracts.test.tsx`                            | `layout-atoms.spec.ts`                    |
| `Spacer`      | `layout-atoms.ts`  | `atoms-layout.tsx`     | Token-sized decorative spacing                                        | aria-hidden decoration                                        | `layout-contracts.test.tsx`                            | `layout-atoms.spec.ts`                    |
| `Divider`     | `layout-atoms.ts`  | `atoms-layout.tsx`     | Semantic separator; no children or values                             | Separator role                                                | `layout-contracts.test.tsx`                            | `layout-atoms.spec.ts`                    |
| `Collapsible` | `layout-atoms.ts`  | `atoms-disclosure.tsx` | Local disclosure; labelled nonempty children                          | Keyboard trigger; expanded state and controlled content       | `layout-contracts.test.tsx`                            | `layout-atoms.spec.ts`                    |
| `Accordion`   | `layout-atoms.ts`  | `atoms-disclosure.tsx` | Single/multiple Collapsible groups                                    | Keyboard navigation and expanded triggers                     | `layout-contracts.test.tsx`                            | `layout-atoms.spec.ts`                    |
| `Table`       | `content-atoms.ts` | `atoms-data.tsx`       | Exact visible columns over scalar record cells; empty message         | Native table, column scopes, optional caption                 | `content-contracts.test.tsx`                           | `local-vps.spec.ts, fast-actions.spec.ts` |
| `Text`        | `content-atoms.ts` | `atoms-content.tsx`    | Literal or bound string; explicit empty fallback                      | Visible text with inherited reading order                     | `content-contracts.test.tsx`                           | `local-vps.spec.ts`                       |
| `Title`       | `content-atoms.ts` | `atoms-content.tsx`    | Literal or bound string with heading level                            | Native heading                                                | `content-contracts.test.tsx`                           | `local-vps.spec.ts`                       |
| `Caption`     | `content-atoms.ts` | `atoms-content.tsx`    | Literal or bound string                                               | Visible supplementary text                                    | `content-contracts.test.tsx`                           | `local-vps.spec.ts`                       |
| `Label`       | `content-atoms.ts` | `atoms-content.tsx`    | Literal or bound string; field labels owned by controls               | Visible text; does not invent field association               | `content-contracts.test.tsx`                           | `local-vps.spec.ts`                       |
| `Markdown`    | `content-atoms.ts` | `atoms-content.tsx`    | Bound or literal safe Markdown; no generated HTML                     | Semantic Markdown elements and safe links                     | `content-contracts.test.tsx`                           | `local-vps.spec.ts`                       |
| `Image`       | `layout-atoms.ts`  | `atoms-media.tsx`      | Safe source; loading and missing/broken-source fallback               | Required alternative text; named unavailable image/status     | `content-contracts.test.tsx`                           | `content-atoms.spec.ts`                   |
| `Icon`        | `layout-atoms.ts`  | `atoms-media.tsx`      | Closed icon names and tone                                            | Named image or explicitly hidden decoration                   | `content-contracts.test.tsx`                           | `content-atoms.spec.ts`                   |
| `Chart`       | `chart.ts`         | `atoms-chart.tsx`      | One keyed line/bar series; finite numeric values; empty state         | Named figure, axes and accessible data table                  | `atoms-chart.test.tsx`                                 | `local-vps.spec.ts`                       |
| `Badge`       | `content-atoms.ts` | `atoms-content.tsx`    | Nonempty text and supported tone                                      | Text remains visible independent of color                     | `content-contracts.test.tsx`                           | `content-atoms.spec.ts`                   |
| `Transition`  | `layout-atoms.ts`  | `atoms-layout.tsx`     | Validated children; opacity change preserves content                  | Descendants stay accessible; reduced motion                   | `layout-contracts.test.tsx, render.test.tsx`           | `layout-atoms.spec.ts`                    |
| `Progress`    | `content-atoms.ts` | `atoms-content.tsx`    | Bound/literal finite 0–100 or unknown                                 | Named progressbar; numeric or unknown status                  | `content-contracts.test.tsx`                           | `content-atoms.spec.ts`                   |
| `Stat`        | `content-atoms.ts` | `atoms-content.tsx`    | Labelled bound/literal metric with unit and unknown state             | Visible label/value/unit; color-independent trend             | `content-contracts.test.tsx`                           | `local-vps.spec.ts`                       |
| `ListItem`    | `content-atoms.ts` | `atoms-list.tsx`       | Visible item; optional single fast command or Agent request           | Named keyboard button when actionable; linked feedback        | `content-contracts.test.tsx, action-feedback.test.tsx` | `action-controls.spec.ts`                 |
| `Automation`  | `content-atoms.ts` | `atoms-list.tsx`       | Canonical enable toggle and structured run outcomes                   | Named switch; run status text; linked pending/error           | `content-contracts.test.tsx, render.test.tsx`          | `action-controls.spec.ts`                 |
| `Pending`     | `atom.ts`          | `atoms-pending.tsx`    | Gateway-started bounded composition window; unavailable after timeout | Visible named pending/unavailable status; reduced motion      | `atoms-pending.test.tsx`                               | `local-vps.spec.ts`                       |

[`render.test.tsx`](../../packages/catalog/src/render.test.tsx) requires the showcase to cover
every `atomTypes` member, renders the complete catalog, and refuses unsupported props for each
branch. Contract-specific protocol suites cover invalid declarations and bound states:
[`atom-closed-union`](../../packages/protocol/src/atom-closed-union.test.ts),
[`content-atoms`](../../packages/protocol/src/content-atoms.test.ts),
[`control-atoms`](../../packages/protocol/src/control-atoms.test.ts),
[`layout-atoms`](../../packages/protocol/src/layout-atoms.test.ts),
[`action-operability`](../../packages/protocol/src/action-operability.test.ts), and
[`surface`](../../packages/protocol/src/surface.test.ts).

Complete writes share `parseSurface` and `parseSurfacePatch`, before durable mutation.
The complete tree must contain visible content or an explicit empty/Pending state. An empty
layout, spacing/dividers, decoration, or blank text alone is rejected as `empty_surface_content`.
The Surface and tool-input roots are strict: an unsupported top-level placement such as
`width: "100%"` is rejected with an `unrecognized_keys` path rather than silently discarded.
Focused and global Chat schemas retain the same rejection while adding their authorized fields.
Static Action checks cover every offered finite selection, both boolean outcomes and the optional
empty DatePicker choice against all Atoms bound to the written state key. A Surface with conflicting
shared-control choices is rejected before persistence, while the existing reducer remains the sole
executor.
[`semantic-write-acceptance`](../../packages/daemon/src/semantic-write-acceptance.test.ts)
checks machine-readable paths and unchanged Surface, versions, cursor, Space Events, realtime
replay, and proposals after mixed invalid writes. Templates materialize through the same parser;
proposal acceptance dry-applies and then validates the complete current result. Gateway-owned
projections and durable row reads use that parser too. The fast reducer validates every
intermediate complete state before committing its ordered batch.

Genuinely unknown wire names use the separate inert read projection, never canonical authoring.
[`atom-wire-compatibility.spec.ts`](../../packages/e2e/tests/atom-wire-compatibility.spec.ts) checks
visible fallback, known descendants, cache/reload/replay, and refusal of malformed known branches.
The combined [`local-vps.spec.ts`](../../packages/e2e/tests/local-vps.spec.ts) journey checks
editable Form submit/retry, complete gym content, the same 74 kg record in history/Stat/Chart,
full presentation, reload, and atomic invalid authoring without false Chat success.

## Date and schedule presentation (issue #233)

Chart x-values, Table cells and Stat values recognize complete ISO calendar dates and zoned ISO
timestamps by default, including existing saved records. `xFormat`, `columnFormats`, and
`valueFormat` respectively may select `text`, `date`, or `datetime`. Text, Caption and Label accept
`valueFormat` explicitly and remain literal by default; prose, titles and Markdown are never
scanned for embedded dates. Table format keys must name declared columns. Invalid dates, unzoned
timestamps, ordinary labels, numeric strings and numbers remain literal.

The shared catalog value renderer follows the browser's language preferences. Calendar dates keep
their original day; instants use the device timezone unless a caller supplies a schedule's
configured timezone. Compact visible values retain the exact source in a semantic `time` element,
its accessible name and title; Charts also include complete values in their accessible description.
Formatting never rewrites Surface state.

Automation `scheduleDetails` carries canonical recurrence/timer inputs, next occurrence, timezone
and status. Both the Atom and Settings use the same localized schedule renderer. It describes the
same expanded cron fields consumed by the Scheduler, including its day-of-month/day-of-week
combination, without interpreting a second cron dialect. The exact historical Scheduler text
format also renders readably until its projection refreshes; arbitrary authored schedule text stays
literal. Missing times or invalid rules remain visibly unavailable. See
[`temporal-rendering.test.tsx`](../../packages/catalog/src/temporal-rendering.test.tsx),
[`automation-schedule.test.tsx`](../../packages/catalog/src/automation-schedule.test.tsx), and the
authenticated English/Italian desktop/phone reload journey in
[`temporal-presentation.spec.ts`](../../packages/e2e/tests/temporal-presentation.spec.ts).
