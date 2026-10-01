// @vitest-environment jsdom
import { AtomNodeSchema, inputSetPlan } from '@veduta/protocol'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderNode } from './render.tsx'

afterEach(cleanup)

describe('new Surface Atoms', () => {
  it('reveals standalone and coordinated content without dispatching Surface actions', () => {
    const dispatch = vi.fn()
    const node = AtomNodeSchema.parse({
      id: 'root',
      type: 'Col',
      children: [
        {
          id: 'details',
          type: 'Collapsible',
          props: { label: 'More details' },
          children: [{ id: 'details-copy', type: 'Text', props: { text: 'A hidden detail' } }],
        },
        {
          id: 'answers',
          type: 'Accordion',
          children: [
            {
              id: 'answer-one',
              type: 'Collapsible',
              props: { label: 'First answer', defaultOpen: true },
              children: [{ id: 'first-copy', type: 'Text', props: { text: 'First content' } }],
            },
            {
              id: 'answer-two',
              type: 'Collapsible',
              props: { label: 'Second answer' },
              children: [{ id: 'second-copy', type: 'Text', props: { text: 'Second content' } }],
            },
          ],
        },
      ],
    })

    render(renderNode(node, { state: {}, dispatch }))
    const details = screen.getByRole('button', { name: 'More details' })
    expect(details.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(details)
    expect(details.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('A hidden detail')).toBeDefined()

    const first = screen.getByRole('button', { name: 'First answer' })
    const second = screen.getByRole('button', { name: 'Second answer' })
    expect(first.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(second)
    expect(first.getAttribute('aria-expanded')).toBe('false')
    expect(second.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Second content')).toBeDefined()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('dispatches a boolean Switch change and renders its canonical state', () => {
    const dispatch = vi.fn()
    const node = AtomNodeSchema.parse({
      id: 'quiet-hours',
      type: 'Switch',
      binding: 'quietHours',
      props: { label: 'Quiet hours' },
      actions: [
        {
          name: 'toggle',
          path: 'fast',
          revision: 'acr-quiet-hours',
          plan: inputSetPlan('quietHours', { type: 'boolean' }),
        },
      ],
    })
    const view = render(renderNode(node, { state: { quietHours: false }, dispatch }))
    const control = screen.getByRole('switch', { name: 'Quiet hours' })
    expect(control.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(control)
    expect(dispatch).toHaveBeenCalledWith(node, 'toggle', true)

    view.rerender(renderNode(node, { state: { quietHours: true }, dispatch }))
    expect(control.getAttribute('aria-checked')).toBe('true')
  })

  it('shows the canonical Combobox label and keeps search text local until a choice is made', () => {
    const dispatch = vi.fn()
    const node = AtomNodeSchema.parse({
      id: 'city',
      type: 'Combobox',
      binding: 'city',
      props: {
        label: 'City',
        options: [
          { label: 'Rome', value: 'rm' },
          { label: 'Milan', value: 'mi' },
          { label: 'Turin', value: 'to' },
        ],
      },
      actions: [
        {
          name: 'change',
          path: 'fast',
          revision: 'acr-city',
          plan: inputSetPlan('city', { type: 'string', enum: ['rm', 'mi', 'to'] }),
        },
      ],
    })
    const view = render(renderNode(node, { state: { city: 'rm' }, dispatch }))
    const input = screen.getByRole('combobox', { name: 'City' }) as HTMLInputElement
    expect(input.value).toBe('Rome')
    fireEvent.change(input, { target: { value: 'Mil' } })
    expect(input.value).toBe('Mil')
    expect(dispatch).not.toHaveBeenCalled()

    view.unmount()
    render(renderNode(node, { state: { city: 'mi' }, dispatch }))
    expect((screen.getByRole('combobox', { name: 'City' }) as HTMLInputElement).value).toBe('Milan')
  })
})
