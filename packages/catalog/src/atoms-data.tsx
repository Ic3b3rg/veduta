import type { ReactNode } from 'react'
import {
  boundValue,
  humanLabel,
  motionCollectionItem,
  motionContent,
  motionItemKeys,
  optionalText,
  tableColumns,
  tableRows,
  text,
} from './atom-helpers.ts'
import { surfaceStyle } from './atom-styles.ts'
import { tokensFor } from './design-system.ts'
import type { AtomProps } from './types.ts'
import { Card } from './ui/card.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.tsx'

export function TableAtom({ node, ctx }: AtomProps): ReactNode {
  const rows = tableRows(boundValue(node, ctx) ?? node.props?.['rows'])
  const rowKeys = motionItemKeys(rows)
  const columns = tableColumns(node.props?.['columns'], rows)
  return (
    <div style={{ overflowX: 'auto' }}>
      <Table className="min-w-80">
        {node.props?.['caption'] ? (
          <caption {...motionContent('caption')}>{text(node.props['caption'])}</caption>
        ) : null}
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
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length}>
                {text(node.props?.['emptyText'] ?? 'No records yet')}
              </TableCell>
            </TableRow>
          ) : null}
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
                  {row[column] === null ||
                  (typeof row[column] === 'string' && row[column].trim() === '')
                    ? '—'
                    : text(row[column])}
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
