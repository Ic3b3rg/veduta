// @vitest-environment jsdom
import { SurfaceSchema, formSetPlan, type JsonObject } from '@veduta/protocol'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderNode } from './render.tsx'
import type { ActionConfirmation, ActionConfirmations } from './types.ts'

function recordSurface(valueType: 'string' | 'number' = 'string') {
  return SurfaceSchema.parse({
    id: 'srf-records',
    spaceId: 'spc-home',
    title: 'Records',
    freshness: { updatedAt: '2026-10-01T10:00:00.000Z', updatedBy: 'agent' },
    state: { draft: '', records: [] },
    tree: {
      id: 'records-layout',
      type: 'Box',
      children: [
        {
          id: 'record-form',
          type: 'Form',
          props: { label: 'New record', submitLabel: 'Record' },
          children: [
            {
              id: 'record-draft',
              type: 'Input',
              binding: 'draft',
              props: {
                label: 'Record text',
                ...(valueType === 'number' ? { valueType: 'number' } : {}),
              },
            },
          ],
          actions: [
            {
              name: 'submit',
              path: 'fast',
              revision: 'acr-record-form',
              plan: {
                inputs: { draft: { type: valueType } },
                targets: {
                  draft: { type: 'string' },
                  records: {
                    type: 'array',
                    items: {
                      type: 'object',
                      identityKey: 'id',
                      fields: { id: { type: 'string' }, text: { type: valueType } },
                    },
                  },
                },
                steps: [
                  {
                    op: 'append',
                    target: 'records',
                    value: {
                      source: 'object',
                      fields: {
                        id: { source: 'metadata', name: 'recordId' },
                        text: { source: 'input', name: 'draft' },
                      },
                    },
                  },
                  { op: 'clear', target: 'draft', value: '' },
                ],
              },
            },
          ],
        },
        { id: 'records-table', type: 'Table', binding: 'records', props: { columns: ['text'] } },
      ],
    },
  })
}

const surface = recordSurface()

const confirmation: ActionConfirmation = {
  intentId: '7a0c0ea9-4e1d-4471-b3c2-1a263b54f416',
  actionRevision: 'acr-record-form',
  inputs: { draft: 'A' },
  outcome: 'committed',
}

afterEach(cleanup)

