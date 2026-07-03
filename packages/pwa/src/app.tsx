import { renderNode } from '@veduta/catalog'
import {
  ChatMessageSchema,
  type AtomNode,
  type ChatMessage,
  type JsonValue,
  type Surface,
} from '@veduta/protocol'
import { useEffect, useRef, useState } from 'react'
import { fetchSpaces, freshnessLabel, invokeFastAction, type SpaceWithSurfaces } from './api.ts'

export function App() {
  const [spaces, setSpaces] = useState<SpaceWithSurfaces[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchSpaces()
      .then(setSpaces)
      .catch((e: Error) => setError(e.message))
  }, [])

  const patchSurface = (updated: Surface) => {
    setSpaces((prev) =>
      prev.map((space) => ({
        ...space,
        surfaces: space.surfaces.map((s) => (s.id === updated.id ? updated : s)),
      })),
    )
  }

  return (
    <div
      style={{
        fontFamily: 'system-ui, sans-serif',
        maxWidth: 720,
        margin: '0 auto',
        padding: 16,
        paddingBottom: 96,
      }}
    >
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Veduta</h1>
        <small style={{ color: '#777' }}>dev profile — mock provider, seed data</small>
      </header>
      {error && <p style={{ color: '#c00' }}>{error}</p>}
      {spaces.map((space) => (
        <section key={space.id} style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 14, textTransform: 'uppercase', color: '#999', letterSpacing: 1 }}>
            {space.name}
          </h2>
          <div style={{ display: 'grid', gap: 12 }}>
            {space.surfaces.map((surface) => (
              <SurfaceCard
                key={surface.id}
                surface={surface}
                onPatched={patchSurface}
                onError={setError}
              />
            ))}
          </div>
        </section>
      ))}
      <ChatBar />
    </div>
  )
}

function SurfaceCard({
  surface,
  onPatched,
  onError,
}: {
  surface: Surface
  onPatched: (s: Surface) => void
  onError: (message: string) => void
}) {
  const dispatch = (node: AtomNode, actionName: string, value?: JsonValue) => {
    const action = node.actions?.find((a) => a.name === actionName)
    if (action?.path === 'fast') {
      if (value === undefined) {
        onError(
          `"${surface.title}" update failed: fast action "${actionName}" did not provide a value`,
        )
        return
      }
      // Fast path: deterministic mutation on the daemon, no LLM (ADR-0003).
      invokeFastAction(surface.id, node.id, actionName, value)
        .then(onPatched)
        .catch((e: Error) => onError(`"${surface.title}" update failed: ${e.message}`))
    }
    // Agent path dispatch is wired after the runner through the Gateway and Surface engine slices.
  }

  return (
    <article style={{ border: '1px solid #e2e2e2', borderRadius: 12, padding: 16 }}>
      {renderNode(surface.tree, { state: surface.state, dispatch })}
      <div style={{ marginTop: 8, fontSize: 11, color: '#aaa' }}>
        updated {freshnessLabel(surface.freshness.updatedAt)} by {surface.freshness.updatedBy}
      </div>
    </article>
  )
}

function ChatBar() {
  const [entries, setEntries] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    const ws = new WebSocket(`ws://${location.host}/ws/chat`)
    ws.onmessage = (event) => {
      let json: unknown
      try {
        json = JSON.parse(String(event.data))
      } catch {
        return
      }
      const parsed = ChatMessageSchema.safeParse(json)
      if (parsed.success) setEntries((prev) => [...prev, parsed.data])
    }
    wsRef.current = ws
    return () => ws.close()
  }, [])

  const send = () => {
    const trimmed = text.trim()
    if (!trimmed || wsRef.current?.readyState !== WebSocket.OPEN) return
    wsRef.current.send(JSON.stringify({ text: trimmed }))
    setEntries((prev) => [...prev, { role: 'user', text: trimmed }])
    setText('')
  }

  return (
    <footer
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        background: '#fff',
        borderTop: '1px solid #e2e2e2',
        padding: 12,
      }}
    >
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        {entries.slice(-3).map((entry, i) => (
          <div key={i} style={{ fontSize: 13, color: entry.role === 'user' ? '#333' : '#4a7' }}>
            <strong>{entry.role === 'user' ? 'you' : 'veduta'}:</strong> {entry.text}
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input
            style={{ flex: 1, padding: 8, borderRadius: 8, border: '1px solid #ccc' }}
            placeholder="Talk to Veduta…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
          />
          <button type="button" onClick={send}>
            Send
          </button>
        </div>
      </div>
    </footer>
  )
}
