// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { useSurfacePinFeedback } from './surface-pin-feedback.ts'

it('consumes confirmed local Pin once and discards unrendered feedback when leaving its route', () => {
  const { result, rerender } = renderHook(
    ({ route, space }) => useSurfacePinFeedback(route, space),
    { initialProps: { route: 'health-entry', space: 'spc-health' } },
  )
  act(() => result.current.register('srf-other', 'spc-work', 1))
  expect(result.current.keys).toEqual({})
  act(() => result.current.register('srf-goal', 'spc-health', 2))
  expect(result.current.keys).toEqual({ 'srf-goal': 'pin:2' })
  act(() => result.current.acknowledge('srf-goal', 'pin:1'))
  expect(result.current.keys).toEqual({ 'srf-goal': 'pin:2' })
  act(() => result.current.acknowledge('srf-goal', 'pin:2'))
  expect(result.current.keys).toEqual({})
  act(() => result.current.register('srf-goal', 'spc-health', 3))
  rerender({ route: 'work-entry', space: 'spc-work' })
  expect(result.current.keys).toEqual({})
  rerender({ route: 'health-entry', space: 'spc-health' })
  expect(result.current.keys).toEqual({})
})
