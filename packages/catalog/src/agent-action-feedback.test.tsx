// @vitest-environment jsdom
import { AtomNodeSchema } from '@veduta/protocol'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { renderNode } from './render.tsx'

afterEach(cleanup)

it('an unbound Agent Button clears its transport failure only from a matching completed receipt', async () => {
  const node = AtomNodeSchema.parse({
    id: 'complete-demo',
    type: 'Button',
    props: { label: 'Complete demo' },
    actions: [
      {
        name: 'complete_demo',
        path: 'agent',
        payload: { request: 'Complete the Agent action demo' },
      },
    ],
  })
  const dispatch = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(undefined)
  const acknowledgeAction = vi.fn()
  const view = render(renderNode(node, { state: {}, dispatch, acknowledgeAction }))
  const control = screen.getByRole('button', { name: 'Complete demo' })
  fireEvent.click(control)
  await act(async () => {})
  expect(screen.getByRole('alert').textContent).toBe('Offline')
  expect(control).toHaveProperty('disabled', false)
  view.rerender(
    renderNode(node, {
      state: {},
      dispatch,
      acknowledgeAction,
      actionConfirmations: {
        'complete-demo': {
          complete_demo: {
            path: 'agent',
            intentId: 'completed-intent',
            turnId: 'agent-turn-demo',
            payload: { request: 'Complete the Agent action demo' },
            outcome: 'completed',
          },
        },
      },
    }),
  )
  await act(async () => {})
  expect(screen.queryByRole('alert')).toBeNull()
  expect(control.getAttribute('aria-invalid')).toBeNull()
  expect(acknowledgeAction).toHaveBeenCalledExactlyOnceWith(
    'complete-demo',
    'complete_demo',
    'completed-intent',
  )
  fireEvent.click(control)
  await act(async () => {})
  expect(dispatch).toHaveBeenCalledTimes(2)
})

it('an older Agent value completion leaves a newer attempt pending and its late HTTP failure cannot undo confirmation', async () => {
  const node = AtomNodeSchema.parse({
    id: 'demo-enabled',
    type: 'Switch',
    binding: 'enabled',
    props: { label: 'Demo enabled' },
    actions: [{ name: 'toggle', path: 'agent', payload: { request: 'Toggle demo' } }],
  })
  let fail: (failure: Error) => void = () => {
    throw new Error('No pending request')
  }
  const pending = new Promise<void>((_resolve, reject) => {
    fail = reject
  })
  const dispatch = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockReturnValueOnce(pending)
  const acknowledgeAction = vi.fn()
  const view = render(renderNode(node, { state: { enabled: false }, dispatch, acknowledgeAction }))
  const control = screen.getByRole('switch', { name: 'Demo enabled' })
  fireEvent.click(control)
  await act(async () => {})
  expect(screen.getByRole('alert').textContent).toBe('Offline')

  view.rerender(renderNode(node, { state: { enabled: true }, dispatch, acknowledgeAction }))
  fireEvent.click(control)
  expect(dispatch).toHaveBeenNthCalledWith(2, node, 'toggle', false)
  view.rerender(
    renderNode(node, {
      state: { enabled: true },
      dispatch,
      acknowledgeAction,
      actionConfirmations: {
        'demo-enabled': {
          toggle: {
            path: 'agent',
            intentId: 'older-intent',
            turnId: 'older-turn',
            payload: { request: 'Toggle demo', value: true },
            outcome: 'completed',
          },
        },
      },
    }),
  )
  await act(async () => {})
  expect(control).toHaveProperty('disabled', true)
  expect(control.getAttribute('aria-busy')).toBe('true')
  expect(acknowledgeAction).toHaveBeenCalledWith('demo-enabled', 'toggle', 'older-intent')

  view.rerender(
    renderNode(node, {
      state: { enabled: false },
      dispatch,
      acknowledgeAction,
      actionConfirmations: {
        'demo-enabled': {
          toggle: {
            path: 'agent',
            intentId: 'newer-intent',
            turnId: 'newer-turn',
            payload: { value: false, request: 'Toggle demo' },
            outcome: 'completed',
          },
        },
      },
    }),
  )
  await act(async () => {})
  expect(control.getAttribute('aria-checked')).toBe('false')
  expect(control).toHaveProperty('disabled', false)
  expect(screen.queryByRole('status')).toBeNull()
  await act(async () => fail(new Error('Late lost response')))
  expect(screen.queryByRole('alert')).toBeNull()
})
