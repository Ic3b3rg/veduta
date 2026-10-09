// @vitest-environment jsdom
import { fromPartial } from '@total-typescript/shoehorn'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ProductReferencePage } from './product-reference.tsx'
import { AtomTypeSchema, type AtomNode } from '@veduta/protocol'
import { referenceCatalog } from './product-reference-fixtures.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('includes every supported Atom in the rendered inventory fixture', () => {
  const types = new Set<string>()
  function collect(node: AtomNode) {
    types.add(node.type)
    node.children?.forEach(collect)
  }
  collect(referenceCatalog.tree)
  expect([...types].sort()).toEqual([...AtomTypeSchema.options].sort())
})

it('renders the real product regions without network access and keeps fixtures stable over time', () => {
  vi.stubGlobal('matchMedia', () =>
    fromPartial<MediaQueryList>({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  )
  const fetch = vi.fn(() => Promise.reject(new Error('The reference must stay offline')))
  vi.stubGlobal('fetch', fetch)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2030, 0, 1))
  const view = render(<ProductReferencePage />)
  for (const name of [
    'Home',
    'Space detail',
    'Surface chrome',
    'Chat',
    'Pending decisions',
    'Onboarding',
    'Model connections',
    'Atom catalog',
    'Shared recipes',
  ]) {
    expect(screen.getByRole('region', { name: `${name} reference` })).toBeDefined()
  }
  expect(screen.getAllByText(/10m ago/).length).toBeGreaterThan(0)
  expect(screen.getByRole('status', { name: 'Next recommendation loading' })).toBeDefined()
  const before = view.container.textContent
  clock.mockReturnValue(Date.UTC(2040, 0, 1))
  view.rerender(<ProductReferencePage />)
  expect(view.container.textContent).toBe(before)
  expect(fetch).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('combobox', { name: 'Representative state' }), {
    target: { value: 'offline' },
  })
  expect(screen.getByText('Waiting for connection')).toBeDefined()
  expect(fetch).not.toHaveBeenCalled()
  vi.restoreAllMocks()
})
