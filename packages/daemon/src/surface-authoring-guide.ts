/** Shared by focused and global Agent turns, independent of the Model connection. */
export const SURFACE_ATOM_AUTHORING_GUIDE =
  '\n\nSurface Atom contracts: every accepted prop must have a visible effect. ' +
  'Title, Text, Caption, Label, and Markdown are leaf Atoms with either props.text or a string ' +
  'binding, never both; optional emptyText describes explicitly empty content. Title may set ' +
  'level 1–6. They accept no actions or children. Markdown supports headings, paragraphs, lists, ' +
  'emphasis, code, and safe links; raw markup remains literal text. Compose complete structured ' +
  'answers with session or section headings and their actual details, never only a Surface title. ' +
  'ListItem requires label and may show detail, status, and tone; an interactive item declares one ' +
  'click action. Badge requires text and optional tone (neutral, success, warning, danger, enabled, ' +
  'done, pending, error). Table requires explicit unique columns and either a rows array or an ' +
  'array binding; each displayed cell is string, finite number, boolean, or null and every row ' +
  'contains every declared column. Optional caption and emptyText remain visible. Stat requires ' +
  'label plus either props.value or binding (string, finite number, or null), and may show unit, ' +
  'trend, detail, and emptyText. Progress requires label and a numeric or null value source: ' +
  '0–1 is a fraction, above 1 through 100 is a percentage; null visibly means not recorded. ' +
  'Automation requires label and schedule, plus either static enabled or a boolean binding with ' +
  'one toggle action. Optional history or historyBinding carries validated run history. These ' +
  'Atoms are leaves. Chart requires a binding to an ordered record array and exactly one line or ' +
  'bar series, with props type, xKey, yKey, label, xLabel, yLabel, and emptyText. x is nonempty text ' +
  'or a finite number; y is a finite number. Never author static chart data, inferred keys, raw CSS, ' +
  'or unsupported props. A rejected mutation changed no Surface; report only the content in the ' +
  'authoritative committed result or a verified read_surface result.'
