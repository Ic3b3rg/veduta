import type { ReactNode } from 'react'
import {
  boundValue,
  dataPoints,
  humanLabel,
  optionalText,
  tableColumns,
  tableRows,
  text,
} from './atom-helpers.ts'
import { labelStyle, surfaceStyle, tableCellStyle, tableHeaderStyle } from './atom-styles.ts'
import { tokensFor } from './design-system.ts'
import type { AtomProps } from './types.ts'

export function TableAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const rows = tableRows(boundValue(node, ctx) ?? node.props?.['rows'])
  const columns = tableColumns(node.props?.['columns'], rows)
  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        style={{
          borderCollapse: 'collapse',
          color: tokens.color.text,
          minWidth: 320,
          width: '100%',
        }}
      >
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col" style={tableHeaderStyle(tokens)}>
                {humanLabel(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((column) => (
                <td key={column} style={tableCellStyle(tokens)}>
                  {text(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ImageAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const src = optionalText(node.props?.['src'])
  const alt = optionalText(node.props?.['alt']) ?? optionalText(node.props?.['label']) ?? ''
  if (!src) {
    return (
      <div
        role="img"
        aria-label={alt || 'Image placeholder'}
        style={{
          ...surfaceStyle(tokens),
          alignItems: 'center',
          aspectRatio: '16 / 9',
          color: tokens.color.textMuted,
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        {alt || 'Image'}
      </div>
    )
  }
  return (
    <img
      alt={alt}
      src={src}
      style={{
        borderRadius: tokens.radius.md,
        display: 'block',
        maxWidth: '100%',
        objectFit: 'cover',
      }}
    />
  )
}

export function ChartAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const points = dataPoints(boundValue(node, ctx) ?? node.props?.['data'])
  const max = Math.max(...points.map((point) => point.value), 1)
  return (
    <div
      role="img"
      aria-label={text(node.props?.['label'] ?? 'Chart')}
      style={{
        ...surfaceStyle(tokens),
        display: 'flex',
        alignItems: 'flex-end',
        gap: tokens.space.sm,
        minHeight: 132,
        padding: tokens.space.md,
      }}
    >
      {points.map((point) => (
        <div
          key={point.label}
          style={{
            alignItems: 'center',
            display: 'flex',
            flex: 1,
            flexDirection: 'column',
            gap: tokens.space.xs,
            minWidth: 28,
          }}
        >
          <div
            aria-hidden="true"
            title={`${point.label}: ${point.value}`}
            style={{
              background: tokens.color.accent,
              borderRadius: `${tokens.radius.sm}px ${tokens.radius.sm}px 0 0`,
              height: `${Math.max(8, (point.value / max) * 88)}px`,
              width: '100%',
            }}
          />
          <span style={{ ...labelStyle(tokens), textAlign: 'center' }}>{point.label}</span>
        </div>
      ))}
    </div>
  )
}
