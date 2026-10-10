import { AutomationAtomPropsSchema, AutomationRunHistorySchema } from '@veduta/protocol'
import type { ReactNode } from 'react'
import { ActionFeedback, useActionFeedback, type AtomMotionAttributes } from './action-feedback.tsx'
import { boundValue, motionContent, text } from './atom-helpers.ts'
import { bodyTextStyle } from './atom-styles.ts'
import { BadgeAtom } from './atoms-content.tsx'
import { tokensFor } from './design-system.ts'
import type { AtomProps, RenderableAtomProps } from './types.ts'
import { Item } from './ui/item.tsx'
import { Switch } from './ui/switch.tsx'
import { AutomationScheduleDescription } from './automation-schedule.tsx'
import { AutomationRunHistory } from './automation-run-history.tsx'

function ListItemControl({
  node,
  ctx,
  ...motion
}: AtomProps<'ListItem'> & AtomMotionAttributes): ReactNode {
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
            id: `${node.id}-status`,
            type: 'Badge',
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

export function ListItemAtom(props: AtomProps<'ListItem'>): ReactNode {
  return <ListItemControl {...props} />
}

function AutomationControl({
  node,
  ctx,
  ...motion
}: AtomProps<'Automation'> & AtomMotionAttributes): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const feedback = useActionFeedback({ node, ctx })
  const enabled = Boolean(boundValue(node, ctx) ?? node.props?.['enabled'])
  const action = node.actions?.[0]
  const label = node.props.label
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
            overflowWrap: 'anywhere',
          }}
        >
          <AutomationScheduleDescription
            schedule={node.props.schedule}
            details={node.props.scheduleDetails}
            enabled={enabled}
          />
        </div>
        <AutomationRunHistory history={history} theme={ctx.theme} />
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

export function AutomationAtom(props: AtomProps<'Automation'>): ReactNode {
  return <AutomationControl {...props} />
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
