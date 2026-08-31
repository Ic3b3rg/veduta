// @vitest-environment jsdom
import { SurfaceSchema, type AtomNode, type JsonValue } from '@veduta/protocol'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderNode } from './render.tsx'

const formSurface = SurfaceSchema.parse({
  id: 'srf-profile',
  spaceId: 'spc-home',
  title: 'Profile',
  tree: {
    id: 'profile-form',
    type: 'Form',
    props: { label: 'Profile details', submitLabel: 'Save profile' },
    actions: [{ name: 'submit', path: 'fast', stateKeys: ['displayName', 'bio'] }],
    children: [
      {
        id: 'display-name',
        type: 'Input',
        binding: 'displayName',
        props: { label: 'Display name', placeholder: 'Ada' },
      },
      {
        id: 'bio',
        type: 'Textarea',
        binding: 'bio',
        props: { label: 'Biography', rows: 4 },
      },
    ],
  },
  state: { displayName: 'Ada', bio: 'First programmer' },
  freshness: { updatedAt: '2026-08-31T20:00:00.000Z', updatedBy: 'agent' },
})

afterEach(cleanup)

describe('Form text Atoms', () => {
  it('keeps typing local and submits one complete current draft', async () => {
    const dispatch = vi.fn()
    const canonicalState = { ...formSurface.state }
    render(renderNode(formSurface.tree, { state: canonicalState, dispatch }))

    const name = screen.getByRole('textbox', { name: 'Display name' }) as HTMLInputElement
    const bio = screen.getByRole('textbox', { name: 'Biography' }) as HTMLTextAreaElement
    name.focus()
    expect(document.activeElement).toBe(name)
    expect(name.style.outlineColor).not.toBe('')

    fireEvent.change(name, { target: { value: 'Grace' } })
    fireEvent.change(bio, { target: { value: 'Compiler pioneer' } })

    expect(name.value).toBe('Grace')
    expect(bio.value).toBe('Compiler pioneer')
    expect(canonicalState).toEqual(formSurface.state)
    expect(dispatch).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))

    await waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    expect(dispatch).toHaveBeenCalledWith(formSurface.tree, 'submit', {
      displayName: 'Grace',
      bio: 'Compiler pioneer',
    })
  })

  it('retains the draft after failure and permits an explicit retry', async () => {
    const dispatch = vi
      .fn<(node: AtomNode, actionName: string, value?: JsonValue) => Promise<void>>()
      .mockRejectedValueOnce(new Error('The Gateway could not save this Form.'))
      .mockResolvedValueOnce(undefined)
    render(renderNode(formSurface.tree, { state: formSurface.state, dispatch }))

    const name = screen.getByRole('textbox', { name: 'Display name' }) as HTMLInputElement
    fireEvent.change(name, { target: { value: 'Grace' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))

    expect((await screen.findByRole('alert')).textContent).toBe(
      'The Gateway could not save this Form.',
    )
    expect(name.value).toBe('Grace')
    expect(
      (screen.getByRole('button', { name: 'Save profile' }) as HTMLButtonElement).disabled,
    ).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))

    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(dispatch.mock.calls[0]?.[2]).toEqual(dispatch.mock.calls[1]?.[2])
    expect(name.value).toBe('Grace')
  })

  it('protects a dirty draft, then reconciles successful canonical updates', async () => {
    const submission = deferred()
    const dispatch = vi.fn(() => submission.promise)
    const view = render(renderNode(formSurface.tree, { state: formSurface.state, dispatch }))
    const name = screen.getByRole('textbox', { name: 'Display name' }) as HTMLInputElement

    fireEvent.change(name, { target: { value: 'Grace' } })
    view.rerender(
      renderNode(formSurface.tree, {
        state: { ...formSurface.state, displayName: 'Remote edit' },
        dispatch,
      }),
    )
    expect(name.value).toBe('Grace')

    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    expect(name.disabled).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Save profile' }) as HTMLButtonElement).disabled,
    ).toBe(true)

    view.rerender(
      renderNode(formSurface.tree, {
        state: { ...formSurface.state, displayName: 'Grace' },
        dispatch,
      }),
    )
    await act(async () => submission.resolve())
    await waitFor(() => expect(name.disabled).toBe(false))

    view.rerender(
      renderNode(formSurface.tree, {
        state: { ...formSurface.state, displayName: 'Katherine' },
        dispatch,
      }),
    )
    expect(name.value).toBe('Katherine')
  })
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}
