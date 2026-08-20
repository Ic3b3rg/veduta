import { vi } from 'vitest'

const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')

export interface MotionAnimationCall {
  nodeId: string
  contentKey: string | null
  targetTag: string
  targetText: string
  keyframes: Keyframe[] | PropertyIndexedKeyframes
  options: KeyframeAnimationOptions
}

export function installMotionBrowser(reducedMotion: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: reducedMotion,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  )
  const calls: MotionAnimationCall[] = []
  const animate = vi.fn(function (
    this: Element,
    keyframes: Keyframe[] | PropertyIndexedKeyframes,
    options?: number | KeyframeAnimationOptions,
  ) {
    if (!options || typeof options === 'number') throw new Error('motion options are required')
    calls.push({
      nodeId:
        this.getAttribute('data-veduta-atom-id') ??
        this.closest('[data-veduta-atom-id]')?.getAttribute('data-veduta-atom-id') ??
        '',
      contentKey: this.getAttribute('data-veduta-motion-content-key'),
      targetTag: this.tagName,
      targetText: this.textContent ?? '',
      keyframes,
      options,
    })
    return { cancel: vi.fn() }
  })
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: animate,
  })
  return { animate, calls }
}

export function restoreMotionBrowser(): void {
  vi.unstubAllGlobals()
  if (originalAnimate) {
    Object.defineProperty(Element.prototype, 'animate', originalAnimate)
  } else {
    Reflect.deleteProperty(Element.prototype, 'animate')
  }
}
