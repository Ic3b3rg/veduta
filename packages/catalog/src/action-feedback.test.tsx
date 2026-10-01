// @vitest-environment jsdom
import { AtomNodeSchema, inputSetPlan, literalSetPlan } from '@veduta/protocol'
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

it('an unbound ListItem reconciles late confirmation and starts a new command without forwarding payload inputs', async () => {
  const node = AtomNodeSchema.parse({
    id: 'apply-entry',
    type: 'ListItem',
    props: { label: 'Apply entry', detail: 'Use the saved choice' },
    actions: [
      {
        name: 'click',
        path: 'fast',
        revision: 'acr-apply-entry',
        plan: literalSetPlan('message', 'Applied'),
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
  const acknowledgeAction = vi.fn()
  const view = render(
    renderNode(node, { state: { message: 'Waiting' }, dispatch, acknowledgeAction }),
  )
  const control = screen.getByRole('button', { name: /Apply entry/ })
  fireEvent.click(control)
  expect(control.getAttribute('aria-busy')).toBe('true')
  expect(control).toHaveProperty('disabled', true)
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(node, 'click')
  await act(async () => fail(new Error('Offline')))
  expect(screen.getByRole('alert').textContent).toBe('Offline')
  expect(control).toHaveProperty('disabled', false)

  view.rerender(
    renderNode(node, {
      state: { message: 'Applied' },
      dispatch,
      acknowledgeAction,
      actionConfirmations: {
        'apply-entry': {
          click: {
            intentId: 'confirmed-entry',
            actionRevision: 'acr-apply-entry',
            inputs: {},
            outcome: 'committed',
          },
        },
      },
    }),
  )
  await act(async () => {})
  expect(screen.queryByRole('alert')).toBeNull()
  expect(control.getAttribute('aria-invalid')).toBeNull()
  expect(acknowledgeAction).toHaveBeenCalledExactlyOnceWith(
    'apply-entry',
    'click',
    'confirmed-entry',
  )
  fireEvent.click(control)
  await act(async () => {})
  expect(dispatch).toHaveBeenCalledTimes(2)
})

it('Agent-backed Automation awaits acceptance without changing Scheduler state and permits a typed retry', async () => {
  const node = AtomNodeSchema.parse({
    id: 'weekly-review',
    type: 'Automation',
    binding: 'enabled',
    props: { label: 'Weekly review', schedule: 'Every Monday' },
    actions: [{ name: 'toggle', path: 'agent', payload: { jobId: 'job-review' } }],
  })
  let fail: (failure: Error) => void = () => {
    throw new Error('Not submitted')
  }
  const pending = new Promise<void>((_resolve, reject) => {
    fail = reject
  })
  const dispatch = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(undefined)
  const view = render(renderNode(node, { state: { enabled: true }, dispatch }))
  const control = screen.getByRole('switch', { name: 'Weekly review' })
  fireEvent.click(control)
  expect(control.getAttribute('aria-busy')).toBe('true')
  expect(control).toHaveProperty('disabled', true)
  expect(control.getAttribute('aria-checked')).toBe('true')
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(node, 'toggle', false)
  expect(screen.getByText('Every Monday')).toBeDefined()
  await act(async () => fail(new Error('The Agent action could not be accepted. Try again.')))
  expect(screen.getByRole('alert').textContent).toBe(
    'The Agent action could not be accepted. Try again.',
  )
  expect(control.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id)
  expect(control).toHaveProperty('disabled', false)

  fireEvent.click(control)
  await act(async () => {})
  expect(dispatch).toHaveBeenNthCalledWith(2, node, 'toggle', false)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(control.getAttribute('aria-checked')).toBe('true')
  view.rerender(renderNode(node, { state: { enabled: false }, dispatch }))
  expect(control.getAttribute('aria-checked')).toBe('false')
})
