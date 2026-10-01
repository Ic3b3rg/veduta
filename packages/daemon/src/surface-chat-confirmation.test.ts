import { SurfaceSchema, type Surface } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { SurfaceChatConfirmation } from './surface-chat-confirmation.ts'

function surface(): Surface {
  return SurfaceSchema.parse({
    id: 'srf-plan',
    spaceId: 'spc-health',
    title: 'A complete plan',
    tree: { id: 'body', type: 'Text', props: { text: 'The saved content' } },
    state: {},
    freshness: { updatedAt: '2026-10-01T10:00:00Z', updatedBy: 'agent' },
  })
}

describe('SurfaceChatConfirmation', () => {
  it('confirms archival only through a delivered archival Event', () => {
    const canonical = surface()
    const confirmation = new SurfaceChatConfirmation(
      () => undefined,
      () => true,
    )
    confirmation.observe({
      type: 'tool-start',
      toolCallId: 'archive-1',
      toolName: 'archive_surface',
      input: {},
    })
    confirmation.observe({
      type: 'tool-result',
      toolCallId: 'archive-1',
      toolName: 'archive_surface',
      content: 'Archived',
      details: { surface: canonical },
      isError: false,
    })
    expect(confirmation.feedback()).toBe('Archived Surface “A complete plan”.')
  })
  it('confirms only a persisted Surface and describes its current presentation', () => {
    let canonical = surface()
    const confirmation = new SurfaceChatConfirmation((id) =>
      id === canonical.id ? canonical : undefined,
    )
    confirmation.observe({
      type: 'tool-start',
      toolCallId: 'call-1',
      toolName: 'create_surface',
      input: {},
    })
    confirmation.observe({
      type: 'tool-result',
      toolCallId: 'call-1',
      toolName: 'create_surface',
      content: 'Created an unsupported interactive dashboard',
      details: { surface: canonical },
      isError: false,
    })
    canonical = { ...canonical, presentation: 'full' }
    expect(confirmation.feedback()).toBe(
      'Saved Surface “A complete plan” (full presentation). Open the Surface to view its confirmed content.\nConfirmed content: The saved content',
    )
    expect(confirmation.feedback()).not.toContain('interactive dashboard')
  })

  it('refuses a success claim without an identical canonical write result', () => {
    const canonical = surface()
    const confirmation = new SurfaceChatConfirmation(() => canonical)
    confirmation.observe({
      type: 'tool-start',
      toolCallId: 'call-1',
      toolName: 'patch_tree',
      input: {},
    })
    confirmation.observe({
      type: 'tool-result',
      toolCallId: 'call-1',
      toolName: 'patch_tree',
      content: 'Saved all controls',
      details: { surface: { ...canonical, title: 'Unsaved controls' } },
      isError: false,
    })
    expect(confirmation.feedback()).toBe('No Surface change is confirmed.')
  })

  it('preserves a confirmed write across provider retries while reporting a later failed write', () => {
    const canonical = surface()
    const confirmation = new SurfaceChatConfirmation(() => canonical)
    confirmation.observe({
      type: 'tool-start',
      toolCallId: 'call-1',
      toolName: 'create_surface',
      input: {},
    })
    confirmation.observe({
      type: 'tool-result',
      toolCallId: 'call-1',
      toolName: 'create_surface',
      content: 'Created',
      details: { surface: canonical },
      isError: false,
    })
    confirmation.observe({
      type: 'tool-start',
      toolCallId: 'call-2',
      toolName: 'patch_tree',
      input: {},
    })
    confirmation.observe({
      type: 'tool-result',
      toolCallId: 'call-2',
      toolName: 'patch_tree',
      content: 'Invalid Button props',
      details: undefined,
      isError: true,
    })
    expect(confirmation.feedback()).toContain('Saved Surface “A complete plan”')
    expect(confirmation.feedback()).toContain(
      'A Surface change was not saved: Invalid Button props',
    )
    expect(confirmation.feedback()).not.toContain('all controls')
  })

  it('does not override ordinary conversation or turn proposals into committed changes', () => {
    const confirmation = new SurfaceChatConfirmation(() => surface())
    expect(confirmation.feedback()).toBeUndefined()
    expect(
      confirmation.observe({
        type: 'tool-start',
        toolCallId: 'read-1',
        toolName: 'read_surface',
        input: {},
      }),
    ).toBe(false)
    confirmation.observe({
      type: 'tool-start',
      toolCallId: 'call-1',
      toolName: 'patch_tree',
      input: {},
    })
    confirmation.observe({
      type: 'tool-result',
      toolCallId: 'call-1',
      toolName: 'patch_tree',
      content: 'proposed',
      details: { proposalId: 1 },
      isError: false,
    })
    expect(confirmation.feedback()).toBe('A Surface change is proposed and awaits your decision.')
  })

  it.each([true, false])(
    'only a canonical retry of the same target resolves a failed Surface write (same target: %s)',
    (sameTarget) => {
      const canonical = surface()
      const confirmation = new SurfaceChatConfirmation(() => canonical)
      confirmation.observe({
        type: 'tool-start',
        toolCallId: 'failed-write',
        toolName: 'patch_state',
        input: {
          surfaceId: canonical.id,
          operations: [{ target: 'state', op: 'replace', path: '/result', value: 42 }],
        },
      })
      confirmation.observe({
        type: 'tool-result',
        toolCallId: 'failed-write',
        toolName: 'patch_state',
        content: 'Invalid bound value',
        details: undefined,
        isError: true,
      })
      confirmation.observe({
        type: 'tool-start',
        toolCallId: 'corrected-write',
        toolName: 'patch_state',
        input: {
          surfaceId: sameTarget ? canonical.id : 'srf-unrelated',
          operations: [{ target: 'state', op: 'replace', path: '/result', value: 'After' }],
        },
      })
      confirmation.observe({
        type: 'tool-result',
        toolCallId: 'corrected-write',
        toolName: 'patch_state',
        content: 'Saved',
        details: { surface: canonical },
        isError: false,
      })
      if (sameTarget) {
        expect(confirmation.failure()).toBeUndefined()
        expect(confirmation.feedback()).not.toContain('Invalid bound value')
      } else {
        expect(confirmation.failure()).toContain('Invalid bound value')
        expect(confirmation.feedback()).toContain('Invalid bound value')
      }
    },
  )

  it('an unrelated accepted write on the same Surface does not correct a failed mutation', () => {
    const canonical = surface()
    const confirmation = new SurfaceChatConfirmation(() => canonical)
    confirmation.observe({
      type: 'tool-start',
      toolCallId: 'failed-records',
      toolName: 'patch_state',
      input: {
        surfaceId: canonical.id,
        operations: [{ target: 'state', op: 'replace', path: '/records', value: 42 }],
      },
    })
    confirmation.observe({
      type: 'tool-result',
      toolCallId: 'failed-records',
      toolName: 'patch_state',
      content: 'Invalid records',
      details: undefined,
      isError: true,
    })
    confirmation.observe({
      type: 'tool-start',
      toolCallId: 'saved-result',
      toolName: 'patch_state',
      input: {
        surfaceId: canonical.id,
        operations: [{ target: 'state', op: 'replace', path: '/result', value: 'After' }],
      },
    })
    confirmation.observe({
      type: 'tool-result',
      toolCallId: 'saved-result',
      toolName: 'patch_state',
      content: 'Saved',
      details: { surface: canonical },
      isError: false,
    })
    expect(confirmation.failure()).toContain('Invalid records')
    expect(confirmation.feedback()).toContain('Invalid records')
  })
})
