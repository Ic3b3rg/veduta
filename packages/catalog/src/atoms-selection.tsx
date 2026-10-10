import type { ReactNode } from 'react'
import { ActionFeedback, useActionFeedback, type AtomMotionAttributes } from './action-feedback.tsx'
import { boundValue, choicesFrom, motionContent, optionalText, text } from './atom-helpers.ts'
import { fieldStyle, inlineControlStyle, labelStyle } from './atom-styles.ts'
import { tokensFor } from './design-system.ts'
import type { AtomProps } from './types.ts'
import { Button } from './ui/button.tsx'
import { Checkbox } from './ui/checkbox.tsx'
import { DatePicker } from './ui/date-picker.tsx'
import { Label } from './ui/label.tsx'
import { NativeSelect } from './ui/native-select.tsx'
import { RadioGroup, RadioGroupItem } from './ui/radio-group.tsx'

function ActionControl({
  node,
  ctx,
  ...motion
}: AtomProps<'Button' | 'Checkbox' | 'Select' | 'RadioGroup' | 'DatePicker'> &
  AtomMotionAttributes): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const feedback = useActionFeedback({ node, ctx })
  const { dispatch, disabled, attributes } = feedback
  const value = boundValue(node, ctx)
  const label = text(node.props?.['label'])
  let control: ReactNode
  if (node.type === 'Button') {
    const variant = optionalText(node.props?.['variant'])
    control = (
      <Button
        {...motionContent('content')}
        {...attributes}
        type="button"
        disabled={disabled}
        onClick={() => void dispatch()}
        variant={variant === 'secondary' || variant === 'ghost' ? variant : 'default'}
      >
        {label}
      </Button>
    )
  } else if (node.type === 'Checkbox') {
    control = (
      <Label style={inlineControlStyle(tokens)}>
        <Checkbox
          {...motionContent('value')}
          {...attributes}
          disabled={disabled}
          checked={value === true}
          onCheckedChange={(next) => void dispatch(next === true)}
          className="size-5"
        />
        <span {...motionContent('label')}>{label}</span>
      </Label>
    )
  } else if (node.type === 'RadioGroup') {
    control = (
      <fieldset
        disabled={disabled}
        style={{ border: 0, display: 'grid', gap: tokens.space.sm, margin: 0, padding: 0 }}
      >
        <legend {...motionContent('label')} style={labelStyle(tokens)}>
          {label}
        </legend>
        <RadioGroup
          {...attributes}
          aria-label={label}
          disabled={disabled}
          name={`${node.id}-radio`}
          value={text(value)}
          onValueChange={(next) => void dispatch(next)}
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
  } else {
    control = (
      <Label style={fieldStyle(tokens)}>
        <span {...motionContent('label')} style={labelStyle(tokens)}>
          {label}
        </span>
        {node.type === 'DatePicker' ? (
          <DatePicker
            {...motionContent('value')}
            {...attributes}
            aria-label={label}
            allowEmpty={node.props?.['allowEmpty'] === true}
            disabled={disabled}
            value={text(value)}
            onValueChange={(next) => void dispatch(next)}
          />
        ) : (
          <NativeSelect
            {...motionContent('value', { signature: `value:${text(value)}` })}
            {...attributes}
            aria-label={label}
            disabled={disabled}
            value={text(value)}
            onChange={(event) => void dispatch(event.currentTarget.value)}
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
        )}
      </Label>
    )
  }
  return (
    <ActionFeedback {...motion} feedback={feedback} ctx={ctx}>
      {control}
    </ActionFeedback>
  )
}

export function ButtonAtom(props: AtomProps<'Button'>): ReactNode {
  return <ActionControl {...props} />
}
export function CheckboxAtom(props: AtomProps<'Checkbox'>): ReactNode {
  return <ActionControl {...props} />
}
export function SelectAtom(props: AtomProps<'Select'>): ReactNode {
  return <ActionControl {...props} />
}
export function RadioGroupAtom(props: AtomProps<'RadioGroup'>): ReactNode {
  return <ActionControl {...props} />
}
export function DatePickerAtom(props: AtomProps<'DatePicker'>): ReactNode {
  return <ActionControl {...props} />
}
