/** Shared by focused and global Agent turns, independent of the Model connection. */
export const SURFACE_ATOM_AUTHORING_GUIDE =
  '\n\nSurface Atom contracts: every accepted prop must have a visible effect. ' +
  'Title, Text, Caption, Label, and Markdown are leaf Atoms with either props.text or a string ' +
  'binding, never both; optional emptyText describes explicitly empty content. Title may set ' +
  'level 1–6. They accept no actions or children. Markdown supports headings, paragraphs, lists, ' +
  'emphasis, code, and safe links; raw markup remains literal text. Compose complete structured ' +
  'answers with session or section headings and their actual details, never only a Surface title. ' +
  'Input and Textarea require a string state binding and props.label, belong inside the nearest ' +
  'Form, and declare no actions. Input may set placeholder, inputType, or valueType: number ' +
  '(the committed draft remains string; submit converts the local value to a number); Textarea ' +
  'may set placeholder and rows 2–12. ' +
  'Form requires props.label, submitLabel, nonempty children, and exactly one action named submit ' +
  'with path: fast. Its plan has inputs (binding names and scalar types), targets (the exact ' +
  'existing top-level state keys written and their complete types), and ordered steps. For a ' +
  'record array target, items is {type: object, identityKey, fields: {field: {type: string|number|' +
  'boolean|null}}}. An append step is {op: append, target: recordsKey, value: {source: object, ' +
  'fields: {id: {source: metadata, name: recordId}, field: {source: input, name: inputBinding}}}}. ' +
  'Clear each draft with {op: clear, target: inputBinding, value: ""}; include each draft target ' +
  'as {type: string}, including drafts whose submitted input type is number. ' +
  'The whole submit payload comes from local fields together; typing creates no durable write. ' +
  'Authors omit Gateway-owned revision. Button requires label and exactly one declared action; ' +
  'Checkbox and Switch require label, boolean binding, and one toggle action. Select, RadioGroup, ' +
  'and Combobox require label, unique {value, label} options, a matching string binding, and one ' +
  'change action. Only Combobox permits an empty string selection with explicit emptyText. ' +
  'DatePicker requires label, a YYYY-MM-DD binding, and one change action; allowEmpty: true ' +
  'permits an empty date. Immediate fast actions receive value and ' +
  'use {op: set, target: binding, value: {source: input, name: value}} with compatible inputs ' +
  'and targets. Agent actions use path: agent and a fixed payload, never a fast plan. ' +
  'Collapsible requires label and children; optional defaultOpen controls initial local disclosure. ' +
  'Accordion requires nonempty Collapsible children, may set mode single or multiple, and uses ' +
  'local disclosure only. Neither disclosure Atom has bindings or actions. ' +
  'ListItem requires label and may show detail, status, and tone; an interactive item declares one ' +
  'click action. Badge requires text and optional tone (neutral, success, warning, danger, enabled, ' +
  'done, pending, error). Table requires explicit unique string columns (for example ' +
  'columns: ["item", "notes"]) matching the record field names, and either a rows array or an ' +
  'array binding; each displayed cell is string, finite number, boolean, or null and every row ' +
  'contains every declared column. Optional caption and emptyText remain visible. Stat requires ' +
  'label plus either props.value or binding (string, finite number, or null), and may show unit, ' +
  'trend, detail, and emptyText. Progress requires label and a numeric or null value source: ' +
  '0–1 is a fraction, above 1 through 100 is a percentage; null visibly means not recorded. ' +
  'Automation requires label and schedule, plus either static enabled or a boolean binding with ' +
  'one toggle action. Optional history or historyBinding carries validated run history. These ' +
  'Atoms are leaves. Chart requires a binding to an ordered record array and exactly one line or ' +
  'bar series, with props type, xKey, yKey, label, xLabel, yLabel, and emptyText. x is nonempty text ' +
  'or a finite number; y is a finite number. Box supports gap and padding; Row supports gap, ' +
  'align (start, end, center, stretch), and boolean wrap; Col supports gap; Spacer supports size. ' +
  'Spacing is always one of none, xs, sm, md, lg, xl. Divider accepts no props. Box, Row, and Col ' +
  'are containers; Spacer and Divider are leaves. These Atoms accept no bindings or actions. ' +
  'Image is a leaf with required nonempty alt, optional src (HTTP(S) without credentials or a ' +
  'same-origin absolute path), and optional loading (lazy or eager). A missing or failed source ' +
  'shows alt plus unavailable. Icon is a leaf with name dot, check, clock, alert, or bolt, optional ' +
  'tone, and either a nonempty label or decorative: true (never both). Media has no actions or ' +
  'bindings. Transition accepts only boolean visible and requires canonical children; it never ' +
  'removes their content. Pending is a leaf with variant text, list, image, stat, or chart, optional ' +
  'label and bounded timeoutMs 1000–120000; text may set lines 1–6 and list rows 1–8. The Gateway ' +
  'owns startedAt. Replace Pending in place with resolved content and preserve the node id. ' +
  'Never author static chart data, inferred keys, raw CSS, ' +
  'or unsupported props. Surface patches use JSON pointers scoped by target: state or tree. ' +
  'A state write is {target: state, op: add|replace, path: /stateKey, value: JSON}. A tree write ' +
  'is {target: tree, op: add|replace, path: /children/index, value: completeAtom}. To recompose ' +
  'the entire tree atomically use {target: tree, op: replace, path: "", value: completeRoot}; ' +
  'preserve unrelated controls and content. patch_tree requires the expectedTreeVersion from ' +
  'the latest read_surface and accepts no state operations. Never remove content as a probe ' +
  'before a replacement. A rejected mutation changed no Surface; report only the content in the ' +
  'authoritative committed result or a verified read_surface result.'
