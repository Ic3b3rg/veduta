import { renderNode } from '@veduta/catalog'
import {
  type AtomNode,
  type ChatMessage,
  type JsonValue,
  type Surface,
  type SurfacePatchEvent,
} from '@veduta/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  connectGateway,
  fetchSpaces,
  freshnessLabel,
  invokeFastAction,
  patchSurface,
  type GatewayConnection,
  type SpaceWithSurfaces,
} from './api.ts'

const SURFACE_CURSOR_KEY = 'veduta.surfaceCursor'

export function App() {
  const [spaces, setSpaces] = useState<SpaceWithSurfaces[]>([])
  const [error, setError] = useState<string | null>(null)
  const [chatEntries, setChatEntries] = useState<ChatMessage[]>([])
  const gatewayRef = useRef<GatewayConnection | null>(null)
  const spacesRef = useRef<SpaceWithSurfaces[]>([])
  const surfaceCursorRef = useRef(readStoredCursor())

  const updateCursor = useCallback((cursor: number) => {
    surfaceCursorRef.current = cursor
    localStorage.setItem(SURFACE_CURSOR_KEY, String(cursor))
  }, [])

  const replaceSpaces = useCallback((next: SpaceWithSurfaces[]) => {
    spacesRef.current = next
    setSpaces(next)
  }, [])

  const applySurfaceEvent = useCallback(
    (event: SurfacePatchEvent) => {
      let applied = false
      try {
        const next = spacesRef.current.map((space) => ({
          ...space,
          surfaces: space.surfaces.map((surface) => {
            if (surface.id !== event.patch.surfaceId) return surface
            applied = true
            return patchSurface(surface, event)
          }),
        }))

        if (!applied) {
          setError(`patch for unknown Surface: ${event.patch.surfaceId}`)
          return
        }

        replaceSpaces(next)
        updateCursor(event.cursor)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to apply Surface patch')
      }
    },
    [replaceSpaces, updateCursor],
  )

  useEffect(() => {
    let closedByApp = false
    let reconnectTimer: number | undefined

    const scheduleReconnect = () => {
      if (closedByApp) return
      reconnectTimer = window.setTimeout(() => startGateway(), 1000)
    }

    const startGateway = () => {
      gatewayRef.current = connectGateway({
        surfaceCursor: surfaceCursorRef.current,
        onHello() {
          // The replay cursor advances only after each patch is applied.
        },
        onSurfacePatch(event) {
          applySurfaceEvent(event)
        },
        onChatMessage(message) {
          setChatEntries((prev) => [...prev, message.message])
        },
        onPresence() {
          // Presence is part of the Gateway protocol; the Home UI for it arrives with device pairing.
        },
        onError(message) {
          setError(message)
        },
        onClose: scheduleReconnect,
      })
    }

    fetchSpaces()
      .then((snapshot) => {
        replaceSpaces(snapshot.spaces)
        updateCursor(snapshot.surfaceCursor)
        startGateway()
      })
      .catch((e: Error) => setError(e.message))

    return () => {
      closedByApp = true
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      gatewayRef.current?.close()
    }
  }, [applySurfaceEvent, replaceSpaces, updateCursor])

  const replaceSurface = (updated: Surface) => {
    replaceSpaces(
      spacesRef.current.map((space) => ({
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
                onPatched={replaceSurface}
                onError={setError}
              />
            ))}
          </div>
        </section>
      ))}
      <ChatBar
        entries={chatEntries}
        onSend={(message) => {
          if (!gatewayRef.current?.sendChat(message)) return false
          setChatEntries((prev) => [...prev, { role: 'user', text: message }])
          return true
        }}
      />
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

function ChatBar({
  entries,
  onSend,
}: {
  entries: ChatMessage[]
  onSend: (text: string) => boolean
}) {
  const [text, setText] = useState('')

  const send = () => {
    const trimmed = text.trim()
    if (!trimmed || !onSend(trimmed)) return
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

function readStoredCursor(): number {
  const stored = Number(localStorage.getItem(SURFACE_CURSOR_KEY))
  return Number.isInteger(stored) && stored >= 0 ? stored : 0
}
