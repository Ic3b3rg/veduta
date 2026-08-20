import {
  catalogMotionShowcaseSurface,
  renderNode,
  tokensFor,
  type CatalogTheme,
  type SurfaceUpdateFeedback,
} from '@veduta/catalog'
import { SurfaceSchema, type Surface } from '@veduta/protocol'
import { useState } from 'react'
import './styles/motion-showcase.css'

export function MotionShowcasePage() {
  const [theme, setTheme] = useState<CatalogTheme>('light')
  const [entranceKey, setEntranceKey] = useState(0)
  const [updateKey, setUpdateKey] = useState(0)
  const updatedSurface = SurfaceSchema.parse({
    ...catalogMotionShowcaseSurface,
    state: {
      ...catalogMotionShowcaseSurface.state,
      status: updateKey % 2 === 0 ? 'Waiting' : 'Ready',
    },
  })

  return (
    <main className="motion-showcase-page">
      <header className="motion-showcase-header">
        <div>
          <p className="motion-showcase-kicker">Contributor showcase</p>
          <h1>Surface motion</h1>
          <p>Replay the entrance or apply a local update without starting the Veduta daemon.</p>
        </div>
        <fieldset className="motion-showcase-theme">
          <legend>Theme</legend>
          {(['light', 'dark'] as const).map((option) => (
            <label key={option}>
              <input
                type="radio"
                name="motion-showcase-theme"
                checked={theme === option}
                onChange={() => setTheme(option)}
              />
              {option === 'light' ? 'Light' : 'Dark'}
            </label>
          ))}
        </fieldset>
      </header>

      <div className="motion-showcase-grid">
        <section className="motion-showcase-entry" aria-labelledby="entrance-title">
          <div className="motion-showcase-entry-heading">
            <div>
              <h2 id="entrance-title">Staggered entrance</h2>
              <p>Every newly mounted sibling follows the Surface motion tokens.</p>
            </div>
            <button type="button" onClick={() => setEntranceKey((current) => current + 1)}>
              Replay entrance
            </button>
          </div>
          <MotionPreview key={entranceKey} surface={catalogMotionShowcaseSurface} theme={theme} />
        </section>

        <section className="motion-showcase-entry" aria-labelledby="update-title">
          <div className="motion-showcase-entry-heading">
            <div>
              <h2 id="update-title">Region-scoped update</h2>
              <p>The Status Atom receives feedback while its sibling stays still.</p>
            </div>
            <button type="button" onClick={() => setUpdateKey((current) => current + 1)}>
              Apply region update
            </button>
          </div>
          <MotionPreview
            surface={updatedSurface}
            theme={theme}
            update={
              updateKey > 0
                ? { key: `showcase-${updateKey}`, atomIds: ['motion-status'] }
                : undefined
            }
          />
        </section>
      </div>
    </main>
  )
}

function MotionPreview({
  surface,
  theme,
  update,
}: {
  surface: Surface
  theme: CatalogTheme
  update?: SurfaceUpdateFeedback | undefined
}) {
  const tokens = tokensFor(theme)
  return (
    <div
      className="motion-showcase-preview"
      style={{
        background: tokens.color.surfaceMuted,
        borderColor: tokens.color.border,
      }}
    >
      {renderNode(surface.tree, {
        state: surface.state,
        theme,
        dispatch: () => undefined,
        ...(update ? { motion: { update } } : {}),
      })}
    </div>
  )
}
