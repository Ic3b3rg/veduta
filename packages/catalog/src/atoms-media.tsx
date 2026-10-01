import { ImageAtomPropsSchema, IconAtomPropsSchema, type ImageAtomProps } from '@veduta/protocol'
import { useState, type ReactNode } from 'react'
import { iconGlyph, motionContent, toneColor } from './atom-helpers.ts'
import { surfaceStyle } from './atom-styles.ts'
import { tokensFor, type CatalogTokens } from './design-system.ts'
import type { AtomProps } from './types.ts'
import { Card } from './ui/card.tsx'

export function ImageAtom({ node, ctx }: AtomProps): ReactNode {
  const props = ImageAtomPropsSchema.parse(node.props)
  return (
    <div
      {...motionContent('content', { signature: `${props.src ?? ''}:${props.alt}` })}
      style={{ minWidth: 0 }}
    >
      <ImageContent key={props.src ?? 'missing'} props={props} tokens={tokensFor(ctx.theme)} />
    </div>
  )
}

function ImageContent({
  props,
  tokens,
}: {
  props: ImageAtomProps
  tokens: CatalogTokens
}): ReactNode {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>('loading')
  if (props.src === undefined || status === 'failed') {
    return (
      <Card
        role="img"
        aria-label={`${props.alt} unavailable`}
        style={{ ...surfaceStyle(tokens), color: tokens.color.textMuted, padding: tokens.space.md }}
      >
        {props.alt} unavailable
      </Card>
    )
  }
  return (
    <>
      <img
        alt={props.alt}
        src={props.src}
        loading={props.loading ?? 'lazy'}
        decoding="async"
        onLoad={() => setStatus('loaded')}
        onError={() => setStatus('failed')}
        style={{
          borderRadius: tokens.radius.md,
          display: 'block',
          maxWidth: '100%',
          objectFit: 'cover',
        }}
      />
      {status === 'loading' ? (
        <small role="status" style={{ color: tokens.color.textMuted }}>
          {props.alt} loading
        </small>
      ) : null}
    </>
  )
}

export function IconAtom({ node, ctx }: AtomProps): ReactNode {
  const props = IconAtomPropsSchema.parse(node.props)
  const tokens = tokensFor(ctx.theme)
  return (
    <span
      {...motionContent('content')}
      aria-label={props.label}
      aria-hidden={props.decorative === true ? true : undefined}
      role={props.decorative === true ? undefined : 'img'}
      style={{
        color: toneColor(tokens, props.tone),
        display: 'inline-flex',
        fontSize: tokens.font.lg,
        lineHeight: 1,
      }}
    >
      {iconGlyph(props.name)}
    </span>
  )
}
