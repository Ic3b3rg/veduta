import type { ReactNode } from 'react'
import { align, motionContent, propBoolean, spacing } from './atom-helpers.ts'
import { surfaceStyle } from './atom-styles.ts'
import { tokensFor } from './design-system.ts'
import type { AtomProps } from './types.ts'

export function BoxAtom({ node, ctx, children }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  return (
    <div
      data-veduta-theme={tokens.mode}
      style={{
        ...surfaceStyle(tokens),
        display: 'flex',
        flexDirection: 'column',
        gap: spacing(tokens, node.props?.['gap'], 'md'),
        padding: spacing(tokens, node.props?.['padding'], 'md'),
      }}
    >
      {children}
    </div>
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
        minWidth: 0,
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

export function DividerAtom({ ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  return (
    <hr
      style={{
        border: 'none',
        borderTop: `1px solid ${tokens.color.border}`,
        margin: `${tokens.space.xs}px 0`,
        width: '100%',
      }}
    />
  )
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
    >
      {children}
    </div>
  )
}
