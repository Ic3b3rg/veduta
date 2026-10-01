# Atom catalog UI foundation

The catalog uses [shadcn/ui](https://ui.shadcn.com/docs) components copied from the official
`new-york-v4` registry into `src/ui/`. They are source owned by this repository, as intended by
shadcn/ui. The PWA loads Tailwind utilities for these components. Its semantic color and radius
variables come from `catalogTokens` through `catalogCssText()`, so the shell and Atoms share one
theme source. The copied Chart container omits registry style injection; Agent authored Surfaces
cannot supply CSS or HTML.

| Atom                           | Foundation                                                        |
| ------------------------------ | ----------------------------------------------------------------- |
| Button                         | Button                                                            |
| DatePicker                     | Input with native `date` behavior                                 |
| Select                         | NativeSelect                                                      |
| Checkbox                       | Checkbox                                                          |
| Switch                         | Switch                                                            |
| RadioGroup                     | RadioGroup                                                        |
| Combobox                       | Combobox with searchable labeled options                          |
| Input, Textarea                | Input, Textarea                                                   |
| Form                           | Button and Label with a catalog spacing recipe                    |
| Box                            | Card                                                              |
| Row, Col, Spacer, Transition   | Catalog spacing, radius, and motion recipes                       |
| Divider                        | Separator                                                         |
| Collapsible                    | Collapsible                                                       |
| Accordion                      | Accordion with Collapsible child Atoms                            |
| Table                          | Table primitives                                                  |
| Title, Text, Caption, Markdown | Catalog typography recipes                                        |
| Label                          | Label when associated with a control; typography recipe otherwise |
| Image                          | Card placeholder or native image with catalog radius              |
| Icon                           | Catalog icon and semantic color recipe                            |
| Chart                          | ChartContainer and one explicit Recharts LineChart or BarChart    |
| Badge                          | Badge                                                             |
| Stat                           | Catalog metric typography recipe                                  |
| Progress                       | Progress                                                          |
| ListItem                       | Item                                                              |
| Automation                     | Item and Switch                                                   |
| Pending                        | Card and Skeleton                                                 |
| UnknownAtom                    | Visible catalog error typography recipe                           |

The shadcn components are rendering details of the closed Atom catalog. Surface schemas, actions,
state bindings, and the Gateway transport stay in `@veduta/protocol` and the existing runtime.

## Content contracts

Content Atoms are leaves. Title, Text, Caption, Label, and Markdown require one string source:
`props.text` or `binding`. Explicit empty strings render `emptyText` or `No content yet`. Title may
choose a heading level from 1 through 6. Markdown uses a closed React content boundary: headings,
paragraphs, lists, emphasis, inline and fenced code, and safe HTTP(S), mail, or local-path links.
Raw markup stays visible text and cannot inject elements or execute code.

Table requires explicit unique `columns` plus either static `rows` or an array binding. Every
declared cell must exist and be string, finite number, boolean, or null; null is shown as `—`.
`caption` identifies the table, and `emptyText` or `No records yet` remains visible for no rows.
Stat requires `label` and one string, finite number, or null value source; `unit`, `trend`, and
`detail` are displayed when present. Progress requires `label` and one number or null source:
0–1 is a fraction, above 1 through 100 is a percentage. Null metrics and progress show
`emptyText` or `Not recorded`, never a fabricated zero.

Badge requires `text` and may set a supported `tone`. ListItem requires `label`, may show `detail`
and `status`, and may declare one `click` action. Its `tone` applies to a visible status.
Automation requires `label`, `schedule`, and one enabled-state source: static `enabled` produces a
visible status; a boolean binding requires one `toggle` action and produces an accessible Switch.
Run history is either static `history` or validated `historyBinding`, and updates with canonical state.

Compose plans through ordinary section headings, Tables, ListItems, and guidance text. The body
must carry the full structured answer; a Surface title alone cannot represent its details.
The clean Local VPS browser journey in `packages/e2e/tests/content-atoms.spec.ts` submits the
reported Italian three-day-plan request and checks all sessions, repetitions, rest, progression,
and safety guidance live and after reload, including a mobile dark viewport.
