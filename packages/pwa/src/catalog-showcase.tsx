import { catalogShowcaseSurface, renderNode } from '@veduta/catalog'
import type { KnownRenderableAtomNode, JsonObject, JsonValue } from '@veduta/protocol'
import { useState } from 'react'
import { useCatalogTheme } from './theme.ts'
import './styles/motion-showcase.css'

export function CatalogShowcasePage() {
  const theme = useCatalogTheme()
  const [state, setState] = useState<JsonObject>(catalogShowcaseSurface.state)

  function dispatch(node: KnownRenderableAtomNode, actionName: string, value?: JsonValue): void {
    const action = node.actions?.find((candidate) => candidate.name === actionName)
    if (action?.path !== 'fast') return
    const stateKey = action.stateKey
    if (stateKey !== undefined && value !== undefined) {
      setState((current) => ({ ...current, [stateKey]: value }))
    }
  }

  return (
    <main className="motion-showcase-page">
      <header className="motion-showcase-header">
        <div>
          <p className="motion-showcase-kicker">Contributor showcase</p>
          <h1>Atom catalog</h1>
          <p>Explore the validated catalog with local sample state.</p>
        </div>
      </header>
      <section className="motion-showcase-entry">
        {renderNode(catalogShowcaseSurface.tree, { state, theme, dispatch })}
      </section>
    </main>
  )
}
