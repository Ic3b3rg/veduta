import type { ReactNode } from 'react'
import { align, motionContent, propBoolean, spacing } from './atom-helpers.ts'
import { tokensFor } from './design-system.ts'
import type { AtomProps } from './types.ts'
import { Card } from './ui/card.tsx'
import { Separator } from './ui/separator.tsx'

export function BoxAtom({ node, ctx, children }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  return (
    <Card
      data-veduta-theme={tokens.mode}
      style={{
        gap: spacing(tokens, node.props?.['gap'], 'md'),
        padding: spacing(tokens, node.props?.['padding'], 'md'),
      }}
    >
      {children}
    </Card>
  )
}

export function RowAtom({ node, ctx, children }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: propBoolean(node.props, 'wrap', true) ? 'wrap' : 'nowrap',
        alignItems: align(node.props?.['align']),
        gap: spacing(tokens, node.props?.['gap'], 'md'),
      }}
    >
      {children}
    </div>
  )
}

export function ColAtom({ node, ctx, children }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: spacing(tokens, node.props?.['gap'], 'sm'),
        flex: 1,
        minWidth: `min(100%, ${tokens.space.xl * 10}px)`,
      }}
    >
      {children}
    </div>
  )
}

export function SpacerAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  return (
    <div aria-hidden="true" style={{ minHeight: spacing(tokens, node.props?.['size'], 'md') }} />
  )
}

export function DividerAtom(): ReactNode {
  return <Separator decorative={false} className="my-1" />
}

export function TransitionAtom({ node, children }: AtomProps): ReactNode {
  const visible = propBoolean(node.props, 'visible', true)
  return (
    <div
      {...motionContent('content', {
        mode: 'previous-opacity',
        signature: `visible:${visible}`,
      })}
      style={{
        opacity: visible ? 1 : 0.4,
      }}
      className="transition-opacity duration-150 motion-reduce:transition-none"
    >
      {children}
    </div>
  )
}
