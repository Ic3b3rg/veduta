import type { AtomNode } from '@veduta/protocol'
import type { ReactNode } from 'react'
import {
  AutomationAtom,
  BadgeAtom,
  BoxAtom,
  ButtonAtom,
  CaptionAtom,
  ChartAtom,
  CheckboxAtom,
  ColAtom,
  DatePickerAtom,
  DividerAtom,
  FormAtom,
  IconAtom,
  ImageAtom,
  InputAtom,
  LabelAtom,
  ListItemAtom,
  MarkdownAtom,
  ProgressAtom,
  RadioGroupAtom,
  RowAtom,
  SelectAtom,
  SpacerAtom,
  StatAtom,
  TableAtom,
  TextAtom,
  TextareaAtom,
  TitleAtom,
  TransitionAtom,
  UnknownAtom,
} from './atoms.tsx'
import type { AtomProps, RenderContext } from './types.ts'

type AtomRenderer = (props: AtomProps) => ReactNode

const renderers = {
  Button: ButtonAtom,
  DatePicker: DatePickerAtom,
  Select: SelectAtom,
  Checkbox: CheckboxAtom,
  RadioGroup: RadioGroupAtom,
  Input: InputAtom,
  Textarea: TextareaAtom,
  Form: FormAtom,
  Box: BoxAtom,
  Row: RowAtom,
  Col: ColAtom,
  Spacer: SpacerAtom,
  Divider: DividerAtom,
  Table: TableAtom,
  Title: TitleAtom,
  Text: TextAtom,
  Caption: CaptionAtom,
  Label: LabelAtom,
  Markdown: MarkdownAtom,
  Image: ImageAtom,
  Icon: IconAtom,
  Chart: ChartAtom,
  Badge: BadgeAtom,
  Transition: TransitionAtom,
  Stat: StatAtom,
  Progress: ProgressAtom,
  ListItem: ListItemAtom,
  Automation: AutomationAtom,
} satisfies Record<AtomNode['type'], AtomRenderer>

export function renderNode(node: AtomNode, ctx: RenderContext): ReactNode {
  const Renderer = renderers[node.type] ?? UnknownAtom
  const children = (node.children ?? []).map((child) => renderNode(child, ctx))
  return (
    <Renderer key={node.id} node={node} ctx={ctx}>
      {children}
    </Renderer>
  )
}
