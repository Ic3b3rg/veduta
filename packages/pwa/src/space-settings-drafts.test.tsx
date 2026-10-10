// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { fromPartial } from '@total-typescript/shoehorn'
import type { SettingsAutomation, SpaceSettings, SpaceSettingsList } from '@veduta/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { SpaceMemorySettings, type SaveSpaceSettings } from './space-memory-settings.tsx'
import { AutomationSettingsEditor, ReflectionSettingsForm } from './space-automation-settings.tsx'

afterEach(cleanup)

const settings = (instructions: string) =>
  fromPartial<SpaceSettings>({
    space: { id: 'spc-health', name: 'Health' },
    instructions,
    facts: [],
    automations: [],
    surfaces: [],
  })

it('keeps an instruction draft and its compare-and-set baseline when canonical text changes', async () => {
  const save = vi.fn<SaveSpaceSettings>().mockResolvedValue(undefined)
  const view = render(
    <SpaceMemorySettings settings={settings('Original')} save={save} busy={false} />,
  )
  fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'My pending edit' } })
  view.rerender(
    <SpaceMemorySettings settings={settings('Another device edit')} save={save} busy={false} />,
  )
  expect(screen.getByLabelText<HTMLTextAreaElement>('Instructions').value).toBe('My pending edit')
  fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      action: 'instructions',
      text: 'My pending edit',
      expectedText: 'Original',
    }),
  )
  expect(screen.getByLabelText<HTMLTextAreaElement>('Instructions').value).toBe('My pending edit')
})

it('uses canonical saved instructions as the text and baseline for the next edit', async () => {
  const save = vi.fn<SaveSpaceSettings>().mockResolvedValue(settings('Normalized'))
  render(<SpaceMemorySettings settings={settings('Original')} save={save} busy={false} />)
  fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: '  Normalized  ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }))
  await waitFor(() =>
    expect(screen.getByLabelText<HTMLTextAreaElement>('Instructions').value).toBe('Normalized'),
  )
  fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'Next edit' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save instructions' }))
  await waitFor(() =>
    expect(save).toHaveBeenLastCalledWith({
      action: 'instructions',
      text: 'Next edit',
      expectedText: 'Normalized',
    }),
  )
})

it('preserves a Reflection draft and its original revision when another device changes settings', async () => {
  const reflection = { enabled: true, time: '03:00', timezone: 'UTC', revision: 'before' }
  const save = vi
    .fn<
      (value: {
        enabled: boolean
        time: string
        expectedRevision: string
      }) => Promise<SpaceSettingsList | undefined>
    >()
    .mockResolvedValue(undefined)
  const view = render(<ReflectionSettingsForm reflection={reflection} save={save} busy={false} />)
  fireEvent.change(screen.getByLabelText('Daily time'), { target: { value: '04:00' } })
  view.rerender(
    <ReflectionSettingsForm
      reflection={{ ...reflection, time: '05:00', revision: 'remote' }}
      save={save}
      busy={false}
    />,
  )
  expect(screen.getByLabelText<HTMLInputElement>('Daily time').value).toBe('04:00')
  fireEvent.click(screen.getByRole('button', { name: 'Save Reflection settings' }))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({ enabled: true, time: '04:00', expectedRevision: 'before' }),
  )
})

it('preserves an Automation draft and its original revision through live updates', async () => {
  const automation: SettingsAutomation = {
    id: 1,
    kind: 'job',
    description: 'Original',
    enabled: true,
    status: 'armed',
    cron: '0 9 * * *',
    timezone: 'UTC',
    managed: false,
    revision: 'before',
    history: [],
  }
  const save = vi.fn<SaveSpaceSettings>().mockResolvedValue(undefined)
  const view = render(
    <AutomationSettingsEditor
      automation={automation}
      spaceId="spc-health"
      save={save}
      busy={false}
    />,
  )
  fireEvent.click(screen.getByText('Edit Automation'))
  fireEvent.change(screen.getByLabelText('Instructions'), {
    target: { value: 'My pending Automation edit' },
  })
  view.rerender(
    <AutomationSettingsEditor
      automation={{ ...automation, description: 'Another device edit', revision: 'remote' }}
      spaceId="spc-health"
      save={save}
      busy={false}
    />,
  )
  expect(screen.getByLabelText<HTMLTextAreaElement>('Instructions').value).toBe(
    'My pending Automation edit',
  )
  fireEvent.click(screen.getByRole('button', { name: 'Save Automation' }))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      action: 'automation',
      automationId: 1,
      change: { description: 'My pending Automation edit', expectedRevision: 'before' },
    }),
  )
})

it('composes an Automation instant with the shared calendar and rejects partial drafts', async () => {
  const automation: SettingsAutomation = {
    id: 8,
    kind: 'timer',
    description: 'Reminder',
    enabled: true,
    status: 'armed',
    fireAt: '2030-07-08T09:00:00.000Z',
    timezone: 'UTC',
    managed: false,
    revision: 'before',
    history: [],
  }
  const save = vi.fn<SaveSpaceSettings>().mockResolvedValue(undefined)
  render(
    <AutomationSettingsEditor
      automation={automation}
      spaceId="spc-health"
      save={save}
      busy={false}
    />,
  )
  fireEvent.click(screen.getByText('Edit Automation'))
  fireEvent.change(screen.getByLabelText('Time'), { target: { value: '09:30' } })
  expect(screen.getByRole('button', { name: 'Save Automation' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('status').textContent).toContain('Choose a valid date and time')
  fireEvent.click(screen.getByRole('button', { name: 'Date' }))
  const grid = await screen.findByRole('grid', {}, { timeout: 5000 })
  const offered = grid.querySelector<HTMLButtonElement>('button:not([disabled])')!
  const accessibleDate = offered.getAttribute('aria-label')!
  fireEvent.click(offered)
  expect(save).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Save Automation' })).toHaveProperty('disabled', false)
  fireEvent.click(screen.getByRole('button', { name: 'Save Automation' }))
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  const mutation = save.mock.calls[0]![0]
  expect(mutation).toMatchObject({
    action: 'automation',
    automationId: 8,
    change: { expectedRevision: 'before' },
  })
  if (mutation.action !== 'automation' || !mutation.change.fireAt)
    throw new Error('Missing instant')
  const stored = new Date(mutation.change.fireAt)
  expect([stored.getHours(), stored.getMinutes()]).toEqual([9, 30])
  expect(accessibleDate).toContain(String(stored.getFullYear()))
  expect(screen.getByLabelText('Time')).toHaveProperty('value', '09:30')
  fireEvent.click(screen.getByRole('button', { name: 'Keep current time' }))
  expect(screen.getByRole('button', { name: 'Save Automation' })).toHaveProperty('disabled', true)
})
