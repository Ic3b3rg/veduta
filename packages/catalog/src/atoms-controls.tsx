import type { ReactNode } from 'react'
import {
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
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from './ui/combobox.tsx'
import { Label } from './ui/label.tsx'
import { Switch } from './ui/switch.tsx'

export function SwitchAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const action = findAction(node, ['toggle'])
  return (
    <Label style={inlineControlStyle(tokens)}>
      <Switch
        {...motionContent('value')}
        checked={boundValue(node, ctx) === true}
        disabled={propBoolean(node.props, 'disabled', false)}
        onCheckedChange={(next) => action && ctx.dispatch(node, action.name, next)}
      />
      <span {...motionContent('label')}>{text(node.props?.['label'])}</span>
    </Label>
  )
}

export function ComboboxAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const options = choicesFrom(node.props?.['options'])
  const selected = options.find((option) => option.value === boundValue(node, ctx)) ?? null
  const action = findAction(node, ['change'])
  return (
    <div style={fieldStyle(tokens)}>
      <Label {...motionContent('label')} htmlFor={node.id} style={labelStyle(tokens)}>
        {text(node.props?.['label'])}
      </Label>
      <Combobox
        items={options}
        value={selected}
        itemToStringValue={(option) => option.label}
        onValueChange={(next) => next && action && ctx.dispatch(node, action.name, next.value)}
      >
        <ComboboxInput
          {...motionContent('value')}
          id={node.id}
          aria-label={text(node.props?.['label'])}
          placeholder={optionalText(node.props?.['placeholder']) ?? 'Search options…'}
          disabled={propBoolean(node.props, 'disabled', false)}
          className="w-full"
        />
        <ComboboxContent>
          <ComboboxEmpty>
            {optionalText(node.props?.['emptyText']) ?? 'No options found.'}
          </ComboboxEmpty>
          <ComboboxList>
            {(option) => (
              <ComboboxItem key={option.value} value={option}>
                {option.label}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  )
}

export {
  ButtonAtom,
  CheckboxAtom,
  SelectAtom,
  RadioGroupAtom,
  DatePickerAtom,
} from './atoms-selection.tsx'
