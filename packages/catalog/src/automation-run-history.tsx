import type { AutomationRunHistoryEntry } from '@veduta/protocol'
import type { CSSProperties, ReactNode } from 'react'
import { tokensFor, type CatalogTheme } from './design-system.ts'
import { SurfaceValue } from './surface-value.tsx'

export function AutomationRunHistory({
  history,
  theme,
}: {
  history: AutomationRunHistoryEntry[]
  theme?: CatalogTheme | undefined
}): ReactNode {
  const tokens = tokensFor(theme)
  return (
    <>
      {' '}
      {history.length > 0 && (
        <details style={{ marginTop: tokens.space.sm }}>
          <summary
            style={{
              color: tokens.color.textMuted,
              cursor: 'pointer',
              fontFamily: tokens.font.family,
              fontSize: tokens.font.sm,
              fontWeight: 650,
            }}
          >
            Run history ({history.length})
          </summary>
          <ol
            style={{
              display: 'grid',
              gap: tokens.space.sm,
              margin: `${tokens.space.sm}px 0 0`,
              paddingLeft: tokens.space.lg,
            }}
          >
            {history.map((entry) => (
              <li key={entry.id} style={automationHistoryEntryStyle(tokens, entry.kind)}>
                <strong>{automationHistoryKindLabel(entry.kind)}:</strong>{' '}
                <span>{entry.summary}</span>
                {' — '}
                <SurfaceValue value={entry.at} />
              </li>
            ))}
          </ol>
        </details>
      )}
    </>
  )
}

function automationHistoryKindLabel(kind: 'changed' | 'failed' | 'recovered'): string {
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`
}

function automationHistoryEntryStyle(
  tokens: ReturnType<typeof tokensFor>,
  kind: 'changed' | 'failed' | 'recovered',
): CSSProperties {
  const statusColor =
    kind === 'failed'
      ? tokens.color.danger
      : kind === 'recovered'
        ? tokens.color.success
        : tokens.color.text
  return {
    color: statusColor,
    display: 'block',
    fontFamily: tokens.font.family,
    fontSize: tokens.font.sm,
    lineHeight: 1.4,
  }
}
