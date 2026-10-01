# Atom catalog UI foundation

The catalog uses [shadcn/ui](https://ui.shadcn.com/docs) components copied from the official
`new-york-v4` registry into `src/ui/`. They are source owned by this repository, as intended by
shadcn/ui. The PWA loads Tailwind utilities for these components. Its semantic color and radius
variables come from `catalogTokens` through `catalogCssText()`, so the shell and Atoms share one
theme source. The copied Chart container omits registry style injection; Agent authored Surfaces
cannot supply CSS or HTML.

| Atom                           | Foundation                                                     |
| ------------------------------ | -------------------------------------------------------------- |
| Button                         | Button                                                         |
| DatePicker                     | Input with native `date` behavior                              |
| Select                         | NativeSelect                                                   |
| Checkbox                       | Checkbox                                                       |
| Switch                         | Switch                                                         |
| RadioGroup                     | RadioGroup                                                     |
| Combobox                       | Combobox with searchable labeled options                       |
| Input, Textarea                | Input, Textarea                                                |
| Form                           | Button and Label with a catalog spacing recipe                 |
| Box                            | Card                                                           |
| Row, Col, Spacer, Transition   | Catalog spacing, radius, and motion recipes                    |
| Divider                        | Separator                                                      |
| Collapsible                    | Collapsible                                                    |
| Accordion                      | Accordion with Collapsible child Atoms                         |
| Table                          | Table primitives                                               |
| Title, Text, Caption, Markdown | Catalog typography recipes                                     |
| Label                          | Catalog label typography recipe                                |
| Image                          | Native image with visible loading and unavailable states       |
| Icon                           | Catalog icon and semantic color recipe                         |
| Chart                          | ChartContainer and one explicit Recharts LineChart or BarChart |
| Badge                          | Badge                                                          |
| Stat                           | Catalog metric typography recipe                               |
| Progress                       | Progress                                                       |
| ListItem                       | Item                                                           |
| Automation                     | Item and Switch                                                |
| Pending                        | Card and Skeleton                                              |
| UnknownAtom                    | Visible catalog error typography recipe                        |

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

## Layout, media, and motion contracts

Box accepts `gap` and `padding`; Row accepts `gap`, `align` (`start`, `end`, `center`, `stretch`),
and boolean `wrap`; Col accepts `gap`; Spacer accepts `size`. Spacing uses only `none`, `xs`, `sm`,
`md`, `lg`, and `xl`. Divider accepts no props. Containers may reserve an empty canonical slot;
Spacer and Divider are leaves. These Atoms cannot bind state or declare actions.

Image requires nonempty `alt`, optional `src`, and `loading` (`lazy` by default or `eager`). Sources
are HTTP(S) without embedded credentials or same-origin absolute paths. Raw markup, data URLs,
protocol-relative URLs, and scripts are rejected. Loading is visible; absent or failed media shows
the alternative text followed by `unavailable`, preserving surrounding content. Icon requires a
closed name (`dot`, `check`, `clock`, `alert`, `bolt`) and either a label or `decorative: true`.
Decorative icons cannot discard a supplied label. Optional `tone` uses the catalog colors.

Transition accepts boolean `visible` and requires canonical children. Its opacity treatment never
removes their content; reduced motion disables its transition. Pending uses a strict text, list,
image, stat, or chart footprint and a visible accessible loading label. The Gateway stamps the
composition window; a timeout or unstamped slot visibly becomes unavailable. Reduced motion
disables skeleton animation. Resolved content replaces Pending using its existing node identity.

The renderer validates the complete tree and typed state before rendering, preserving Form ancestor
context. Invalid known content produces a readable diagnostic without interactive descendants.
Unknown types from a newer Gateway show their type and identity while retaining valid known children
and siblings. They remain rejected at authoring boundaries. The clean browser composition in
`packages/e2e/tests/layout-atoms.spec.ts` checks media loading and failure, one Pending replacement,
reload, desktop and mobile viewports, light and dark themes, and reduced motion.

## Client version skew

Authoring, persistence, and Template import use the closed `AtomNodeSchema` and `SurfaceSchema`.
Client HTTP responses, Gateway frames, confirmed cache, and patch replay use the explicit
`RenderableAtomNodeSchema` and `RenderableSurfaceSchema` read contracts. Known Atoms reuse their
catalog validation, including ancestor-sensitive Forms and typed bindings. Only a genuinely new
Atom type may retain future JSON metadata; that metadata does not declare executable local actions
or bindings. Known descendants and siblings remain validated and rendered.

The catalog accepts `RenderableAtomNode`. A future type reaches `UnknownAtom` with its original
name and identity. It is never asserted to be a canonical `AtomNode`, and a read projection cannot
be imported as a Template or persisted through the closed authoring contract. Read and canonical
patch application share one application algorithm and each validate the complete resulting Surface.

`packages/e2e/tests/atom-wire-compatibility.spec.ts` transforms actual browser HTTP responses and
WebSocket frames to emulate a newer Gateway, then verifies live Pending replacement, reload,
confirmed cache while offline, and recovery. For UI verification against a newer Gateway, open a
Space containing a future Atom, check its visible type and identity beside known content, refresh,
and refresh again while offline; the fallback and known content must survive each read.
