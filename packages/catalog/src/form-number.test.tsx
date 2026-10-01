// @vitest-environment jsdom
import { SurfaceSchema } from '@veduta/protocol'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { renderNode } from './render.tsx'

const surface = SurfaceSchema.parse({
  id: 'srf-number',
  spaceId: 'spc-test',
  title: 'Measurement',
  tree: {
    id: 'measurement',
    type: 'Form',
    props: { label: 'Measurement', submitLabel: 'Record' },
    actions: [
      {
        name: 'submit',
        path: 'fast',
        revision: 'acr-number',
        plan: {
          inputs: { draft: { type: 'number' } },
          targets: { current: { type: 'number' }, draft: { type: 'string' } },
          steps: [
            { op: 'set', target: 'current', value: { source: 'input', name: 'draft' } },
            { op: 'clear', target: 'draft', value: '' },
          ],
        },
      },
    ],
    children: [
      {
        id: 'draft',
        type: 'Input',
        binding: 'draft',
        props: { label: 'Value', valueType: 'number' },
      },
    ],
  },
  state: { draft: '', current: 0 },
  freshness: { updatedAt: '2026-10-01T08:00:00Z', updatedBy: 'user' },
})

afterEach(cleanup)

it('submits a finite typed number and clears only after canonical confirmation', async () => {
  let resolve!: () => void
  const response = new Promise<void>((done) => {
    resolve = done
  })
  const dispatch = vi.fn(() => response)
  const view = render(renderNode(surface.tree, { state: surface.state, dispatch }))
  const input = screen.getByRole('spinbutton', { name: 'Value' })
  fireEvent.change(input, { target: { value: '74' } })
  fireEvent.click(screen.getByRole('button', { name: 'Record' }))
  expect(dispatch).toHaveBeenCalledWith(surface.tree, 'submit', { draft: 74 })
  expect(input).toHaveProperty('value', '74')
  expect(input).toHaveProperty('disabled', true)
  view.rerender(renderNode(surface.tree, { state: { draft: '', current: 74 }, dispatch }))
  expect(input).toHaveProperty('value', '74')
  await act(async () => resolve())
  await waitFor(() => expect(input).toHaveProperty('disabled', false))
  expect(input).toHaveProperty('value', '')
})
