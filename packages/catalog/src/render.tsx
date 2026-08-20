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
import { tokensFor, type CatalogTokens } from './design-system.ts'
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
}: AtomProps & {
  siblingIndex: number
  shouldAnimateEntrance: (atomId: string) => boolean
}): ReactNode {
  const Renderer = renderers[node.type] ?? UnknownAtom
  const children = (node.children ?? []).map((child, index) => (
    <MotionNode
      key={child.id}
      node={child}
      ctx={ctx}
      siblingIndex={index}
      shouldAnimateEntrance={shouldAnimateEntrance}
    />
  ))
  return (
    <MotionAtom
      node={node}
      ctx={ctx}
      Renderer={Renderer}
      siblingIndex={siblingIndex}
      shouldAnimateEntrance={shouldAnimateEntrance}
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
  children,
}: AtomProps & {
  Renderer: AtomRenderer
  siblingIndex: number
  shouldAnimateEntrance: (atomId: string) => boolean
}): ReactNode {
  const motionId = useId()
  const entranceRef = useRef({
    atomId: node.id,
    shouldAnimateEntrance,
    siblingIndex,
    tokens: tokensFor(ctx.theme),
  })
  const updateKey = ctx.motion?.update?.atomIds.includes(node.id)
    ? ctx.motion.update.key
    : undefined
  const previousUpdateKeyRef = useRef<string | undefined>(undefined)

  useLayoutEffect(() => {
    const entrance = entranceRef.current
    if (!entrance.shouldAnimateEntrance(entrance.atomId)) return

    const element = motionElement(motionId)
    if (!element || prefersReducedMotion() || typeof element.animate !== 'function') return

    const { siblingIndex: index, tokens } = entrance
    const animation = element.animate(entranceKeyframes(tokens), {
      delay: index * tokens.motion.staggerIntervalMs,
      duration: tokens.motion.entranceDurationMs,
      easing: tokens.motion.entranceEasing,
      fill: 'backwards',
    })
    return () => animation.cancel()
  }, [motionId])

  useLayoutEffect(() => {
    const previousUpdateKey = previousUpdateKeyRef.current
    previousUpdateKeyRef.current = updateKey
    if (updateKey === undefined || updateKey === previousUpdateKey) return

    const element = motionElement(motionId)
    if (!element || prefersReducedMotion() || typeof element.animate !== 'function') return

    const tokens = tokensFor(ctx.theme)
    const animation = element.animate(updateFeedbackKeyframes(tokens), {
      duration: tokens.motion.updateFeedbackDurationMs,
      easing: tokens.motion.entranceEasing,
    })
    return () => animation.cancel()
  }, [ctx.theme, motionId, updateKey])

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

function motionElement(motionId: string): Element | null {
  if (typeof document === 'undefined') return null
  return document.querySelector(`[data-veduta-motion-id="${motionId}"]`)
}

function collectAtomIds(node: AtomNode): ReadonlySet<string> {
  const ids = new Set<string>()
  collect(node, ids)
  return ids
}

function collect(node: AtomNode, ids: Set<string>): void {
  ids.add(node.id)
  for (const child of node.children ?? []) collect(child, ids)
}

function entranceKeyframes(tokens: CatalogTokens): Keyframe[] {
  return [
    { opacity: 0, transform: `translateY(${tokens.space.sm}px)` },
    { opacity: 1, transform: 'translateY(0)' },
  ]
}

function updateFeedbackKeyframes(tokens: CatalogTokens): Keyframe[] {
  return [
    { outline: `0 solid ${tokens.color.accent}`, outlineOffset: '0' },
    {
      outline: `${tokens.space.xs}px solid ${tokens.color.accent}`,
      outlineOffset: `${tokens.space.xs}px`,
    },
    { outline: `0 solid ${tokens.color.accent}`, outlineOffset: `${tokens.space.sm}px` },
  ]
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}
