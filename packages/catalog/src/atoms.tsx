import type { CSSProperties, FormEvent, ReactNode } from 'react'
import {
  actionValue,
  align,
  boundValue,
  boundedNumber,
  choicesFrom,
  dataPoints,
  findAction,
  humanLabel,
  iconGlyph,
  optionalText,
  propBoolean,
  ratioValue,
  spacing,
  tableColumns,
  tableRows,
  text,
  toneColor,
} from './atom-helpers.ts'
import {
  bodyTextStyle,
  buttonStyle,
  controlStyle,
  fieldStyle,
  inlineControlStyle,
  labelStyle,
  listItemStyle,
  surfaceStyle,
  switchKnobStyle,
  switchStyle,
  tableCellStyle,
  tableHeaderStyle,
} from './atom-styles.ts'
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

export function TitleAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const level = boundedNumber(node.props?.['level'], 2, 1, 6)
  const content = text(node.props?.['text'])
  const style: CSSProperties = {
    margin: 0,
    color: tokens.color.text,
    fontFamily: tokens.font.family,
    fontSize: level <= 2 ? tokens.font.xl : tokens.font.lg,
    lineHeight: 1.2,
    fontWeight: 700,
  }

  if (level === 1) return <h1 style={style}>{content}</h1>
  if (level === 2) return <h2 style={style}>{content}</h2>
  if (level === 3) return <h3 style={style}>{content}</h3>
  if (level === 4) return <h4 style={style}>{content}</h4>
  if (level === 5) return <h5 style={style}>{content}</h5>
  return <h6 style={style}>{content}</h6>
}

export function TextAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  return <p style={bodyTextStyle(tokens)}>{text(node.props?.['text'])}</p>
}

export function CaptionAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  return (
    <small
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
  if (!htmlFor) return <span style={labelStyle(tokens)}>{content}</span>
  return (
    <label htmlFor={htmlFor} style={labelStyle(tokens)}>
      {content}
    </label>
  )
}

export function MarkdownAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  return (
    <div style={{ display: 'grid', gap: tokens.space.xs }}>
      {text(node.props?.['text'])
        .split(/\n{2,}/)
        .map((paragraph, index) => (
          <p key={index} style={bodyTextStyle(tokens)}>
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
    <span
      style={{
        alignSelf: 'flex-start',
        border: `1px solid ${tone}`,
        borderRadius: 999,
        color: tone,
        fontFamily: tokens.font.family,
        fontSize: tokens.font.xs,
        fontWeight: 650,
        lineHeight: 1,
        padding: `${tokens.space.xs}px ${tokens.space.sm}px`,
      }}
    >
      {text(content)}
    </span>
  )
}

export function IconAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const label = optionalText(node.props?.['label'])
  return (
    <span
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
      <div style={labelStyle(tokens)}>{text(node.props?.['label'])}</div>
      <div
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
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(ratio * 100)}
      style={{ display: 'grid', gap: tokens.space.xs }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: tokens.space.sm }}>
        <span style={labelStyle(tokens)}>{label}</span>
        <span style={{ ...labelStyle(tokens), color: tokens.color.text }}>
          {Math.round(ratio * 100)}%
        </span>
      </div>
      <div
        style={{
          background: tokens.color.surfaceMuted,
          borderRadius: tokens.radius.sm,
          height: 8,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            background: tokens.color.accent,
            borderRadius: tokens.radius.sm,
            height: '100%',
            transition: `width ${tokens.motion.fast}`,
            width: `${ratio * 100}%`,
          }}
        />
      </div>
    </div>
  )
}

export function CheckboxAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const checked = Boolean(boundValue(node, ctx))
  const action = findAction(node, ['toggle', 'change'])
  return (
    <label style={inlineControlStyle(tokens)}>
      <input
        type="checkbox"
        checked={checked}
        onChange={() => action && ctx.dispatch(node, action.name, !checked)}
        style={{ minHeight: 20, minWidth: 20 }}
      />
      <span>{text(node.props?.['label'])}</span>
    </label>
  )
}

export function ButtonAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const action = findAction(node, ['press', 'click', 'submit', 'regenerate']) ?? node.actions?.[0]
  const disabled = propBoolean(node.props, 'disabled', false)
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => action && ctx.dispatch(node, action.name, actionValue(action))}
      style={buttonStyle(tokens, optionalText(node.props?.['variant']), disabled)}
    >
      {text(node.props?.['label'] ?? node.props?.['text'] ?? action?.name)}
    </button>
  )
}

export function DatePickerAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const value = text(boundValue(node, ctx) ?? node.props?.['value'])
  const action = findAction(node, ['change', 'select', 'set'])
  return (
    <label style={fieldStyle(tokens)}>
      <span style={labelStyle(tokens)}>{text(node.props?.['label'])}</span>
      <input
        aria-label={text(node.props?.['label'])}
        type="date"
        value={value}
        onChange={(event) => action && ctx.dispatch(node, action.name, event.currentTarget.value)}
        style={controlStyle(tokens)}
      />
    </label>
  )
}

