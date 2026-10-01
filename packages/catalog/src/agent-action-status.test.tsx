// @vitest-environment jsdom
import { AtomNodeSchema } from '@veduta/protocol'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { renderNode } from './render.tsx'
import type { ActionStatus } from './types.ts'

afterEach(cleanup)

it('an Agent control restores its current runtime wait or recoverable failure after remount without local attempts', () => {
  const node = AtomNodeSchema.parse({
    id: 'demo-action',
    type: 'Button',
    props: { label: 'Complete demo' },
    actions: [{ name: 'complete_demo', path: 'agent' }],
  })
  const dispatch = vi.fn()
  const content = (status?: ActionStatus) =>
    renderNode(node, {
      state: {},
      dispatch,
      ...(status ? { actionStatuses: { 'demo-action': { complete_demo: status } } } : {}),
    })
  const first = render(content({ status: 'pending' }))
  const button = () => screen.getByRole('button', { name: 'Complete demo' })
  expect(button()).toHaveProperty('disabled', true)
  expect(button().getAttribute('aria-busy')).toBe('true')
  expect(screen.getByRole('status').textContent).toBe('Working…')
  fireEvent.click(button())
  expect(dispatch).not.toHaveBeenCalled()
  first.unmount()

  const remounted = render(content({ status: 'pending' }))
  expect(button()).toHaveProperty('disabled', true)
  expect(screen.getByRole('status').textContent).toBe('Working…')
  remounted.rerender(content({ status: 'queued', message: 'Gateway offline. Try again.' }))
  expect(button()).toHaveProperty('disabled', false)
  expect(button().getAttribute('aria-busy')).toBeNull()
  expect(screen.getByRole('status').textContent).toBe('Queued. Awaiting confirmation.')
  const alert = screen.getByRole('alert')
  expect(alert.textContent).toBe('Gateway offline. Try again.')
  expect(button().getAttribute('aria-invalid')).toBe('true')
  expect(button().getAttribute('aria-describedby')).toBe(alert.id)

  remounted.rerender(content({ status: 'failed', message: 'The Surface update was rejected.' }))
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getByRole('alert').textContent).toBe('The Surface update was rejected.')
  expect(button()).toHaveProperty('disabled', false)
  remounted.rerender(content())
  expect(screen.queryByRole('alert')).toBeNull()
  expect(button().getAttribute('aria-invalid')).toBeNull()
})
