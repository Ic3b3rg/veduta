// @vitest-environment jsdom
import { AtomNodeSchema, inputSetPlan, literalSetPlan, type JsonValue } from '@veduta/protocol'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderNode } from './render.tsx'

afterEach(cleanup)

const options = [
  { label: 'First', value: 'first' },
  { label: 'Second', value: 'second' },
]
const cases = [
  { type: 'Button', before: false, next: true },
  { type: 'Checkbox', before: false, next: true },
  { type: 'Select', before: 'first', next: 'second' },
  { type: 'RadioGroup', before: 'first', next: 'second' },
  { type: 'DatePicker', before: '2026-10-01', next: '2026-10-02' },
] as const

function control(type: (typeof cases)[number]['type'], disabled = false) {
  const offered = type === 'Select' || type === 'RadioGroup'
  return AtomNodeSchema.parse({
    id: 'control',
    type,
    ...(type === 'Button' ? {} : { binding: 'value' }),
    props: { label: 'Choice', disabled, ...(offered ? { options } : {}) },
    actions: [
      {
        name: type === 'Button' ? 'apply' : type === 'Checkbox' ? 'toggle' : 'change',
        path: 'fast',
        revision: 'acr-control',
        plan:
          type === 'Button'
            ? literalSetPlan('value', true)
            : inputSetPlan(
                'value',
                type === 'Checkbox'
                  ? { type: 'boolean' }
                  : {
                      type: 'string',
                      ...(offered ? { enum: options.map((option) => option.value) } : {}),
                    },
              ),
      },
    ],
  })
}

function owningControl(type: (typeof cases)[number]['type']) {
  if (type === 'DatePicker') return screen.getByLabelText('Choice')
  return screen.getByRole(
    type === 'Button'
      ? 'button'
      : type === 'Checkbox'
        ? 'checkbox'
        : type === 'Select'
          ? 'combobox'
          : 'radiogroup',
    { name: 'Choice' },
  )
}

function choose(type: (typeof cases)[number]['type'], value: JsonValue) {
  if (type === 'Button' || type === 'Checkbox') fireEvent.click(owningControl(type))
  else if (type === 'RadioGroup')
    fireEvent.click(screen.getByRole('radio', { name: value === 'first' ? 'First' : 'Second' }))
  else fireEvent.change(owningControl(type), { target: { value } })
}

describe('operable selection and action controls', () => {
  it.each(cases)(
    '$type keeps canonical state while pending and exposes recoverable failure',
    async ({ type, before, next }) => {
      const node = control(type)
      let fail: (error: Error) => void = () => {
        throw new Error('not submitted')
      }
      const pending = new Promise<void>((_resolve, reject) => {
        fail = reject
      })
      const dispatch = vi.fn(() => pending)
      render(renderNode(node, { state: { value: before }, dispatch }))
      choose(type, next)
      expect(dispatch).toHaveBeenCalledTimes(1)
      const actionName = node.actions![0]!.name
      expect(dispatch.mock.calls[0]).toEqual(
        type === 'Button' ? [node, actionName] : [node, actionName, next],
      )
      expect(owningControl(type).getAttribute('aria-busy')).toBe('true')
      expect(screen.getByRole('status').textContent).toContain('Working')
      if (type === 'Checkbox')
        expect(owningControl(type).getAttribute('aria-checked')).toBe('false')
      if (type === 'Select' || type === 'DatePicker')
        expect(owningControl(type)).toHaveProperty('value', before)
      if (type === 'RadioGroup')
        expect(screen.getByRole('radio', { name: 'First' }).getAttribute('aria-checked')).toBe(
          'true',
        )
      await act(async () => {
        fail(new Error('Gateway unavailable. Try again.'))
      })
      expect(screen.getByRole('alert').textContent).toBe('Gateway unavailable. Try again.')
      expect(owningControl(type).getAttribute('aria-describedby')).toBe(
        screen.getByRole('alert').id,
      )
      expect(owningControl(type).getAttribute('aria-invalid')).toBe('true')
      expect(owningControl(type).getAttribute('aria-busy')).not.toBe('true')
      expect(screen.queryByRole('status')).toBeNull()
      choose(type, next)
      expect(dispatch).toHaveBeenCalledTimes(2)
      await act(async () => {})
    },
  )

  it.each(cases)(
    '$type reconciles late canonical confirmation and can start a fresh gesture',
    async ({ type, before, next }) => {
      const node = control(type)
      const action = node.actions![0]!
      const dispatch = vi
        .fn()
        .mockRejectedValueOnce(new Error('Offline'))
        .mockResolvedValue(undefined)
      const acknowledgeAction = vi.fn()
      const view = render(
        renderNode(node, { state: { value: before }, dispatch, acknowledgeAction }),
      )
      choose(type, next)
      await act(async () => {})
      expect(screen.getByRole('alert').textContent).toBe('Offline')
      view.rerender(
        renderNode(node, {
          state: { value: next },
          dispatch,
          acknowledgeAction,
          actionConfirmations: {
            control: {
              [action.name]: {
                intentId: 'confirmed',
                actionRevision: 'acr-control',
                inputs: type === 'Button' ? {} : { value: next },
                outcome: 'committed',
              },
            },
          },
        }),
      )
      await act(async () => {})
      expect(screen.queryByRole('alert')).toBeNull()
      expect(acknowledgeAction).toHaveBeenCalledWith('control', action.name, 'confirmed')
      choose(type, type === 'Button' ? next : before)
      await act(async () => {})
      expect(dispatch).toHaveBeenCalledTimes(2)
    },
  )

  it.each(cases)(
    '$type exposes a labelled disabled control without dispatch',
    ({ type, before, next }) => {
      const dispatch = vi.fn()
      render(renderNode(control(type, true), { state: { value: before }, dispatch }))
      const element = owningControl(type)
      if (type === 'RadioGroup')
        expect(screen.getByRole('radio', { name: 'Second' })).toHaveProperty('disabled', true)
      else expect(element).toHaveProperty('disabled', true)
      choose(type, next)
      expect(dispatch).not.toHaveBeenCalled()
    },
  )

  it('does not forward a Button literal or Agent payload as unrelated control inputs', async () => {
    const dispatch = vi.fn()
    const node = AtomNodeSchema.parse({
      id: 'review',
      type: 'Button',
      props: { label: 'Review' },
      actions: [{ name: 'review', path: 'agent', payload: { decisionId: 'decision' } }],
    })
    render(renderNode(node, { state: {}, dispatch }))
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await act(async () => {})
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(node, 'review')
  })
})