export function SelectAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const value = text(boundValue(node, ctx) ?? node.props?.['value'])
  const action = findAction(node, ['change', 'select', 'set'])
  return (
    <label style={fieldStyle(tokens)}>
      <span style={labelStyle(tokens)}>{text(node.props?.['label'])}</span>
      <select
        aria-label={text(node.props?.['label'])}
        value={value}
        onChange={(event) => action && ctx.dispatch(node, action.name, event.currentTarget.value)}
        style={controlStyle(tokens)}
      >
        {choicesFrom(node.props?.['options']).map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function RadioGroupAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const value = text(boundValue(node, ctx) ?? node.props?.['value'])
  const action = findAction(node, ['change', 'select', 'set'])
  const name = `${node.id}-radio`
  return (
    <fieldset
      style={{
        border: 0,
        display: 'grid',
        gap: tokens.space.sm,
        margin: 0,
        padding: 0,
      }}
    >
      <legend style={labelStyle(tokens)}>{text(node.props?.['label'])}</legend>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.space.sm }}>
        {choicesFrom(node.props?.['options']).map((choice) => (
          <label key={choice.value} style={inlineControlStyle(tokens)}>
            <input
              type="radio"
              name={name}
              value={choice.value}
              checked={value === choice.value}
              onChange={() => action && ctx.dispatch(node, action.name, choice.value)}
              style={{ minHeight: 20, minWidth: 20 }}
            />
            {choice.label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

export function InputAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const value = text(boundValue(node, ctx) ?? node.props?.['value'])
  const action = findAction(node, ['change', 'input', 'set'])
  return (
    <label style={fieldStyle(tokens)}>
      <span style={labelStyle(tokens)}>{text(node.props?.['label'])}</span>
      <input
        aria-label={text(node.props?.['label'])}
        type={optionalText(node.props?.['inputType']) ?? 'text'}
        placeholder={optionalText(node.props?.['placeholder'])}
        value={value}
        onChange={(event) => action && ctx.dispatch(node, action.name, event.currentTarget.value)}
        style={controlStyle(tokens)}
      />
    </label>
  )
}

export function TextareaAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const value = text(boundValue(node, ctx) ?? node.props?.['value'])
  const action = findAction(node, ['change', 'input', 'set'])
  return (
    <label style={fieldStyle(tokens)}>
      <span style={labelStyle(tokens)}>{text(node.props?.['label'])}</span>
      <textarea
        aria-label={text(node.props?.['label'])}
        placeholder={optionalText(node.props?.['placeholder'])}
        value={value}
        onChange={(event) => action && ctx.dispatch(node, action.name, event.currentTarget.value)}
        rows={boundedNumber(node.props?.['rows'], 3, 2, 12)}
        style={{ ...controlStyle(tokens), resize: 'vertical' }}
      />
    </label>
  )
}

export function FormAtom({ node, ctx, children }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const action = findAction(node, ['submit'])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (action) ctx.dispatch(node, action.name, actionValue(action))
  }
  return (
    <form
      aria-label={optionalText(node.props?.['label'])}
      onSubmit={submit}
      style={{
        display: 'grid',
        gap: tokens.space.md,
      }}
    >
      {children}
    </form>
  )
}

export function TableAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const rows = tableRows(boundValue(node, ctx) ?? node.props?.['rows'])
  const columns = tableColumns(node.props?.['columns'], rows)
  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        style={{
          borderCollapse: 'collapse',
          color: tokens.color.text,
          minWidth: 320,
          width: '100%',
        }}
      >
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col" style={tableHeaderStyle(tokens)}>
                {humanLabel(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((column) => (
                <td key={column} style={tableCellStyle(tokens)}>
                  {text(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ImageAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const src = optionalText(node.props?.['src'])
  const alt = optionalText(node.props?.['alt']) ?? optionalText(node.props?.['label']) ?? ''
  if (!src) {
    return (
      <div
        role="img"
        aria-label={alt || 'Image placeholder'}
        style={{
          ...surfaceStyle(tokens),
          alignItems: 'center',
          aspectRatio: '16 / 9',
          color: tokens.color.textMuted,
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        {alt || 'Image'}
      </div>
    )
  }
  return (
    <img
      alt={alt}
      src={src}
      style={{
        borderRadius: tokens.radius.md,
        display: 'block',
        maxWidth: '100%',
        objectFit: 'cover',
      }}
    />
  )
}

export function ChartAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const points = dataPoints(boundValue(node, ctx) ?? node.props?.['data'])
  const max = Math.max(...points.map((point) => point.value), 1)
  return (
    <div
      role="img"
      aria-label={text(node.props?.['label'] ?? 'Chart')}
      style={{
        ...surfaceStyle(tokens),
        display: 'flex',
        alignItems: 'flex-end',
        gap: tokens.space.sm,
        minHeight: 132,
        padding: tokens.space.md,
      }}
    >
      {points.map((point) => (
        <div
          key={point.label}
          style={{
            alignItems: 'center',
            display: 'flex',
            flex: 1,
            flexDirection: 'column',
            gap: tokens.space.xs,
            minWidth: 28,
          }}
        >
          <div
            aria-hidden="true"
            title={`${point.label}: ${point.value}`}
            style={{
              background: tokens.color.accent,
              borderRadius: `${tokens.radius.sm}px ${tokens.radius.sm}px 0 0`,
              height: `${Math.max(8, (point.value / max) * 88)}px`,
              width: '100%',
            }}
          />
          <span style={{ ...labelStyle(tokens), textAlign: 'center' }}>{point.label}</span>
        </div>
      ))}
    </div>
  )
}

export function TransitionAtom({ node, ctx, children }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  return (
    <div
      style={{
        opacity: propBoolean(node.props, 'visible', true) ? 1 : 0.4,
        transition: `opacity ${tokens.motion.fast}`,
      }}
    >
      {children}
    </div>
  )
}

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

  if (!action) {
    return <div style={listItemStyle(tokens)}>{content}</div>
  }

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
