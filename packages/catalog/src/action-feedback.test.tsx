// @vitest-environment jsdom
import { AtomNodeSchema, inputSetPlan } from '@veduta/protocol'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { renderNode } from './render.tsx'

afterEach(cleanup)

it('Switch keeps canonical state while pending and exposes a linked error that permits retry', async () => {
  const node = AtomNodeSchema.parse({
    id: 'quiet-hours',
    type: 'Switch',
    binding: 'enabled',
    props: { label: 'Quiet hours' },
    actions: [
      {
        name: 'toggle',
        path: 'fast',
        revision: 'acr-quiet-hours',
        plan: inputSetPlan('enabled', { type: 'boolean' }),
      },
    ],
  })
  let fail: (failure: Error) => void = () => {
    throw new Error('Not submitted')
  }
  const pending = new Promise<void>((_resolve, reject) => {
    fail = reject
  })
  const dispatch = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(undefined)
  render(renderNode(node, { state: { enabled: false }, dispatch }))
  const control = screen.getByRole('switch', { name: 'Quiet hours' })
  fireEvent.click(control)
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(node, 'toggle', true)
  expect(control.getAttribute('aria-checked')).toBe('false')
  expect(control.getAttribute('aria-busy')).toBe('true')
  expect(control).toHaveProperty('disabled', true)
  expect(screen.getByRole('status').textContent).toBe('Working…')
  fireEvent.click(control)
  expect(dispatch).toHaveBeenCalledTimes(1)

  await act(async () => fail(new Error('Gateway unavailable. Try again.')))
  const alert = screen.getByRole('alert')
  expect(alert.textContent).toBe('Gateway unavailable. Try again.')
  expect(control.getAttribute('aria-describedby')).toBe(alert.id)
  expect(control.getAttribute('aria-invalid')).toBe('true')
  expect(control).toHaveProperty('disabled', false)
  expect(screen.queryByRole('status')).toBeNull()

  fireEvent.click(control)
  await act(async () => {})
  expect(dispatch).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(control.getAttribute('aria-checked')).toBe('false')
})
