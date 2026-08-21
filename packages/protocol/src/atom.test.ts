import { describe, expect, it } from 'vitest'
import {
  AtomNodeSchema,
  MAX_PENDING_SLOT_TIMEOUT_MS,
  MIN_PENDING_SLOT_TIMEOUT_MS,
  PendingAtomPropsSchema,
  pendingSlotVariants,
} from './index.ts'

describe('Pending Atom protocol', () => {
  it.each([
    { variant: 'text', lines: 3 },
    { variant: 'list', rows: 4 },
    { variant: 'image' },
    { variant: 'stat' },
    { variant: 'chart' },
  ])('accepts a schema-validated $variant footprint', (props) => {
    expect(
      AtomNodeSchema.parse({
        id: `pending-${props.variant}`,
        type: 'Pending',
        props: { ...props, label: `${props.variant} content`, timeoutMs: 30_000 },
      }),
    ).toMatchObject({ type: 'Pending', props })
  })

  it('publishes the complete footprint catalog and bounded timeout contract', () => {
    expect(pendingSlotVariants).toEqual(['text', 'list', 'image', 'stat', 'chart'])
    expect(MIN_PENDING_SLOT_TIMEOUT_MS).toBe(1_000)
    expect(MAX_PENDING_SLOT_TIMEOUT_MS).toBe(120_000)
  })

  it.each([
    undefined,
    {},
    { variant: 'video' },
    { variant: 'text', lines: 0 },
    { variant: 'text', lines: 7 },
    { variant: 'list', rows: 0 },
    { variant: 'list', rows: 9 },
    { variant: 'stat', rows: 3 },
    { variant: 'chart', timeoutMs: MIN_PENDING_SLOT_TIMEOUT_MS - 1 },
    { variant: 'chart', timeoutMs: MAX_PENDING_SLOT_TIMEOUT_MS + 1 },
  ])('rejects malformed Pending props %#', (props) => {
    expect(PendingAtomPropsSchema.safeParse(props).success).toBe(false)
    expect(
      AtomNodeSchema.safeParse({ id: 'pending-malformed', type: 'Pending', props }).success,
    ).toBe(false)
  })

  it.each([
    { binding: 'pending' },
    { actions: [{ name: 'fill' }] },
    { children: [{ id: 'nested', type: 'Text', props: { text: 'Not a leaf' } }] },
  ])('rejects Pending nodes that are not leaves %#', (extra) => {
    expect(
      AtomNodeSchema.safeParse({
        id: 'pending-not-a-leaf',
        type: 'Pending',
        props: { variant: 'text' },
        ...extra,
      }).success,
    ).toBe(false)
  })

  it('keeps existing Atom props backward compatible', () => {
    expect(
      AtomNodeSchema.parse({
        id: 'existing-chart',
        type: 'Chart',
        props: { variant: 'future-chart-style', customOption: true },
      }),
    ).toMatchObject({
      id: 'existing-chart',
      type: 'Chart',
      props: { variant: 'future-chart-style', customOption: true },
    })
  })
})
