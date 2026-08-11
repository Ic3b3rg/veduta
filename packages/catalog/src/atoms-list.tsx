import type { ReactNode } from 'react'
import { actionValue, boundValue, findAction, text } from './atom-helpers.ts'
import { bodyTextStyle, listItemStyle, switchKnobStyle, switchStyle } from './atom-styles.ts'
import { BadgeAtom } from './atoms-content.tsx'
import { tokensFor } from './design-system.ts'
import type { AtomProps } from './types.ts'

export function ListItemAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const action = node.actions?.[0]
  const content = (
    <>
      <div style={{ minWidth: 0 }}>
        <div style={{ ...bodyTextStyle(tokens), fontWeight: 650 }}>
          {text(node.props?.['label'])}
        </div>
        {node.props?.['detail'] ? (
          <div
            style={{
              ...bodyTextStyle(tokens),
              color: tokens.color.textMuted,
              fontSize: tokens.font.sm,
            }}
          >
            {text(node.props['detail'])}
          </div>
        ) : null}
      </div>
      {node.props?.['status'] ? <BadgeAtom node={node} ctx={ctx} /> : null}
    </>
  )

  if (!action) return <div style={listItemStyle(tokens)}>{content}</div>

  return (
    <button
      type="button"
      onClick={() => ctx.dispatch(node, action.name, actionValue(action))}
      style={{ ...listItemStyle(tokens), cursor: 'pointer', textAlign: 'left', width: '100%' }}
    >
      {content}
    </button>
  )
}

export function AutomationAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const enabled = Boolean(boundValue(node, ctx) ?? node.props?.['enabled'])
  const action = findAction(node, ['toggle', 'change'])
  const label = text(node.props?.['label'] ?? node.props?.['title'])
  return (
    <div style={listItemStyle(tokens)}>
      <div style={{ minWidth: 0 }}>
        <div style={{ ...bodyTextStyle(tokens), fontWeight: 650 }}>{label}</div>
        <div
          style={{
            ...bodyTextStyle(tokens),
            color: tokens.color.textMuted,
            fontSize: tokens.font.sm,
          }}
        >
          {text(node.props?.['schedule'] ?? node.props?.['detail'])}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={label}
        onClick={() => action && ctx.dispatch(node, action.name, !enabled)}
        style={switchStyle(tokens, enabled)}
      >
        <span aria-hidden="true" style={switchKnobStyle(tokens, enabled)} />
      </button>
    </div>
  )
}

export function UnknownAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  return (
    <em
      data-testid="unknown-atom"
      style={{
        color: tokens.color.danger,
        fontFamily: tokens.font.family,
        fontSize: tokens.font.sm,
      }}
    >
      unsupported Atom: {node.type}
    </em>
  )
}
