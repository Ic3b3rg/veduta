import type { AtomNode } from '@veduta/protocol'
import {
  cloneElement,
  isValidElement,
  memo,
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
  PendingAtom,
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
import type { AtomProps, RenderContext, SurfaceUpdateFeedback } from './types.ts'

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
  Pending: PendingAtom,
} satisfies Record<AtomNode['type'], AtomRenderer>

export function renderNode(node: AtomNode, ctx: RenderContext): ReactNode {
  return <MotionTree node={node} ctx={ctx} />
}

function MotionTree({ node, ctx }: AtomProps): ReactNode {
  const previousAtomIdsRef = useRef<ReadonlySet<string>>(new Set())
  const dispatchRef = useRef(ctx.dispatch)
  const currentAtomIds = collectAtomIds(node)
  const shouldAnimateEntrance = useCallback(
    (atomId: string) => !previousAtomIdsRef.current.has(atomId),
    [],
  )
  const stableDispatch = useCallback<RenderContext['dispatch']>(
    (...args) => dispatchRef.current(...args),
    [],
  )

  useLayoutEffect(() => {
    previousAtomIdsRef.current = currentAtomIds
  }, [currentAtomIds])
  useLayoutEffect(() => {
    dispatchRef.current = ctx.dispatch
  }, [ctx.dispatch])

  return (
    <MotionNode
      node={node}
      ctx={{ ...ctx, dispatch: stableDispatch }}
      siblingIndex={0}
      shouldAnimateEntrance={shouldAnimateEntrance}
    />
  )
}

const MotionNode = memo(function MotionNodeComponent({
  node,
  ctx,
  siblingIndex,
  shouldAnimateEntrance,
  inheritedContentUpdateKey,
}: MotionNodeProps): ReactNode {
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
}, motionNodePropsEqual)

type MotionNodeProps = AtomProps & {
  siblingIndex: number
  shouldAnimateEntrance: (atomId: string) => boolean
  inheritedContentUpdateKey?: string | undefined
}

function motionNodePropsEqual(previous: MotionNodeProps, next: MotionNodeProps): boolean {
  if (previous.siblingIndex !== next.siblingIndex) return false
  if (previous.shouldAnimateEntrance !== next.shouldAnimateEntrance) return false
  if (
    next.inheritedContentUpdateKey !== undefined &&
    previous.inheritedContentUpdateKey !== next.inheritedContentUpdateKey
  )
    return false
  if (previous.ctx.theme !== next.ctx.theme) return false
  if (!valuesEqual(previous.node, next.node)) return false
  if (!boundStateEqual(previous.node, previous.ctx.state, next.ctx.state)) return false
  if (!motionEqual(previous.node, previous.ctx.motion?.update, next.ctx.motion?.update))
    return false
  if (previous.ctx.dispatch !== next.ctx.dispatch) return false
  return true
}

function boundStateEqual(
  node: AtomNode,
  previous: RenderContext['state'],
  next: RenderContext['state'],
): boolean {
  if (node.binding && !valuesEqual(previous[node.binding], next[node.binding])) return false
  return (node.children ?? []).every((child) => boundStateEqual(child, previous, next))
}

function motionEqual(
  node: AtomNode,
  previous: SurfaceUpdateFeedback | undefined,
  next: SurfaceUpdateFeedback | undefined,
): boolean {
  const atomIds = collectAtomIds(node)
  const previousTargets = previous?.atomIds.filter((atomId) => atomIds.has(atomId)) ?? []
  const nextTargets = next?.atomIds.filter((atomId) => atomIds.has(atomId)) ?? []
  if (nextTargets.length === 0) return true
  return (
    previous?.key === next?.key &&
    previousTargets.length === nextTargets.length &&
    previousTargets.every((atomId, index) => atomId === nextTargets[index])
  )
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => valuesEqual(value, right[index]))
    )
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) && valuesEqual(left[key], right[key]),
    )
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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
