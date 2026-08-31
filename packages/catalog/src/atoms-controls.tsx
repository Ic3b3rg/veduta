import type { ReactNode } from 'react'
import {
  actionValue,
  boundValue,
  choicesFrom,
  findAction,
  motionContent,
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
        {...motionContent('value')}
        type="checkbox"
        checked={checked}
        onChange={() => action && ctx.dispatch(node, action.name, !checked)}
        style={{ minHeight: 20, minWidth: 20 }}
      />
      <span {...motionContent('label')}>{text(node.props?.['label'])}</span>
    </label>
  )
}

export function ButtonAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const action = findAction(node, ['press', 'click', 'submit', 'regenerate']) ?? node.actions?.[0]
  const disabled = propBoolean(node.props, 'disabled', false)
  return (
    <button
      {...motionContent('content')}
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
      <span {...motionContent('label')} style={labelStyle(tokens)}>
        {text(node.props?.['label'])}
      </span>
      <input
        {...motionContent('value')}
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
      <span {...motionContent('label')} style={labelStyle(tokens)}>
        {text(node.props?.['label'])}
      </span>
      <select
        {...motionContent('value', { signature: `value:${value}` })}
        aria-label={text(node.props?.['label'])}
        value={value}
        onChange={(event) => action && ctx.dispatch(node, action.name, event.currentTarget.value)}
        style={controlStyle(tokens)}
      >
        {choicesFrom(node.props?.['options']).map((choice) => (
          <option
            key={choice.value}
            {...motionContent(`option:${choice.value}`)}
            value={choice.value}
          >
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
      <legend {...motionContent('label')} style={labelStyle(tokens)}>
        {text(node.props?.['label'])}
      </legend>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.space.sm }}>
        {choicesFrom(node.props?.['options']).map((choice) => (
          <label
            key={choice.value}
            {...motionContent(`option:${choice.value}`)}
            style={inlineControlStyle(tokens)}
          >
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
