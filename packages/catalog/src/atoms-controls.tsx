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
import { fieldStyle, inlineControlStyle, labelStyle } from './atom-styles.ts'
import { tokensFor } from './design-system.ts'
import type { AtomProps } from './types.ts'
import { Button } from './ui/button.tsx'
import { Checkbox } from './ui/checkbox.tsx'
import { Input } from './ui/input.tsx'
import { Label } from './ui/label.tsx'
import { NativeSelect } from './ui/native-select.tsx'
import { RadioGroup, RadioGroupItem } from './ui/radio-group.tsx'

export function CheckboxAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const checked = Boolean(boundValue(node, ctx))
  const action = findAction(node, ['toggle', 'change'])
  return (
    <Label style={inlineControlStyle(tokens)}>
      <Checkbox
        {...motionContent('value')}
        checked={checked}
        onCheckedChange={(next) => action && ctx.dispatch(node, action.name, next === true)}
        className="size-5"
      />
      <span {...motionContent('label')}>{text(node.props?.['label'])}</span>
    </Label>
  )
}

export function ButtonAtom({ node, ctx }: AtomProps): ReactNode {
  const action = findAction(node, ['press', 'click', 'submit', 'regenerate']) ?? node.actions?.[0]
  const disabled = propBoolean(node.props, 'disabled', false)
  const variant = optionalText(node.props?.['variant'])
  return (
    <Button
      {...motionContent('content')}
      type="button"
      disabled={disabled}
      onClick={() => action && ctx.dispatch(node, action.name, actionValue(action))}
      variant={variant === 'secondary' || variant === 'ghost' ? variant : 'default'}
    >
      {text(node.props?.['label'] ?? node.props?.['text'] ?? action?.name)}
    </Button>
  )
}

export function DatePickerAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const value = text(boundValue(node, ctx) ?? node.props?.['value'])
  const action = findAction(node, ['change', 'select', 'set'])
  return (
    <Label style={fieldStyle(tokens)}>
      <span {...motionContent('label')} style={labelStyle(tokens)}>
        {text(node.props?.['label'])}
      </span>
      <Input
        {...motionContent('value')}
        aria-label={text(node.props?.['label'])}
        type="date"
        value={value}
        onChange={(event) => action && ctx.dispatch(node, action.name, event.currentTarget.value)}
      />
    </Label>
  )
}

export function SelectAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const value = text(boundValue(node, ctx) ?? node.props?.['value'])
  const action = findAction(node, ['change', 'select', 'set'])
  return (
    <Label style={fieldStyle(tokens)}>
      <span {...motionContent('label')} style={labelStyle(tokens)}>
        {text(node.props?.['label'])}
      </span>
      <NativeSelect
        {...motionContent('value', { signature: `value:${value}` })}
        aria-label={text(node.props?.['label'])}
        value={value}
        onChange={(event) => action && ctx.dispatch(node, action.name, event.currentTarget.value)}
        className="w-full"
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
      </NativeSelect>
    </Label>
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
      <RadioGroup
        name={name}
        value={value}
        onValueChange={(next) => action && ctx.dispatch(node, action.name, next)}
        style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.space.sm }}
      >
        {choicesFrom(node.props?.['options']).map((choice) => (
          <Label
            key={choice.value}
            {...motionContent(`option:${choice.value}`)}
            style={inlineControlStyle(tokens)}
          >
            <RadioGroupItem value={choice.value} className="size-5" />
            {choice.label}
          </Label>
        ))}
      </RadioGroup>
    </fieldset>
  )
}
