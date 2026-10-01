import { createElement, type ReactNode } from 'react'
import { motionContent, motionItemKeys } from './atom-helpers.ts'
import { bodyTextStyle } from './atom-styles.ts'
import type { CatalogTokens } from './design-system.ts'

/** A closed Markdown subset rendered as React content; raw markup is always literal text. */
export function structuredMarkdown(source: string, tokens: CatalogTokens): ReactNode {
  const blocks = markdownBlocks(source)
  const keys = motionItemKeys(blocks)
  return blocks.map((block, index) => {
    const key = keys[index]
    const attributes = {
      ...motionContent(`paragraph:${key ?? index}`),
      style: bodyTextStyle(tokens),
    }
    if (block.kind === 'code')
      return (
        <pre key={key} {...attributes} style={{ ...attributes.style, overflowX: 'auto' }}>
          <code>{block.text}</code>
        </pre>
      )
    if (block.kind === 'heading')
      return createElement(`h${block.level}`, { ...attributes, key }, inlineMarkdown(block.text))
    if (block.kind === 'list') {
      const items = block.items.map((item, itemIndex) => (
        <li key={itemIndex}>{inlineMarkdown(item)}</li>
      ))
      return block.ordered ? (
        <ol key={key} {...attributes}>
          {items}
        </ol>
      ) : (
        <ul key={key} {...attributes}>
          {items}
        </ul>
      )
    }
    return (
      <p key={key} {...attributes} style={{ ...attributes.style, whiteSpace: 'pre-wrap' }}>
        {inlineMarkdown(block.text)}
      </p>
    )
  })
}

type MarkdownBlock =
  | { kind: 'paragraph' | 'code'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }

function markdownBlocks(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? ''
    if (!line.trim()) {
      index++
      continue
    }
    if (/^```/.test(line)) {
      const content: string[] = []
      index++
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? ''))
        content.push(lines[index++] ?? '')
      if (index < lines.length) index++
      blocks.push({ kind: 'code', text: content.join('\n') })
      continue
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]?.length ?? 2, text: heading[2] ?? '' })
      index++
      continue
    }
    const list = /^(?:([-+*])|(\d+)\.)\s+(.+)$/.exec(line)
    if (list) {
      const ordered = list[2] !== undefined
      const items: string[] = []
      while (index < lines.length) {
        const item = /^(?:([-+*])|(\d+)\.)\s+(.+)$/.exec(lines[index] ?? '')
        if (!item || (item[2] !== undefined) !== ordered) break
        items.push(item[3] ?? '')
        index++
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    const paragraph: string[] = [line]
    index++
    while (
      index < lines.length &&
      lines[index]?.trim() &&
      !/^(?:```|#{1,6}\s|[-+*]\s|\d+\.\s)/.test(lines[index] ?? '')
    )
      paragraph.push(lines[index++] ?? '')
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
  }
  return blocks
}

function inlineMarkdown(text: string): ReactNode {
  const parts: ReactNode[] = []
  const tokens = /\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*|\[([^\]]+)\]\(([^\s)]+)\)/g
  let start = 0
  for (const token of text.matchAll(tokens)) {
    parts.push(text.slice(start, token.index))
    const key = token.index
    if (token[1] !== undefined) parts.push(<strong key={key}>{token[1]}</strong>)
    else if (token[2] !== undefined) parts.push(<code key={key}>{token[2]}</code>)
    else if (token[3] !== undefined) parts.push(<em key={key}>{token[3]}</em>)
    else if (token[4] !== undefined) {
      const href = safeMarkdownLink(token[5] ?? '')
      parts.push(
        href === undefined ? (
          token[4]
        ) : (
          <a key={key} href={href} rel="noreferrer noopener">
            {token[4]}
          </a>
        ),
      )
    }
    start = (token.index ?? 0) + token[0].length
  }
  parts.push(text.slice(start))
  return parts
}

function safeMarkdownLink(source: string): string | undefined {
  if (/^\/(?!\/)/.test(source)) return source
  try {
    const url = new URL(source)
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? source : undefined
  } catch {
    return undefined
  }
}
