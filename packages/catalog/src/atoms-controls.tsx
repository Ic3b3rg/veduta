import type { FormEvent, ReactNode } from 'react'
import {
  actionValue,
  boundValue,
  boundedNumber,
  choicesFrom,
  findAction,
  optionalText,
  propBoolean,
  text,
} from './atom-helpers.ts'
import {
  buttonStyle,
  controlStyle,
  fieldStyle,
  inlineControlStyle,
  labelStyle,
} from './atom-styles.ts'
import { tokensFor } from './design-system.ts'
import type { AtomProps } from './types.ts'

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
    <fieldset style={{ border: 0, display: 'grid', gap: tokens.space.sm, margin: 0, padding: 0 }}>
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
      style={{ display: 'grid', gap: tokens.space.md }}
    >
      {children}
    </form>
  )
}