describe('Form action confirmations', () => {
  it('clears a failed local draft when its append and clear completes later', async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error('HTTP failed'))
    const acknowledgeAction = vi.fn()
    const ctx = { state: surface.state, dispatch, acknowledgeAction }
    const view = render(renderNode(surface.tree, ctx))
    const input = recordInput()

    fireEvent.change(input, { target: { value: 'A' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    expect((await screen.findByRole('alert')).textContent).toBe('HTTP failed')
    expect(input.value).toBe('A')
    expect(surface.state['draft']).toBe('')
    expect(surface.state['records']).toEqual([])

    const canonicalState: JsonObject = { draft: '', records: [{ id: 'record-1', text: 'A' }] }
    const confirmedCtx = {
      ...ctx,
      state: canonicalState,
      actionConfirmations: { 'record-form': { submit: confirmation } },
    }
    view.rerender(renderNode(surface.tree, confirmedCtx))

    expect(screen.getByRole('cell', { name: 'A' })).toBeDefined()
    expect(input.value).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(acknowledgeAction).toHaveBeenCalledExactlyOnceWith(
      'record-form',
      'submit',
      confirmation.intentId,
    )

    view.rerender(renderNode(surface.tree, { ...confirmedCtx, theme: 'dark' }))
    expect(acknowledgeAction).toHaveBeenCalledOnce()
  })

  it.each([
    { edits: ['B'], expected: 'B' },
    { edits: ['B', 'A'], expected: 'A' },
  ])(
    'acknowledges the old completion while preserving later edits $edits',
    async ({ edits, expected }) => {
      const dispatch = vi.fn().mockRejectedValue(new Error('HTTP failed'))
      const acknowledgeAction = vi.fn()
      const ctx = { state: surface.state, dispatch, acknowledgeAction }
      const view = render(renderNode(surface.tree, ctx))
      const input = recordInput()
      fireEvent.change(input, { target: { value: 'A' } })
      fireEvent.click(screen.getByRole('button', { name: 'Record' }))
      await screen.findByRole('alert')

      for (const value of edits) fireEvent.change(input, { target: { value } })
      const confirmedCtx = {
        ...ctx,
        state: { draft: '', records: [{ id: 'record-1', text: 'A' }] },
        actionConfirmations: { 'record-form': { submit: confirmation } },
      }
      view.rerender(renderNode(surface.tree, confirmedCtx))

      expect(input.value).toBe(expected)
      expect(screen.queryByRole('alert')).toBeNull()
      expect(acknowledgeAction).toHaveBeenCalledExactlyOnceWith(
        'record-form',
        'submit',
        confirmation.intentId,
      )

      fireEvent.change(input, { target: { value: 'A' } })
      view.rerender(renderNode(surface.tree, { ...confirmedCtx, theme: 'dark' }))
      expect(input.value).toBe('A')
      expect(acknowledgeAction).toHaveBeenCalledOnce()
    },
  )

  it.each<{ label: string; confirmations: ActionConfirmations }>([
    {
      label: 'a different Action revision',
      confirmations: {
        'record-form': { submit: { ...confirmation, actionRevision: 'acr-other' } },
      },
    },
    {
      label: 'different typed inputs',
      confirmations: { 'record-form': { submit: { ...confirmation, inputs: { draft: 'B' } } } },
    },
    {
      label: 'a different Form',
      confirmations: { 'other-form': { submit: confirmation } },
    },
    {
      label: 'a different action',
      confirmations: { 'record-form': { other: confirmation } },
    },
  ])('ignores completion for $label', async ({ confirmations }) => {
    const dispatch = vi.fn().mockRejectedValue(new Error('HTTP failed'))
    const acknowledgeAction = vi.fn()
    const ctx = { state: surface.state, dispatch, acknowledgeAction }
    const view = render(renderNode(surface.tree, ctx))
    const input = recordInput()
    fireEvent.change(input, { target: { value: 'A' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    await screen.findByRole('alert')

    view.rerender(renderNode(surface.tree, { ...ctx, actionConfirmations: confirmations }))

    expect(input.value).toBe('A')
    expect(screen.getByRole('alert').textContent).toBe('HTTP failed')
    expect(acknowledgeAction).not.toHaveBeenCalled()
  })

  it('retains pending and recovery-pending drafts without changing canonical state', async () => {
    const submission = deferred()
    const dispatch = vi.fn(() => submission.promise)
    const acknowledgeAction = vi.fn()
    const ctx = { state: surface.state, dispatch, acknowledgeAction }
    const view = render(renderNode(surface.tree, ctx))
    const input = recordInput()
    fireEvent.change(input, { target: { value: 'A' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))

    view.rerender(renderNode(surface.tree, { ...ctx, actionConfirmations: {} }))
    expect(input.value).toBe('A')
    expect(input.disabled).toBe(true)
    expect(screen.getByRole('form', { name: 'New record' }).getAttribute('aria-busy')).toBe('true')
    expect(surface.state).toEqual({ draft: '', records: [] })
    expect(acknowledgeAction).not.toHaveBeenCalled()

    await act(async () => submission.reject(new Error('Commit delivery is still pending.')))
    expect(input.value).toBe('A')
    expect(input.disabled).toBe(false)
    expect(screen.getByRole('alert').textContent).toBe('Commit delivery is still pending.')
    expect(surface.state).toEqual({ draft: '', records: [] })
    expect(acknowledgeAction).not.toHaveBeenCalled()
  })

  it('resets a completed noop to the latest canonical defaults', async () => {
    const noopSurface = SurfaceSchema.parse({
      ...surface,
      tree: {
        id: 'record-form',
        type: 'Form',
        props: { label: 'Remove record', submitLabel: 'Remove' },
        children: [
          { id: 'record-draft', type: 'Input', binding: 'draft', props: { label: 'Record text' } },
        ],
        actions: [
          {
            name: 'submit',
            path: 'fast',
            revision: 'acr-record-form',
            plan: {
              inputs: { draft: { type: 'string' } },
              targets: {
                records: {
                  type: 'array',
                  items: {
                    type: 'object',
                    identityKey: 'id',
                    fields: { id: { type: 'string' }, text: { type: 'string' } },
                  },
                },
              },
              steps: [
                {
                  op: 'remove',
                  target: 'records',
                  selector: { source: 'input', name: 'draft' },
                  missing: 'noop',
                },
              ],
            },
          },
        ],
      },
    })
    const dispatch = vi.fn().mockRejectedValue(new Error('HTTP failed'))
    const acknowledgeAction = vi.fn()
    const ctx = { state: noopSurface.state, dispatch, acknowledgeAction }
    const view = render(renderNode(noopSurface.tree, ctx))
    const input = recordInput()
    fireEvent.change(input, { target: { value: 'A' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await screen.findByRole('alert')

    view.rerender(
      renderNode(noopSurface.tree, {
        ...ctx,
        state: { draft: 'Remote default', records: [] },
        actionConfirmations: { 'record-form': { submit: { ...confirmation, outcome: 'noop' } } },
      }),
    )

    expect(input.value).toBe('Remote default')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(acknowledgeAction).toHaveBeenCalledOnce()
  })

  it('matches a submitted numeric draft by its typed value', async () => {
    const numericSurface = recordSurface('number')
    const dispatch = vi.fn().mockRejectedValue(new Error('HTTP failed'))
    const acknowledgeAction = vi.fn()
    const ctx = { state: numericSurface.state, dispatch, acknowledgeAction }
    const view = render(renderNode(numericSurface.tree, ctx))
    const input = screen.getByRole('spinbutton', { name: 'Record text' })
    if (!(input instanceof HTMLInputElement)) throw new Error('Numeric input unavailable')
    fireEvent.change(input, { target: { value: '13.00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    await screen.findByRole('alert')
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'record-form' }),
      'submit',
      { draft: 13 },
    )

    view.rerender(
      renderNode(numericSurface.tree, {
        ...ctx,
        state: { draft: '', records: [{ id: 'record-1', text: 13 }] },
        actionConfirmations: {
          'record-form': { submit: { ...confirmation, inputs: { draft: 13 } } },
        },
      }),
    )

    expect(input.value).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(acknowledgeAction).toHaveBeenCalledExactlyOnceWith(
      'record-form',
      'submit',
      confirmation.intentId,
    )
  })

  it('preserves another failed Form when this Form completes', async () => {
    const otherSurface = SurfaceSchema.parse({
      ...surface,
      state: { ...surface.state, otherDraft: '' },
      tree: {
        ...surface.tree,
        children: [
          ...(surface.tree.children ?? []),
          {
            id: 'other-form',
            type: 'Form',
            props: { label: 'Other record', submitLabel: 'Save other' },
            children: [
              {
                id: 'other-draft',
                type: 'Input',
                binding: 'otherDraft',
                props: { label: 'Other text' },
              },
            ],
            actions: [
              {
                name: 'submit',
                path: 'fast',
                revision: 'acr-other-form',
                plan: formSetPlan(['otherDraft']),
              },
            ],
          },
        ],
      },
    })
    const dispatch = vi.fn().mockRejectedValue(new Error('HTTP failed'))
    const acknowledgeAction = vi.fn()
    const ctx = { state: otherSurface.state, dispatch, acknowledgeAction }
    const view = render(renderNode(otherSurface.tree, ctx))
    const input = recordInput()
    const otherInput = screen.getByRole('textbox', { name: 'Other text' })
    if (!(otherInput instanceof HTMLInputElement)) throw new Error('Other input unavailable')
    fireEvent.change(input, { target: { value: 'A' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    await screen.findByRole('alert')
    fireEvent.change(otherInput, { target: { value: 'Other draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save other' }))
    await screen.findAllByRole('alert')

    view.rerender(
      renderNode(otherSurface.tree, {
        ...ctx,
        actionConfirmations: { 'record-form': { submit: confirmation } },
      }),
    )

    expect(input.value).toBe('')
    expect(otherInput.value).toBe('Other draft')
    expect(screen.getByRole('alert').textContent).toBe('HTTP failed')
    expect(acknowledgeAction).toHaveBeenCalledExactlyOnceWith(
      'record-form',
      'submit',
      confirmation.intentId,
    )
  })

  it('does not show an old transport error after confirmation and a newer edit', async () => {
    const submission = deferred()
    const dispatch = vi.fn(() => submission.promise)
    const acknowledgeAction = vi.fn()
    const ctx = { state: surface.state, dispatch, acknowledgeAction }
    const view = render(renderNode(surface.tree, ctx))
    const input = recordInput()
    fireEvent.change(input, { target: { value: 'A' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))

    view.rerender(
      renderNode(surface.tree, {
        ...ctx,
        actionConfirmations: { 'record-form': { submit: confirmation } },
      }),
    )
    expect(input.value).toBe('')
    expect(input.disabled).toBe(false)
    fireEvent.change(input, { target: { value: 'B' } })
    await act(async () => submission.reject(new Error('Old HTTP request failed')))

    expect(input.value).toBe('B')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(acknowledgeAction).toHaveBeenCalledOnce()
  })

  it('keeps a newer submission pending when the completed request settles later', async () => {
    const first = deferred()
    const second = deferred()
    const dispatch = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const acknowledgeAction = vi.fn()
    const ctx = { state: surface.state, dispatch, acknowledgeAction }
    const view = render(renderNode(surface.tree, ctx))
    const input = recordInput()
    fireEvent.change(input, { target: { value: 'A' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))

    const firstState = { draft: '', records: [{ id: 'record-1', text: 'A' }] }
    view.rerender(
      renderNode(surface.tree, {
        ...ctx,
        state: firstState,
        actionConfirmations: { 'record-form': { submit: confirmation } },
      }),
    )
    expect(input.value).toBe('')
    expect(acknowledgeAction).toHaveBeenCalledOnce()

    view.rerender(renderNode(surface.tree, { ...ctx, state: firstState, actionConfirmations: {} }))
    fireEvent.change(input, { target: { value: 'B' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    await act(async () => first.reject(new Error('Old request failed')))

    expect(input.value).toBe('B')
    expect(input.disabled).toBe(true)
    expect(screen.queryByRole('alert')).toBeNull()
    const secondConfirmation: ActionConfirmation = {
      ...confirmation,
      intentId: 'b2a563b2-c05f-4a9b-a4a5-4665c7c96fc8',
      inputs: { draft: 'B' },
    }
    view.rerender(
      renderNode(surface.tree, {
        ...ctx,
        state: {
          draft: '',
          records: [
            { id: 'record-1', text: 'A' },
            { id: 'record-2', text: 'B' },
          ],
        },
        actionConfirmations: { 'record-form': { submit: secondConfirmation } },
      }),
    )
    await act(async () => second.reject(new Error('Second HTTP response was lost')))

    expect(input.value).toBe('')
    expect(input.disabled).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(acknowledgeAction.mock.calls).toEqual([
      ['record-form', 'submit', confirmation.intentId],
      ['record-form', 'submit', secondConfirmation.intentId],
    ])
  })

  it('acknowledges an earlier completion while retaining a newer failed submission', async () => {
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error('Request A failed'))
      .mockRejectedValueOnce(new Error('Request B failed'))
    const acknowledgeAction = vi.fn()
    const ctx = { state: surface.state, dispatch, acknowledgeAction }
    const view = render(renderNode(surface.tree, ctx))
    const input = recordInput()
    fireEvent.change(input, { target: { value: 'A' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Request A failed')
    fireEvent.change(input, { target: { value: 'B' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Request B failed')

    view.rerender(
      renderNode(surface.tree, {
        ...ctx,
        state: { draft: '', records: [{ id: 'record-1', text: 'A' }] },
        actionConfirmations: { 'record-form': { submit: confirmation } },
      }),
    )

    expect(input.value).toBe('B')
    expect(screen.getByRole('alert').textContent).toBe('Request B failed')
    expect(acknowledgeAction).toHaveBeenCalledExactlyOnceWith(
      'record-form',
      'submit',
      confirmation.intentId,
    )

    const secondConfirmation: ActionConfirmation = {
      ...confirmation,
      intentId: 'b2a563b2-c05f-4a9b-a4a5-4665c7c96fc8',
      inputs: { draft: 'B' },
    }
    view.rerender(
      renderNode(surface.tree, {
        ...ctx,
        state: {
          draft: '',
          records: [
            { id: 'record-1', text: 'A' },
            { id: 'record-2', text: 'B' },
          ],
        },
        actionConfirmations: { 'record-form': { submit: secondConfirmation } },
      }),
    )
    expect(input.value).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(acknowledgeAction.mock.calls).toEqual([
      ['record-form', 'submit', confirmation.intentId],
      ['record-form', 'submit', secondConfirmation.intentId],
    ])
  })
})

function recordInput(): HTMLInputElement {
  const input = screen.getByRole('textbox', { name: 'Record text' })
  if (!(input instanceof HTMLInputElement)) throw new Error('Record input unavailable')
  return input
}

function deferred(): {
  promise: Promise<void>
  reject: (error: Error) => void
} {
  let reject!: (error: Error) => void
  const promise = new Promise<void>((_resolve, fail) => {
    reject = fail
  })
  return { promise, reject }
}
