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
| RadioGroup                     | RadioGroup                                                        |
| Input, Textarea                | Input, Textarea                                                   |
| Form                           | Button and Label with a catalog spacing recipe                    |
| Box                            | Card                                                              |
| Row, Col, Spacer, Transition   | Catalog spacing, radius, and motion recipes                       |
| Divider                        | Separator                                                         |
| Table                          | Table primitives                                                  |
| Title, Text, Caption, Markdown | Catalog typography recipes                                        |
| Label                          | Label when associated with a control; typography recipe otherwise |
| Image                          | Card placeholder or native image with catalog radius              |
| Icon                           | Catalog icon and semantic color recipe                            |
| Chart                          | ChartContainer and Recharts BarChart                              |
| Badge                          | Badge                                                             |
| Stat                           | Catalog metric typography recipe                                  |
| Progress                       | Progress                                                          |
| ListItem                       | Item                                                              |
| Automation                     | Item and Switch                                                   |
| Pending                        | Card and Skeleton                                                 |
| UnknownAtom                    | Visible catalog error typography recipe                           |

The shadcn components are rendering details of the closed Atom catalog. Surface schemas, actions,
state bindings, and the Gateway transport stay in `@veduta/protocol` and the existing runtime.
