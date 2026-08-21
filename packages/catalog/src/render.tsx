import type { AtomNode } from '@veduta/protocol'
import {
  cloneElement,
  isValidElement,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from 'react'
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
import { useAtomMotion } from './atom-motion.ts'
import { tokensFor } from './design-system.ts'
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
  return <MotionTree node={node} ctx={ctx} />
}

function MotionTree({ node, ctx }: AtomProps): ReactNode {
  const previousAtomIdsRef = useRef<ReadonlySet<string>>(new Set())
  const currentAtomIds = collectAtomIds(node)
  const shouldAnimateEntrance = useCallback(
    (atomId: string) => !previousAtomIdsRef.current.has(atomId),
    [],
  )

  useLayoutEffect(() => {
    previousAtomIdsRef.current = currentAtomIds
  }, [currentAtomIds])

  return (
    <MotionNode
      node={node}
      ctx={ctx}
      siblingIndex={0}
      shouldAnimateEntrance={shouldAnimateEntrance}
    />
  )
}

function MotionNode({
  node,
  ctx,
  siblingIndex,
  shouldAnimateEntrance,
  inheritedContentUpdateKey,
}: AtomProps & {
  siblingIndex: number
  shouldAnimateEntrance: (atomId: string) => boolean
  inheritedContentUpdateKey?: string | undefined
}): ReactNode {
  const Renderer = renderers[node.type] ?? UnknownAtom
  const regionUpdateKey = ctx.motion?.update?.atomIds.includes(node.id)
    ? ctx.motion.update.key
    : undefined
  const contentUpdateKey = regionUpdateKey ?? inheritedContentUpdateKey
  const children = (node.children ?? []).map((child, index) => (
    <MotionNode
      key={child.id}
      node={child}
      ctx={ctx}
      siblingIndex={index}
      shouldAnimateEntrance={shouldAnimateEntrance}
      inheritedContentUpdateKey={contentUpdateKey}
    />
  ))
  return (
    <MotionAtom
      node={node}
      ctx={ctx}
      Renderer={Renderer}
      siblingIndex={siblingIndex}
      shouldAnimateEntrance={shouldAnimateEntrance}
      regionUpdateKey={regionUpdateKey}
      contentUpdateKey={contentUpdateKey}
    >
      {children}
    </MotionAtom>
  )
}

function MotionAtom({
  node,
  ctx,
  Renderer,
  siblingIndex,
  shouldAnimateEntrance,
  regionUpdateKey,
  contentUpdateKey,
  children,
}: AtomProps & {
  Renderer: AtomRenderer
  siblingIndex: number
  shouldAnimateEntrance: (atomId: string) => boolean
  regionUpdateKey: string | undefined
  contentUpdateKey: string | undefined
}): ReactNode {
  const motionId = useId()
  useAtomMotion({
    atomId: node.id,
    motionId,
    siblingIndex,
    shouldAnimateEntrance,
    tokens: tokensFor(ctx.theme),
    regionUpdateKey,
    contentUpdateKey,
  })

  const rendered = Renderer({ node, ctx, children })
  if (!isValidElement<MotionElementProps>(rendered)) return rendered
  return cloneElement(rendered, {
    'data-veduta-atom-id': node.id,
    'data-veduta-motion-id': motionId,
  })
}

interface MotionElementProps {
  'data-veduta-atom-id'?: string
  'data-veduta-motion-id'?: string
}

function collectAtomIds(node: AtomNode, ids = new Set<string>()): Set<string> {
  ids.add(node.id)
  for (const child of node.children ?? []) collectAtomIds(child, ids)
  return ids
}
