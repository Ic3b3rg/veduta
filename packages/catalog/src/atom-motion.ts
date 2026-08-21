import { useLayoutEffect, useRef } from 'react'
import type { CatalogTokens } from './design-system.ts'

interface AtomMotionOptions {
  atomId: string
  motionId: string
  siblingIndex: number
  shouldAnimateEntrance: (atomId: string) => boolean
  tokens: CatalogTokens
  regionUpdateKey: string | undefined
  contentUpdateKey: string | undefined
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

interface PreviousUpdate {
  regionKey: string | undefined
  contentKey: string | undefined
  content: ReadonlyMap<string, MotionContentState>
}

export function useAtomMotion({
  atomId,
  motionId,
  siblingIndex,
  shouldAnimateEntrance,
  tokens,
  regionUpdateKey,
  contentUpdateKey,
}: AtomMotionOptions): void {
  const entranceRef = useRef({ atomId, siblingIndex, shouldAnimateEntrance, tokens })
  const previousUpdateRef = useRef<PreviousUpdate | undefined>(undefined)
  const activeAnimationsRef = useRef<Animation[]>([])

  useLayoutEffect(() => {
    const entrance = entranceRef.current
    if (!entrance.shouldAnimateEntrance(entrance.atomId)) return

    const element = motionElement(motionId)
    if (!canAnimate(element)) return

    const animation = element.animate(
      entranceKeyframes(entrance.tokens, renderedOpacity(element)),
      entranceTiming(entrance.tokens, entrance.siblingIndex),
    )
    return () => animation.cancel()
  }, [motionId])

  useLayoutEffect(() => {
    return () => cancelAnimations(activeAnimationsRef.current)
  }, [])

  useLayoutEffect(() => {
    const element = motionElement(motionId)
    if (!element) return

    const currentContent = motionContentSnapshots(element)
    const previousUpdate = previousUpdateRef.current
    previousUpdateRef.current = {
      regionKey: regionUpdateKey,
      contentKey: contentUpdateKey,
      content: contentStates(currentContent),
    }
    const animateRegion = isNewUpdate(regionUpdateKey, previousUpdate?.regionKey)
    const animateContent = isNewUpdate(contentUpdateKey, previousUpdate?.contentKey)
    if (!animateRegion && !animateContent) return

    cancelAnimations(activeAnimationsRef.current)
    activeAnimationsRef.current = []
    if (!canAnimate(element)) return

    activeAnimationsRef.current = startUpdateAnimations({
      element,
      currentContent,
      previousContent: previousUpdate?.content,
      animateRegion,
      animateContent,
      tokens,
    })
  })
}

function isNewUpdate(current: string | undefined, previous: string | undefined): boolean {
  return current !== undefined && current !== previous
}

function cancelAnimations(animations: Animation[]): void {
  for (const animation of animations) animation.cancel()
}

function motionElement(motionId: string): Element | null {
  if (typeof document === 'undefined') return null
  return document.querySelector(`[data-veduta-motion-id="${motionId}"]`)
}

function canAnimate(element: Element | null): element is Element {
  return element !== null && !prefersReducedMotion() && typeof element.animate === 'function'
}

function entranceTiming(tokens: CatalogTokens, index: number): KeyframeAnimationOptions {
  return {
    delay: index * tokens.motion.staggerIntervalMs,
    duration: tokens.motion.entranceDurationMs,
    easing: tokens.motion.entranceEasing,
    fill: 'backwards',
  }
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

interface UpdateAnimationOptions {
  element: Element
  currentContent: MotionContentSnapshot[]
  previousContent: ReadonlyMap<string, MotionContentState> | undefined
  animateRegion: boolean
  animateContent: boolean
  tokens: CatalogTokens
}

function startUpdateAnimations({
  element,
  currentContent,
  previousContent,
  animateRegion,
  animateContent,
  tokens,
}: UpdateAnimationOptions): Animation[] {
  const animations: Animation[] = []
  if (animateRegion) {
    animations.push(
      element.animate(updateFeedbackKeyframes(tokens), {
        duration: tokens.motion.updateFeedbackDurationMs,
        easing: tokens.motion.entranceEasing,
      }),
    )
  }
  if (!animateContent || !previousContent) return animations

  const changedContent = currentContent.filter(
    ({ key, signature }) => previousContent.get(key)?.signature !== signature,
  )
  outermostContent(changedContent).forEach(({ element: content, key }, index) => {
    if (typeof content.animate !== 'function') return
    animations.push(
      content.animate(
        contentFadeKeyframes(
          contentStartOpacity(content, previousContent.get(key)),
          renderedOpacity(content),
        ),
        entranceTiming(tokens, index),
      ),
    )
  })
  return animations
}

function contentStartOpacity(element: Element, previous: MotionContentState | undefined): number {
  return element.getAttribute('data-veduta-motion-content-mode') === 'previous-opacity' && previous
    ? previous.opacity
    : 0
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
    .map(controlSignature)
    .filter((signature) => signature !== '')
    .join('|')
  return `${element.outerHTML}|${controls}`
}

function controlSignature(element: Element): string {
  if (element instanceof HTMLInputElement) {
    return `input:${element.type}:${element.value}:${element.checked}`
  }
  if (element instanceof HTMLSelectElement) {
    return `select:${element.value}:${element.selectedIndex}`
  }
  if (element instanceof HTMLTextAreaElement) return `textarea:${element.value}`
  return ''
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
