import { vi } from 'vitest'

const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')

export interface MotionAnimationCall {
  nodeId: string
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
      nodeId: this.getAttribute('data-veduta-atom-id') ?? '',
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
