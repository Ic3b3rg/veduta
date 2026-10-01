import { describe, expect, it } from 'vitest'
import { AtomNodeSchema } from './index.ts'

describe('layout, media, and motion contracts', () => {
  const text = { id: 'copy', type: 'Text', props: { text: 'Canonical content' } }
  const candidates = [
    { type: 'Box', props: { padding: 'lg', gap: 'sm' }, children: [text] },
    { type: 'Row', props: { gap: 'md', align: 'stretch', wrap: true }, children: [text] },
    { type: 'Col', props: { gap: 'xs' }, children: [text] },
    { type: 'Spacer', props: { size: 'xl' } },
    { type: 'Divider', props: {} },
    { type: 'Image', props: { src: '/icons/icon-192.svg', alt: 'Veduta mark', loading: 'lazy' } },
    { type: 'Icon', props: { name: 'check', label: 'Ready', tone: 'success' } },
    { type: 'Transition', props: { visible: false }, children: [text] },
    { type: 'Pending', props: { variant: 'text', label: 'Upcoming content' } },
  ]

  it('accepts a non-trivial composition with only supported layout and media semantics', () => {
    expect(
      AtomNodeSchema.safeParse({
        id: 'root',
        type: 'Box',
        children: candidates.map((candidate, index) => ({
          id: `atom-${index}`,
          ...candidate,
          ...(candidate.children
            ? { children: candidate.children.map((child) => ({ ...child, id: `copy-${index}` })) }
            : {}),
        })),
      }).success,
    ).toBe(true)
    expect(
      AtomNodeSchema.safeParse({
        id: 'decorative',
        type: 'Icon',
        props: { name: 'dot', decorative: true },
      }).success,
    ).toBe(true)
    expect(
      AtomNodeSchema.safeParse({
        id: 'unavailable',
        type: 'Image',
        props: { alt: 'Preview unavailable' },
      }).success,
    ).toBe(true)
  })

  it('rejects every unsupported prop, binding, or action before it can be ignored', () => {
    for (const candidate of candidates) {
      const node = { id: candidate.type, ...candidate }
      expect(
        AtomNodeSchema.safeParse({
          ...node,
          props: { ...candidate.props, style: { color: 'red' } },
        }).success,
      ).toBe(false)
      expect(AtomNodeSchema.safeParse({ ...node, binding: 'ignored' }).success).toBe(false)
      expect(AtomNodeSchema.safeParse({ ...node, actions: [{ name: 'ignored' }] }).success).toBe(
        false,
      )
    }
  })

  it('rejects leaf children, raw layout values, missing alternatives, and invalid sources', () => {
    for (const candidate of candidates.filter((candidate) => !candidate.children)) {
      expect(AtomNodeSchema.safeParse({ id: 'leaf', ...candidate, children: [text] }).success).toBe(
        false,
      )
    }
    for (const candidate of [
      { type: 'Box', props: { gap: 10 } },
      { type: 'Box', props: { padding: '10px' } },
      { type: 'Row', props: { align: 'space-between' } },
      { type: 'Row', props: { wrap: 'true' } },
      { type: 'Col', props: { width: '100%' } },
      { type: 'Spacer', props: { size: -1 } },
      { type: 'Divider', props: { orientation: 'diagonal' } },
      { type: 'Transition', children: [] },
      { type: 'Transition', props: { visible: 'hidden' }, children: [text] },
      { type: 'Image', props: { src: 'https://example.com/photo.png' } },
      { type: 'Image', props: { src: '/photo.png', alt: '' } },
      { type: 'Image', props: { src: 'javascript:alert(1)', alt: 'Photo' } },
      { type: 'Image', props: { src: 'data:image/svg+xml,<svg onload="alert(1)">', alt: 'Photo' } },
      { type: 'Image', props: { src: '//unreviewed.example/photo.png', alt: 'Photo' } },
      { type: 'Image', props: { src: 'https://user:secret@example.com/photo.png', alt: 'Photo' } },
      { type: 'Image', props: { src: '/photo.png', alt: 'Photo', loading: 'soon' } },
      { type: 'Icon', props: { name: 'unknown', label: 'Photo' } },
      { type: 'Icon', props: { name: 'check' } },
      { type: 'Icon', props: { name: 'check', decorative: true, label: 'Ignored label' } },
    ])
      expect(AtomNodeSchema.safeParse({ id: 'invalid', ...candidate }).success).toBe(false)
  })

  it('rejects unknown catalog types on the authoring boundary', () => {
    expect(
      AtomNodeSchema.safeParse({ id: 'future-atom', type: 'FutureMedia', props: {} }).success,
    ).toBe(false)
  })
})
