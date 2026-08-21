import {
  DEFAULT_PENDING_SLOT_TIMEOUT_MS,
  PendingAtomPropsSchema,
  type PendingAtomProps,
  type PendingSlotVariant,
} from '@veduta/protocol'
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { motionContent, optionalText } from './atom-helpers.ts'
import { surfaceStyle } from './atom-styles.ts'
import { tokensFor, type CatalogTokens } from './design-system.ts'
import type { AtomProps } from './types.ts'

const defaultLabels: Record<PendingSlotVariant, string> = {
  text: 'Text content',
  list: 'List content',
  image: 'Image',
  stat: 'Statistic',
  chart: 'Chart',
}

export function PendingAtom({ node, ctx }: AtomProps): ReactNode {
  const parsed = PendingAtomPropsSchema.safeParse(node.props)
  const tokens = tokensFor(ctx.theme)
  if (!parsed.success) {
    return <PendingFallback label={optionalText(node.props?.['label'])} tokens={tokens} />
  }

  return (
    <div style={{ minWidth: 0, width: '100%' }}>
      <PendingSlot key={pendingSlotKey(parsed.data)} props={parsed.data} tokens={tokens} />
    </div>
  )
}

function PendingSlot({ props, tokens }: { props: PendingAtomProps; tokens: CatalogTokens }) {
  const [timedOut, setTimedOut] = useState(false)
  const timeoutMs = props.timeoutMs ?? DEFAULT_PENDING_SLOT_TIMEOUT_MS

  useEffect(() => {
    const timeout = globalThis.setTimeout(() => setTimedOut(true), timeoutMs)
    return () => globalThis.clearTimeout(timeout)
  }, [timeoutMs])

  if (timedOut) return <PendingFallback label={props.label} tokens={tokens} />
  return skeletonFor(props, tokens)
}

function pendingSlotKey(props: PendingAtomProps): string {
  const size = props.variant === 'text' ? props.lines : props.variant === 'list' ? props.rows : 0
  return `${props.variant}:${props.label ?? ''}:${props.timeoutMs ?? ''}:${size ?? ''}`
}

function skeletonFor(props: PendingAtomProps, tokens: CatalogTokens): ReactNode {
  switch (props.variant) {
    case 'text':
      return (
        <SkeletonFrame props={props} tokens={tokens}>
          {Array.from({ length: props.lines ?? 3 }, (_, index) => (
            <SkeletonShape
              key={index}
              tokens={tokens}
              data-pending-skeleton-line=""
              style={{
                height: tokens.space.sm,
                width: index === (props.lines ?? 3) - 1 ? '68%' : index % 2 === 0 ? '100%' : '92%',
              }}
            />
          ))}
        </SkeletonFrame>
      )
    case 'list':
      return (
        <SkeletonFrame props={props} tokens={tokens}>
          {Array.from({ length: props.rows ?? 3 }, (_, index) => (
            <div
              key={index}
              data-pending-skeleton-row=""
              style={{
                alignItems: 'center',
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                display: 'flex',
                gap: tokens.space.md,
                minHeight: tokens.space.xl * 2,
                padding: tokens.space.md,
              }}
            >
              <SkeletonShape
                tokens={tokens}
                style={{ borderRadius: '50%', height: tokens.space.xl, width: tokens.space.xl }}
              />
              <div style={{ display: 'grid', flex: 1, gap: tokens.space.xs }}>
                <SkeletonShape tokens={tokens} style={{ height: tokens.space.sm, width: '72%' }} />
                <SkeletonShape tokens={tokens} style={{ height: tokens.space.xs, width: '48%' }} />
              </div>
            </div>
          ))}
        </SkeletonFrame>
      )
    case 'image':
      return (
        <SkeletonFrame
          props={props}
          tokens={tokens}
          style={{ aspectRatio: '16 / 9', minHeight: 0 }}
        >
          <SkeletonShape tokens={tokens} style={{ height: '100%', width: '100%' }} />
        </SkeletonFrame>
      )
    case 'stat':
      return (
        <SkeletonFrame props={props} tokens={tokens} style={{ minWidth: tokens.space.xl * 4 }}>
          <SkeletonShape tokens={tokens} style={{ height: tokens.space.xs, width: '52%' }} />
          <SkeletonShape tokens={tokens} style={{ height: tokens.space.xl, width: '84%' }} />
          <SkeletonShape tokens={tokens} style={{ height: tokens.space.xs, width: '64%' }} />
        </SkeletonFrame>
      )
    case 'chart':
      return (
        <SkeletonFrame
          props={props}
          tokens={tokens}
          style={{ alignItems: 'end', display: 'flex', minHeight: 132 }}
        >
          {[4, 7, 5, 9].map((height) => (
            <SkeletonShape
              key={height}
              tokens={tokens}
              style={{ flex: 1, height: height * tokens.space.sm, minWidth: tokens.space.xl }}
            />
          ))}
        </SkeletonFrame>
      )
  }
}

function SkeletonFrame({
  props,
  tokens,
  style,
  children,
}: {
  props: PendingAtomProps
  tokens: CatalogTokens
  style?: CSSProperties
  children: ReactNode
}) {
  const label = props.label ?? defaultLabels[props.variant]
  return (
    <div
      {...motionContent('content')}
      role="status"
      aria-busy="true"
      aria-label={`${label} loading`}
      data-pending-variant={props.variant}
      style={{
        ...surfaceStyle(tokens),
        boxSizing: 'border-box',
        display: 'grid',
        gap: tokens.space.sm,
        minHeight: tokens.space.xl * 2,
        overflow: 'hidden',
        padding: tokens.space.md,
        width: '100%',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

function SkeletonShape({
  tokens,
  style,
  ...attributes
}: {
  tokens: CatalogTokens
  style: CSSProperties
  'data-pending-skeleton-line'?: string
}) {
  return (
    <span
      aria-hidden="true"
      data-pending-skeleton-shape=""
      style={{
        background: tokens.color.surfaceMuted,
        borderRadius: tokens.radius.sm,
        display: 'block',
        ...style,
      }}
      {...attributes}
    />
  )
}

function PendingFallback({ label, tokens }: { label?: string | undefined; tokens: CatalogTokens }) {
  return (
    <div
      {...motionContent('content')}
      role="alert"
      data-testid="pending-slot-fallback"
      style={{
        ...surfaceStyle(tokens),
        background: tokens.color.surfaceMuted,
        borderColor: tokens.color.warning,
        color: tokens.color.textMuted,
        fontSize: tokens.font.sm,
        padding: tokens.space.md,
      }}
    >
      {label ? `${label} unavailable` : 'Content unavailable'}
    </div>
  )
}
