import type { CSSProperties, ReactNode } from 'react'
import {
  boundValue,
  boundedNumber,
  motionContent,
  optionalText,
  ratioValue,
  text,
  toneColor,
} from './atom-helpers.ts'
import { bodyTextStyle, labelStyle } from './atom-styles.ts'
import { tokensFor } from './design-system.ts'
import type { AtomProps } from './types.ts'
import { Badge } from './ui/badge.tsx'
import { Progress } from './ui/progress.tsx'
import { structuredMarkdown } from './structured-markdown.tsx'

function contentText(
  node: AtomProps<'Title' | 'Text' | 'Caption' | 'Label' | 'Markdown'>['node'],
  ctx: AtomProps['ctx'],
): string {
  const value = text(node.binding ? boundValue(node, ctx) : node.props?.['text'])
  return value.trim() ? value : text(node.props?.['emptyText'] ?? 'No content yet')
}

export function TitleAtom({ node, ctx }: AtomProps<'Title'>): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const level = boundedNumber(node.props?.['level'], 2, 1, 6)
  const content = contentText(node, ctx)
  const contentMotion = motionContent('content')
  const style: CSSProperties = {
    margin: 0,
    color: tokens.color.text,
    fontFamily: tokens.font.family,
    fontSize: level <= 2 ? tokens.font.xl : tokens.font.lg,
    lineHeight: 1.2,
    fontWeight: 700,
  }

  if (level === 1)
    return (
      <h1 {...contentMotion} style={style}>
        {content}
      </h1>
    )
  if (level === 2)
    return (
      <h2 {...contentMotion} style={style}>
        {content}
      </h2>
    )
  if (level === 3)
    return (
      <h3 {...contentMotion} style={style}>
        {content}
      </h3>
    )
  if (level === 4)
    return (
      <h4 {...contentMotion} style={style}>
        {content}
      </h4>
    )
  if (level === 5)
    return (
      <h5 {...contentMotion} style={style}>
        {content}
      </h5>
    )
  return (
    <h6 {...contentMotion} style={style}>
      {content}
    </h6>
  )
}

export function TextAtom({ node, ctx }: AtomProps<'Text'>): ReactNode {
  return (
    <p {...motionContent('content')} style={bodyTextStyle(tokensFor(ctx.theme))}>
      {contentText(node, ctx)}
    </p>
  )
}

export function CaptionAtom({ node, ctx }: AtomProps<'Caption'>): ReactNode {
  const tokens = tokensFor(ctx.theme)
  return (
    <small
      {...motionContent('content')}
      style={{ ...bodyTextStyle(tokens), color: tokens.color.textMuted, fontSize: tokens.font.xs }}
    >
      {contentText(node, ctx)}
    </small>
  )
}

export function LabelAtom({ node, ctx }: AtomProps<'Label'>): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const content = contentText(node, ctx)
  return (
    <span {...motionContent('content')} style={labelStyle(tokens)}>
      {content}
    </span>
  )
}

export function MarkdownAtom({ node, ctx }: AtomProps<'Markdown'>): ReactNode {
  const tokens = tokensFor(ctx.theme)
  return (
    <div style={{ display: 'grid', gap: tokens.space.xs }}>
      {structuredMarkdown(contentText(node, ctx), tokens)}
    </div>
  )
}

export function BadgeAtom({ node, ctx }: AtomProps<'Badge'>): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const tone = toneColor(tokens, optionalText(node.props?.['tone']))
  const content = node.props?.['text']
  return (
    <Badge
      {...motionContent('content')}
      variant="outline"
      style={{
        alignSelf: 'flex-start',
        borderColor: tone,
        color: tone,
      }}
    >
      {text(content)}
    </Badge>
  )
}

export function StatAtom({ node, ctx }: AtomProps<'Stat'>): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const value = node.binding ? boundValue(node, ctx) : node.props?.['value']
  const hasValue =
    value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '')
  return (
    <div style={{ minWidth: 96 }}>
      <div {...motionContent('label')} style={labelStyle(tokens)}>
        {text(node.props?.['label'])}
      </div>
      <div
        {...motionContent('value')}
        style={{
          color: tokens.color.text,
          fontFamily: tokens.font.family,
          fontSize: tokens.font.xl,
          fontWeight: 750,
          lineHeight: 1.1,
        }}
      >
        {hasValue ? text(value) : text(node.props?.['emptyText'] ?? 'Not recorded')}
        {hasValue && node.props?.['unit'] ? (
          <span style={{ color: tokens.color.textMuted, fontSize: tokens.font.sm, marginLeft: 4 }}>
            {text(node.props['unit'])}
          </span>
        ) : null}
      </div>
      {node.props?.['trend'] ? (
        <div
          {...motionContent('trend')}
          style={{
            ...bodyTextStyle(tokens),
            color: tokens.color.textMuted,
            fontSize: tokens.font.xs,
          }}
        >
          {text(node.props['trend'])}
        </div>
      ) : null}
      {node.props?.['detail'] ? (
        <p {...motionContent('detail')} style={bodyTextStyle(tokens)}>
          {text(node.props['detail'])}
        </p>
      ) : null}
    </div>
  )
}

export function ProgressAtom({ node, ctx }: AtomProps<'Progress'>): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const value = node.binding ? boundValue(node, ctx) : node.props?.['value']
  const ratio = ratioValue(value)
  const hasValue = value !== null && value !== undefined
  const label = text(node.props?.['label'])
  return (
    <div style={{ display: 'grid', gap: tokens.space.xs }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: tokens.space.sm }}>
        <span {...motionContent('label')} style={labelStyle(tokens)}>
          {label}
        </span>
        <span
          {...motionContent('value')}
          style={{ ...labelStyle(tokens), color: tokens.color.text }}
        >
          {hasValue
            ? `${Math.round(ratio * 100)}%`
            : text(node.props?.['emptyText'] ?? 'Not recorded')}
        </span>
      </div>
      {hasValue ? (
        <Progress {...motionContent('bar')} aria-label={label} value={Math.round(ratio * 100)} />
      ) : null}
    </div>
  )
}
