import {
  collectRenderableNodeBindingRefs,
  isKnownRenderableAtomNode,
  type AtomType,
  type RenderableAtomNode,
} from '@veduta/protocol'
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
  AccordionAtom,
  BadgeAtom,
  BoxAtom,
  ButtonAtom,
  CaptionAtom,
  ChartAtom,
  CheckboxAtom,
  CollapsibleAtom,
  ColAtom,
  ComboboxAtom,
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
  SwitchAtom,
  TableAtom,
  TextAtom,
  TextareaAtom,
  TitleAtom,
  TransitionAtom,
  UnknownAtom,
} from './atoms.tsx'
import { useAtomMotion } from './atom-motion.ts'
import { tokensFor } from './design-system.ts'
import { renderValidationIssues } from './render-validation.ts'
import type {
  AtomProps,
  RenderableAtomProps,
  RenderContext,
  SurfaceUpdateFeedback,
} from './types.ts'

type AtomRenderer = (props: AtomProps) => ReactNode

const renderers = {
  Button: ButtonAtom,
  DatePicker: DatePickerAtom,
  Select: SelectAtom,
  Checkbox: CheckboxAtom,
  Switch: SwitchAtom,
  RadioGroup: RadioGroupAtom,
  Combobox: ComboboxAtom,
  Input: InputAtom,
  Textarea: TextareaAtom,
  Form: FormAtom,
  Box: BoxAtom,
  Row: RowAtom,
  Col: ColAtom,
  Spacer: SpacerAtom,
  Divider: DividerAtom,
  Collapsible: CollapsibleAtom,
  Accordion: AccordionAtom,
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
} satisfies { [Type in AtomType]: (props: AtomProps<Type>) => ReactNode }

export function renderNode(node: RenderableAtomNode, ctx: RenderContext): ReactNode {
  const issues = renderValidationIssues(node, ctx.state)
  if (issues.length > 0) {
    const tokens = tokensFor(ctx.theme)
    return (
      <div
        role="alert"
        style={{
          color: tokens.color.text,
          background: tokens.color.surfaceMuted,
          padding: tokens.space.md,
        }}
      >
        <strong>Surface content unavailable</strong>
        <ul>
          {issues.map((issue, index) => (
            <li key={index}>{issue}</li>
          ))}
        </ul>
      </div>
    )
  }
  return <MotionTree node={node} ctx={ctx} />
}

function MotionTree({ node, ctx }: RenderableAtomProps): ReactNode {
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
      siblingIndex={siblingIndex}
      shouldAnimateEntrance={shouldAnimateEntrance}
      regionUpdateKey={regionUpdateKey}
      contentUpdateKey={contentUpdateKey}
    >
      {children}
    </MotionAtom>
  )
}, motionNodePropsEqual)

type MotionNodeProps = RenderableAtomProps & {
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
  if (previous.ctx.now !== next.ctx.now) return false
  if (previous.ctx.motion?.reduced !== next.ctx.motion?.reduced) return false
  if (!valuesEqual(previous.node, next.node)) return false
  if (!boundStateEqual(previous.node, previous.ctx.state, next.ctx.state)) return false
  if (!actionFeedbackEqual(previous.node, previous.ctx, next.ctx)) return false
  if (!motionEqual(previous.node, previous.ctx.motion?.update, next.ctx.motion?.update))
    return false
  if (previous.ctx.dispatch !== next.ctx.dispatch) return false
  return true
}

function boundStateEqual(
  node: RenderableAtomNode,
  previous: RenderContext['state'],
  next: RenderContext['state'],
): boolean {
  return collectRenderableNodeBindingRefs(node, []).every(
    (ref) => ref.kind !== 'binding' || valuesEqual(previous[ref.key], next[ref.key]),
  )
}

function actionFeedbackEqual(
  node: RenderableAtomNode,
  previous: RenderContext,
  next: RenderContext,
): boolean {
  if (isKnownRenderableAtomNode(node) && (node.actions?.length ?? 0) > 0) {
    if (previous.acknowledgeAction !== next.acknowledgeAction) return false
    if (
      !valuesEqual(previous.actionConfirmations?.[node.id], next.actionConfirmations?.[node.id]) ||
      !valuesEqual(previous.actionStatuses?.[node.id], next.actionStatuses?.[node.id])
    ) {
      return false
    }
  }
  return (node.children ?? []).every((child) => actionFeedbackEqual(child, previous, next))
}

function motionEqual(
  node: RenderableAtomNode,
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
  siblingIndex,
  shouldAnimateEntrance,
  regionUpdateKey,
  contentUpdateKey,
  children,
}: RenderableAtomProps & {
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
    reducedMotion: ctx.motion?.reduced ?? false,
  })

  const rendered =
    isKnownRenderableAtomNode(node) && Object.hasOwn(renderers, node.type)
      ? (renderers[node.type] as AtomRenderer)({ node, ctx, children })
      : UnknownAtom({ node, ctx, children })
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

function collectAtomIds(node: RenderableAtomNode, ids = new Set<string>()): Set<string> {
  ids.add(node.id)
  for (const child of node.children ?? []) collectAtomIds(child, ids)
  return ids
}
