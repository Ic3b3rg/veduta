import type { CSSProperties, ReactNode } from 'react'
import {
  boundValue,
  boundedNumber,
  iconGlyph,
  motionContent,
  motionItemKeys,
  optionalText,
  ratioValue,
  text,
  toneColor,
} from './atom-helpers.ts'
import { bodyTextStyle, labelStyle } from './atom-styles.ts'
import { tokensFor } from './design-system.ts'
import type { AtomProps } from './types.ts'
import { Badge } from './ui/badge.tsx'
import { Label } from './ui/label.tsx'
import { Progress } from './ui/progress.tsx'

export function TitleAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const level = boundedNumber(node.props?.['level'], 2, 1, 6)
  const content = text(node.props?.['text'])
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

export function TextAtom({ node, ctx }: AtomProps): ReactNode {
  return (
    <p {...motionContent('content')} style={bodyTextStyle(tokensFor(ctx.theme))}>
      {text(node.props?.['text'])}
    </p>
  )
}

export function CaptionAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  return (
    <small
      {...motionContent('content')}
      style={{ ...bodyTextStyle(tokens), color: tokens.color.textMuted, fontSize: tokens.font.xs }}
    >
      {text(node.props?.['text'])}
    </small>
  )
}

export function LabelAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const htmlFor = optionalText(node.props?.['for']) ?? optionalText(node.props?.['htmlFor'])
  const content = text(node.props?.['text'] ?? node.props?.['label'])
  if (!htmlFor)
    return (
      <span {...motionContent('content')} style={labelStyle(tokens)}>
        {content}
      </span>
    )
  return (
    <Label {...motionContent('content')} htmlFor={htmlFor} style={labelStyle(tokens)}>
      {content}
    </Label>
  )
}

export function MarkdownAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const paragraphs = text(node.props?.['text']).split(/\n{2,}/)
  const paragraphKeys = motionItemKeys(paragraphs)
  return (
    <div style={{ display: 'grid', gap: tokens.space.xs }}>
      {paragraphs.map((paragraph, index) => (
        <p
          key={paragraphKeys[index]}
          {...motionContent(`paragraph:${paragraphKeys[index] ?? index}`)}
          style={bodyTextStyle(tokens)}
        >
          {paragraph}
        </p>
      ))}
    </div>
  )
}

export function BadgeAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const tone = toneColor(
    tokens,
    optionalText(node.props?.['tone']) ?? optionalText(node.props?.['status']),
  )
  const content = node.props?.['text'] ?? node.props?.['status'] ?? node.props?.['label']
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

export function IconAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const label = optionalText(node.props?.['label'])
  return (
    <span
      {...motionContent('content')}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      style={{
        color: toneColor(tokens, optionalText(node.props?.['tone'])),
        display: 'inline-flex',
        fontSize: tokens.font.lg,
        lineHeight: 1,
      }}
    >
      {iconGlyph(optionalText(node.props?.['name']))}
    </span>
  )
}

export function StatAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const value = boundValue(node, ctx) ?? node.props?.['value']
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
        {text(value)}
        {node.props?.['unit'] ? (
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
    </div>
  )
}

export function ProgressAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const ratio = ratioValue(boundValue(node, ctx) ?? node.props?.['value'])
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
          {Math.round(ratio * 100)}%
        </span>
      </div>
      <Progress {...motionContent('bar')} aria-label={label} value={Math.round(ratio * 100)} />
    </div>
  )
}
