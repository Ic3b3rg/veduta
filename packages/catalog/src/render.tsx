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
  inheritedContentUpdateKey,
}: AtomProps & {
  siblingIndex: number
  shouldAnimateEntrance: (atomId: string) => boolean
  inheritedContentUpdateKey?: string
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
      {...(contentUpdateKey === undefined ? {} : { inheritedContentUpdateKey: contentUpdateKey })}
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
  const entranceRef = useRef({
    atomId: node.id,
    shouldAnimateEntrance,
    siblingIndex,
    tokens: tokensFor(ctx.theme),
  })
  const previousRegionUpdateKeyRef = useRef<string | undefined>(undefined)
  const previousContentUpdateKeyRef = useRef<string | undefined>(undefined)
  const previousContentRef = useRef<ReadonlyMap<string, MotionContentState> | undefined>(undefined)
  const activeUpdateAnimationsRef = useRef<Animation[]>([])

  useLayoutEffect(() => {
    const entrance = entranceRef.current
    if (!entrance.shouldAnimateEntrance(entrance.atomId)) return

    const element = motionElement(motionId)
    if (!element || prefersReducedMotion() || typeof element.animate !== 'function') return

    const { siblingIndex: index, tokens } = entrance
    const animation = element.animate(entranceKeyframes(tokens, renderedOpacity(element)), {
      delay: index * tokens.motion.staggerIntervalMs,
      duration: tokens.motion.entranceDurationMs,
      easing: tokens.motion.entranceEasing,
      fill: 'backwards',
    })
    return () => animation.cancel()
  }, [motionId])

  useLayoutEffect(() => {
    return () => {
      for (const animation of activeUpdateAnimationsRef.current) animation.cancel()
    }
  }, [])

  useLayoutEffect(() => {
    const element = motionElement(motionId)
    if (!element) return

    const currentContent = motionContentSnapshots(element)
    const previousRegionUpdateKey = previousRegionUpdateKeyRef.current
    previousRegionUpdateKeyRef.current = regionUpdateKey
    const previousContentUpdateKey = previousContentUpdateKeyRef.current
    previousContentUpdateKeyRef.current = contentUpdateKey
    const previousContent = previousContentRef.current
    previousContentRef.current = contentStates(currentContent)
    const shouldAnimateRegion =
      regionUpdateKey !== undefined && regionUpdateKey !== previousRegionUpdateKey
    const shouldAnimateContent =
      contentUpdateKey !== undefined && contentUpdateKey !== previousContentUpdateKey
    if (!shouldAnimateRegion && !shouldAnimateContent) return

    for (const animation of activeUpdateAnimationsRef.current) animation.cancel()
    activeUpdateAnimationsRef.current = []
    if (prefersReducedMotion() || typeof element.animate !== 'function') return

    const tokens = tokensFor(ctx.theme)
    if (shouldAnimateRegion) {
      activeUpdateAnimationsRef.current.push(
        element.animate(updateFeedbackKeyframes(tokens), {
          duration: tokens.motion.updateFeedbackDurationMs,
          easing: tokens.motion.entranceEasing,
        }),
      )
    }
    if (!shouldAnimateContent || !previousContent) return

    const changedContent = currentContent.filter(
      ({ key, signature }) => previousContent.get(key)?.signature !== signature,
    )
    const outermostChangedContent = outermostContent(changedContent)
    outermostChangedContent.forEach(({ element: content, key }, index) => {
      if (typeof content.animate !== 'function') return
      const previousOpacity = previousContent.get(key)?.opacity
      const startOpacity =
        content.getAttribute('data-veduta-motion-content-mode') === 'previous-opacity' &&
        previousOpacity !== undefined
          ? previousOpacity
          : 0
      activeUpdateAnimationsRef.current.push(
        content.animate(contentFadeKeyframes(startOpacity, renderedOpacity(content)), {
          delay: index * tokens.motion.staggerIntervalMs,
          duration: tokens.motion.entranceDurationMs,
          easing: tokens.motion.entranceEasing,
          fill: 'backwards',
        }),
      )
    })
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

function entranceKeyframes(tokens: CatalogTokens, opacity: number): Keyframe[] {
  return [
    { opacity: 0, transform: `translateY(${tokens.space.sm}px)` },
    { opacity, transform: 'translateY(0)' },
  ]
}

function updateFeedbackKeyframes(tokens: CatalogTokens): Keyframe[] {
  return [
    {
      outline: `0 solid ${tokens.color.accent}`,
      outlineOffset: '0',
      offset: 0,
    },
    {
      outline: `${tokens.space.xs}px solid ${tokens.color.accent}`,
      outlineOffset: `${tokens.space.xs}px`,
      offset: Math.min(
        1,
        tokens.motion.entranceDurationMs / tokens.motion.updateFeedbackDurationMs,
      ),
    },
    {
      outline: `0 solid ${tokens.color.accent}`,
      outlineOffset: `${tokens.space.sm}px`,
      offset: 1,
    },
  ]
}

function contentFadeKeyframes(startOpacity: number, opacity: number): Keyframe[] {
  return [{ opacity: startOpacity }, { opacity }]
}

interface MotionContentSnapshot {
  element: Element
  key: string
  signature: string
  opacity: number
}

interface MotionContentState {
  signature: string
  opacity: number
}

/** Content snapshots are in DOM pre-order, so the latest outer boundary owns later descendants. */
function outermostContent(snapshots: MotionContentSnapshot[]): MotionContentSnapshot[] {
  const outermost: MotionContentSnapshot[] = []
  for (const snapshot of snapshots) {
    if (!outermost.at(-1)?.element.contains(snapshot.element)) outermost.push(snapshot)
  }
  return outermost
}

function motionContentSnapshots(root: Element): MotionContentSnapshot[] {
  const elements: Element[] = []
  collectOwnedMotionContent(root, root, elements)
  return elements.map((element, index) => ({
    element,
    key: scopedContentKey(element, index),
    signature: contentSignature(element),
    opacity: renderedOpacity(element),
  }))
}

function collectOwnedMotionContent(root: Element, element: Element, content: Element[]): void {
  if (element !== root && element.hasAttribute('data-veduta-atom-id')) return
  if (element.getAttribute('data-veduta-motion-content') === 'true') content.push(element)
  for (const child of element.children) collectOwnedMotionContent(root, child, content)
}

function scopedContentKey(element: Element, index: number): string {
  const atomId = element.closest('[data-veduta-atom-id]')?.getAttribute('data-veduta-atom-id')
  const contentKey = element.getAttribute('data-veduta-motion-content-key') ?? String(index)
  return `${atomId ?? 'unscoped'}:${contentKey}`
}

function contentStates(
  snapshots: MotionContentSnapshot[],
): ReadonlyMap<string, MotionContentState> {
  return new Map(snapshots.map(({ key, signature, opacity }) => [key, { signature, opacity }]))
}

function contentSignature(element: Element): string {
  const explicitSignature = element.getAttribute('data-veduta-motion-content-signature')
  if (explicitSignature !== null) return explicitSignature
  const controls = [element, ...element.querySelectorAll('input, select, textarea')]
    .flatMap((candidate) => {
      if (candidate instanceof HTMLInputElement) {
        return [`input:${candidate.type}:${candidate.value}:${candidate.checked}`]
      }
      if (candidate instanceof HTMLSelectElement) {
        return [`select:${candidate.value}:${candidate.selectedIndex}`]
      }
      if (candidate instanceof HTMLTextAreaElement) return [`textarea:${candidate.value}`]
      return []
    })
    .join('|')
  return `${element.outerHTML}|${controls}`
}

function renderedOpacity(element: Element): number {
  const inlineOpacity =
    element instanceof HTMLElement ? Number.parseFloat(element.style.opacity) : Number.NaN
  if (Number.isFinite(inlineOpacity)) return inlineOpacity
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return 1
  const opacity = Number.parseFloat(window.getComputedStyle(element).opacity)
  return Number.isFinite(opacity) ? opacity : 1
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}
