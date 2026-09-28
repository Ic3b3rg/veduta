import type { ReactNode } from 'react'
import { Bar, BarChart } from 'recharts'
import {
  boundValue,
  dataPoints,
  humanLabel,
  motionCollectionItem,
  motionContent,
  motionItemKeys,
  optionalText,
  tableColumns,
  tableRows,
  text,
} from './atom-helpers.ts'
import { labelStyle, surfaceStyle } from './atom-styles.ts'
import { tokensFor } from './design-system.ts'
import type { AtomProps } from './types.ts'
import { Card } from './ui/card.tsx'
import { ChartContainer } from './ui/chart.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.tsx'

export function TableAtom({ node, ctx }: AtomProps): ReactNode {
  const rows = tableRows(boundValue(node, ctx) ?? node.props?.['rows'])
  const rowKeys = motionItemKeys(rows)
  const columns = tableColumns(node.props?.['columns'], rows)
  return (
    <div style={{ overflowX: 'auto' }}>
      <Table className="min-w-80">
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead key={column} {...motionContent(`column:${column}`)} scope="col">
                {humanLabel(column)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, rowIndex) => (
            <TableRow
              key={rowKeys[rowIndex]}
              {...motionCollectionItem(`row:${rowKeys[rowIndex] ?? rowIndex}`)}
            >
              {columns.map((column) => (
                <TableCell
                  key={column}
                  {...motionContent(`cell:${rowKeys[rowIndex] ?? rowIndex}:${column}`)}
                >
                  {text(row[column])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function ImageAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const src = optionalText(node.props?.['src'])
  const alt = optionalText(node.props?.['alt']) ?? optionalText(node.props?.['label']) ?? ''
  if (!src) {
    return (
      <Card
        {...motionContent('content')}
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
      </Card>
    )
  }
  return (
    <img
      {...motionContent('content')}
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
  const label = text(node.props?.['label'] ?? 'Chart')
  return (
    <Card
      role="img"
      aria-label={`${label}: ${points.map((point) => `${point.label} ${point.value}`).join(', ')}`}
      style={{
        gap: tokens.space.sm,
        padding: tokens.space.md,
      }}
    >
      <ChartContainer config={{ value: { label } }} className="h-32 w-full" aria-hidden="true">
        <BarChart data={points} accessibilityLayer>
          <Bar dataKey="value" fill="var(--catalog-color-accent)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ChartContainer>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.space.md }}>
        {points.map((point) => (
          <span
            key={point.label}
            {...motionContent(`point:${point.label}`)}
            style={{ ...labelStyle(tokens), color: tokens.color.text }}
          >
            <span>{point.label}</span> <strong>{point.value}</strong>
          </span>
        ))}
      </div>
    </Card>
  )
}
