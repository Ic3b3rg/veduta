// @vitest-environment jsdom
import { AtomNodeSchema, formSetPlan, type AtomNode } from '@veduta/protocol'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderNode } from './render.tsx'
import { catalogTokens } from './design-system.ts'

afterEach(cleanup)

describe('layout, media and fallback contracts', () => {
  it('applies supported spacing and layout props in both themes', () => {
    const tree = AtomNodeSchema.parse({
      id: 'box',
      type: 'Box',
      props: { gap: 'none', padding: 'lg' },
      children: [
        {
          id: 'row',
          type: 'Row',
          props: { gap: 'xs', align: 'end', wrap: false },
          children: [
            {
              id: 'col',
              type: 'Col',
              props: { gap: 'xl' },
              children: [{ id: 'copy', type: 'Text', props: { text: 'Layout content' } }],
            },
          ],
        },
        { id: 'spacer', type: 'Spacer', props: { size: 'sm' } },
        { id: 'divider', type: 'Divider' },
      ],
    })
    for (const theme of ['light', 'dark'] as const) {
      const view = render(renderNode(tree, { state: {}, theme, dispatch: vi.fn() }))
      const atom = (id: string) =>
        view.container.querySelector<HTMLElement>(`[data-veduta-atom-id="${id}"]`)!
      expect(Number.parseFloat(atom('box').style.gap)).toBe(0)
      expect(atom('box').style.padding).toBe(`${catalogTokens[theme].space.lg}px`)
      expect(atom('row').style.gap).toBe(`${catalogTokens[theme].space.xs}px`)
      expect(atom('row').style.alignItems).toBe('end')
      expect(atom('row').style.flexWrap).toBe('nowrap')
      expect(atom('col').style.gap).toBe(`${catalogTokens[theme].space.xl}px`)
      expect(atom('spacer').style.minHeight).toBe(`${catalogTokens[theme].space.sm}px`)
      expect(screen.getByRole('separator')).toBeDefined()
      view.unmount()
    }
  })
  it('rejects invalid known props and state before rendering interactive descendants', () => {
    const invalid: AtomNode = {
      id: 'invalid-root',
      type: 'Box',
      props: { padding: '120px' },
      children: [
        {
          id: 'action',
          type: 'Button',
          props: { label: 'Save' },
          actions: [{ name: 'click', path: 'agent', payload: {} }],
        },
      ],
    }
    const first = render(renderNode(invalid, { state: {}, dispatch: vi.fn() }))
    expect(screen.getByRole('alert').textContent).toContain('Surface content unavailable')
    expect(screen.queryByRole('button')).toBeNull()
    first.unmount()
    const bound = AtomNodeSchema.parse({
      id: 'amount',
      type: 'Stat',
      binding: 'amount',
      props: { label: 'Amount' },
    })
    render(renderNode(bound, { state: { amount: { guessed: 4 } }, dispatch: vi.fn() }))
    expect(screen.getByRole('alert').textContent).toContain('amount')
    expect(screen.queryByText('[object Object]')).toBeNull()
  })

  it('validates a complete Form once and preserves its ancestor context', () => {
    const form = AtomNodeSchema.parse({
      id: 'details',
      type: 'Form',
      props: { label: 'Details', submitLabel: 'Save' },
      actions: [
        { name: 'submit', path: 'fast', revision: 'acr-name-form', plan: formSetPlan(['name']) },
      ],
      children: [{ id: 'name-input', type: 'Input', props: { label: 'Name' }, binding: 'name' }],
    })
    const view = render(renderNode(form, { state: { name: 'Ada' }, dispatch: vi.fn() }))
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
    view.rerender(renderNode(form.children![0]!, { state: { name: 'Ada' }, dispatch: vi.fn() }))
    expect(screen.getByRole('alert').textContent).toContain('must belong to a Form')
  })

  it('shows unknown version-skew identity, its known children and siblings safely', () => {
    for (const type of ['FuturePanel', 'constructor', 'toString', '__proto__']) {
      const tree: AtomNode = JSON.parse(
        JSON.stringify({
          id: 'root',
          type: 'Box',
          children: [
            {
              id: 'future-panel',
              type,
              props: { ignoredByOlderCatalog: true },
              children: [{ id: 'inside', type: 'Text', props: { text: 'Preserved child' } }],
            },
            { id: 'sibling', type: 'Text', props: { text: 'Preserved sibling' } },
          ],
        }),
      )
      const view = render(renderNode(tree, { state: {}, dispatch: vi.fn() }))
      expect(screen.getByTestId('unknown-atom').textContent).toContain(type)
      expect(screen.getByTestId('unknown-atom').textContent).toContain('future-panel')
      expect(screen.getByText('Preserved child')).toBeDefined()
      expect(screen.getByText('Preserved sibling')).toBeDefined()
      view.unmount()
    }
  })

  it('does not interpret newer unknown action metadata while known child bindings update', () => {
    const tree: AtomNode = JSON.parse(
      '{"id":"future","type":"FuturePanel","actions":"future action syntax","binding":{"future":"binding"},"children":[{"id":"copy","type":"Text","binding":"copy"}]}',
    )
    const dispatch = vi.fn()
    const view = render(renderNode(tree, { state: { copy: 'Before' }, dispatch }))
    expect(screen.getByText('Before')).toBeDefined()
    view.rerender(renderNode(tree, { state: { copy: 'After' }, dispatch }))
    expect(screen.getByText('After')).toBeDefined()
    expect(screen.getByTestId('unknown-atom').textContent).toContain('FuturePanel')
  })

  it('makes image loading and failure visible and keeps canonical surrounding content', () => {
    const image = AtomNodeSchema.parse({
      id: 'image',
      type: 'Image',
      props: { src: '/preview.png', alt: 'Route preview', loading: 'eager' },
    })
    const view = render(renderNode(image, { state: {}, dispatch: vi.fn() }))
    const element = screen.getByRole('img', { name: 'Route preview' })
    expect(element.getAttribute('loading')).toBe('eager')
    expect(screen.getByText('Route preview loading')).toBeDefined()
    fireEvent.load(element)
    expect(screen.queryByText('Route preview loading')).toBeNull()
    fireEvent.error(element)
    expect(screen.getByText('Route preview unavailable')).toBeDefined()
    expect(screen.getByRole('img', { name: 'Route preview unavailable' })).toBeDefined()
    view.rerender(
      renderNode(
        AtomNodeSchema.parse({ id: 'image', type: 'Image', props: { alt: 'Missing preview' } }),
        { state: {}, dispatch: vi.fn() },
      ),
    )
    expect(screen.getByText('Missing preview unavailable')).toBeDefined()
  })

  it('renders labelled and decorative icons and keeps Transition content visible', () => {
    const tree = AtomNodeSchema.parse({
      id: 'root',
      type: 'Col',
      children: [
        { id: 'labelled', type: 'Icon', props: { name: 'check', label: 'Complete' } },
        { id: 'decoration', type: 'Icon', props: { name: 'dot', decorative: true } },
        {
          id: 'transition',
          type: 'Transition',
          props: { visible: false },
          children: [{ id: 'copy', type: 'Text', props: { text: 'Canonical content' } }],
        },
      ],
    })
    const view = render(renderNode(tree, { state: {}, theme: 'dark', dispatch: vi.fn() }))
    expect(screen.getByRole('img', { name: 'Complete' })).toBeDefined()
    expect(
      view.container
        .querySelector('[data-veduta-atom-id="decoration"]')
        ?.getAttribute('aria-hidden'),
    ).toBe('true')
    expect(screen.getByText('Canonical content')).toBeDefined()
    expect(view.container.querySelector('[data-veduta-atom-id="transition"]')?.className).toContain(
      'motion-reduce:transition-none',
    )
  })
})
