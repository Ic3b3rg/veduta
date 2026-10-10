import { Button } from '@veduta/catalog/ui/button'
import { Textarea } from '@veduta/catalog/ui/textarea'
import type { SpaceSettings, SpaceSettingsCommand } from '@veduta/protocol'
import { useState } from 'react'

export type SaveSpaceSettings = (command: SpaceSettingsCommand) => Promise<boolean>

export function SpaceMemorySettings({
  settings,
  save,
  busy,
}: {
  settings: SpaceSettings
  save: SaveSpaceSettings
  busy: boolean
}) {
  const [editingFact, setEditingFact] = useState<string | null>(null)
  const [factText, setFactText] = useState('')
  const [instructions, setInstructions] = useState(settings.instructions ?? '')
  const [instructionsBase, setInstructionsBase] = useState(settings.instructions ?? '')
  return (
    <div className="space-settings-forms">
      <section aria-label="Facts">
        <h3>What Veduta knows here</h3>
        <p>Facts belong to {settings.space.name}. Changes keep their previous history.</p>
        {settings.facts
          .filter((fact) => fact.status === 'active')
          .map((fact) => (
            <div className="space-fact-row" key={fact.text}>
              <p>{fact.text}</p>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setEditingFact(fact.text)
                  setFactText(fact.text)
                }}
              >
                Edit
              </Button>
            </div>
          ))}
        {!settings.facts.some((fact) => fact.status === 'active') && <p>No facts saved yet.</p>}
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void save({
              action: 'fact',
              text: factText,
              ...(editingFact === null ? {} : { supersedes: editingFact }),
            }).then((saved) => {
              if (saved) {
                setFactText('')
                setEditingFact(null)
              }
            })
          }}
        >
          <label>
            {editingFact === null ? 'Add a fact' : 'Edit fact'}
            <Textarea
              value={factText}
              onChange={(event) => setFactText(event.target.value)}
              disabled={busy}
              required
            />
          </label>
          <div className="space-settings-actions">
            <Button disabled={busy || !factText.trim()} type="submit">
              Save fact
            </Button>
            {editingFact !== null && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setEditingFact(null)
                  setFactText('')
                }}
              >
                Cancel edit
              </Button>
            )}
          </div>
        </form>
        {settings.facts.some((fact) => fact.status !== 'active') && (
          <details>
            <summary>Previous and dormant facts</summary>
            {settings.facts
              .filter((fact) => fact.status !== 'active')
              .map((fact, index) => (
                <p key={`${index}:${fact.text}`}>
                  {fact.text} <small>({fact.status})</small>
                </p>
              ))}
          </details>
        )}
      </section>
      <section aria-label="Space instructions">
        <h3>Instructions for this Space</h3>
        <p>Describe how Veduta should work in {settings.space.name}.</p>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void save({
              action: 'instructions',
              text: instructions,
              expectedText: instructionsBase,
            }).then((saved) => {
              if (saved) setInstructionsBase(instructions)
            })
          }}
        >
          <label>
            Instructions
            <Textarea
              rows={6}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              disabled={busy}
              maxLength={16000}
            />
          </label>
          <Button type="submit" disabled={busy || instructions === instructionsBase}>
            Save instructions
          </Button>
        </form>
      </section>
    </div>
  )
}
