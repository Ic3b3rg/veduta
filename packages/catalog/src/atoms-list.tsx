import { AutomationAtomPropsSchema, AutomationRunHistorySchema } from '@veduta/protocol'
import type { CSSProperties, ReactNode } from 'react'
import { ActionFeedback, useActionFeedback, type AtomMotionAttributes } from './action-feedback.tsx'
import { boundValue, motionContent, text } from './atom-helpers.ts'
import { bodyTextStyle } from './atom-styles.ts'
import { BadgeAtom } from './atoms-content.tsx'
import { tokensFor } from './design-system.ts'
import type { AtomProps, RenderableAtomProps } from './types.ts'
import { Item } from './ui/item.tsx'
import { Switch } from './ui/switch.tsx'

function ListItemControl({ node, ctx, ...motion }: AtomProps & AtomMotionAttributes): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const action = node.actions?.[0]
  const feedback = useActionFeedback({ node, ctx })
  const content = (
    <>
      <div style={{ minWidth: 0 }}>
        <div {...motionContent('label')} style={{ ...bodyTextStyle(tokens), fontWeight: 650 }}>
          {text(node.props?.['label'])}
        </div>
        {node.props?.['detail'] ? (
          <div
            {...motionContent('detail')}
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
      {node.props?.['status'] ? (
        <BadgeAtom
          node={{
            ...node,
            props: { text: node.props['status'], tone: node.props['tone'] ?? 'neutral' },
          }}
          ctx={ctx}
        />
      ) : null}
    </>
  )

  if (!action) {
    return (
      <Item {...motion} variant="outline" size="sm">
        {content}
      </Item>
    )
  }

  return (
    <ActionFeedback {...motion} feedback={feedback} ctx={ctx}>
      <Item asChild variant="outline" size="sm">
        <button
          {...feedback.attributes}
          type="button"
          disabled={feedback.disabled}
          onClick={() => void feedback.dispatch()}
          className="w-full cursor-pointer text-left"
        >
          {content}
        </button>
      </Item>
    </ActionFeedback>
  )
}

export function ListItemAtom(props: AtomProps): ReactNode {
  return <ListItemControl {...props} />
}

function AutomationControl({ node, ctx, ...motion }: AtomProps & AtomMotionAttributes): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const feedback = useActionFeedback({ node, ctx })
  const enabled = Boolean(boundValue(node, ctx) ?? node.props?.['enabled'])
  const action = node.actions?.[0]
  const label = text(node.props?.['label'] ?? node.props?.['title'])
  const props = AutomationAtomPropsSchema.safeParse(node.props ?? {})
  const boundHistory = props.success
    ? AutomationRunHistorySchema.safeParse(
        props.data.historyBinding === undefined ? undefined : ctx.state[props.data.historyBinding],
      )
    : undefined
  const history = boundHistory?.success
    ? boundHistory.data
    : props.success
      ? (props.data.history ?? [])
      : []
  const content = (
    <Item {...(action ? {} : motion)} variant="outline" size="sm">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div {...motionContent('label')} style={{ ...bodyTextStyle(tokens), fontWeight: 650 }}>
          {label}
        </div>
        <div
          {...motionContent('schedule')}
          style={{
            ...bodyTextStyle(tokens),
            color: tokens.color.textMuted,
            fontSize: tokens.font.sm,
          }}
        >
          {text(node.props?.['schedule'] ?? node.props?.['detail'])}
        </div>
        {history.length > 0 && (
          <details style={{ marginTop: tokens.space.sm }}>
            <summary
              style={{
                color: tokens.color.textMuted,
                cursor: 'pointer',
                fontFamily: tokens.font.family,
                fontSize: tokens.font.sm,
                fontWeight: 650,
              }}
            >
              Run history ({history.length})
            </summary>
            <ol
              style={{
                display: 'grid',
                gap: tokens.space.sm,
                margin: `${tokens.space.sm}px 0 0`,
                paddingLeft: tokens.space.lg,
              }}
            >
              {history.map((entry) => (
                <li key={entry.id} style={automationHistoryEntryStyle(tokens, entry.kind)}>
                  <strong>{automationHistoryKindLabel(entry.kind)}:</strong>{' '}
                  <span>{entry.summary}</span>
                  {' — '}
                  <time dateTime={entry.at}>{automationHistoryTimeLabel(entry.at)}</time>
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>
      {action ? (
        <Switch
          {...motionContent('value')}
          {...feedback.attributes}
          checked={enabled}
          disabled={feedback.disabled}
          aria-label={label}
          onCheckedChange={(next) => void feedback.dispatch(next)}
        />
      ) : (
        <span {...motionContent('value')}>{enabled ? 'Enabled' : 'Disabled'}</span>
      )}
    </Item>
  )
  return action ? (
    <ActionFeedback {...motion} feedback={feedback} ctx={ctx}>
      {content}
    </ActionFeedback>
  ) : (
    content
  )
}

export function AutomationAtom(props: AtomProps): ReactNode {
  return <AutomationControl {...props} />
}

function automationHistoryKindLabel(kind: 'changed' | 'failed' | 'recovered'): string {
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`
}

function automationHistoryEntryStyle(
  tokens: ReturnType<typeof tokensFor>,
  kind: 'changed' | 'failed' | 'recovered',
): CSSProperties {
  const statusColor =
    kind === 'failed'
      ? tokens.color.danger
      : kind === 'recovered'
        ? tokens.color.success
        : tokens.color.text
  return {
    color: statusColor,
    display: 'block',
    fontFamily: tokens.font.family,
    fontSize: tokens.font.sm,
    lineHeight: 1.4,
  }
}

function automationHistoryTimeLabel(iso: string): string {
  const date = new Date(iso)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : iso
}

export function UnknownAtom({ node, ctx, children }: RenderableAtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  return (
    <div
      {...motionContent('content')}
      data-testid="unknown-atom"
      style={{
        color: tokens.color.danger,
        fontFamily: tokens.font.family,
        fontSize: tokens.font.sm,
      }}
    >
      <em>
        unsupported Atom: {node.type} ({node.id})
      </em>
      {children}
    </div>
  )
}
