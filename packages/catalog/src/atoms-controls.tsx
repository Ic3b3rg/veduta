import type { ReactNode } from 'react'
import { ActionFeedback, useActionFeedback, type AtomMotionAttributes } from './action-feedback.tsx'
import { boundValue, choicesFrom, motionContent, optionalText, text } from './atom-helpers.ts'
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

function SwitchControl({
  node,
  ctx,
  ...motion
}: AtomProps<'Switch'> & AtomMotionAttributes): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const feedback = useActionFeedback({ node, ctx })
  return (
    <ActionFeedback {...motion} feedback={feedback} ctx={ctx}>
      <Label style={inlineControlStyle(tokens)}>
        <Switch
          {...motionContent('value')}
          {...feedback.attributes}
          checked={boundValue(node, ctx) === true}
          disabled={feedback.disabled}
          onCheckedChange={(next) => void feedback.dispatch(next)}
        />
        <span {...motionContent('label')}>{text(node.props?.['label'])}</span>
      </Label>
    </ActionFeedback>
  )
}

export function SwitchAtom(props: AtomProps<'Switch'>): ReactNode {
  return <SwitchControl {...props} />
}

function ComboboxControl({
  node,
  ctx,
  ...motion
}: AtomProps<'Combobox'> & AtomMotionAttributes): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const feedback = useActionFeedback({ node, ctx })
  const options = choicesFrom(node.props?.['options'])
  const selected = options.find((option) => option.value === boundValue(node, ctx)) ?? null
  return (
    <ActionFeedback {...motion} feedback={feedback} ctx={ctx}>
      <div style={fieldStyle(tokens)}>
        <Label {...motionContent('label')} htmlFor={node.id} style={labelStyle(tokens)}>
          {text(node.props?.['label'])}
        </Label>
        <Combobox
          items={options}
          value={selected}
          disabled={feedback.disabled}
          itemToStringValue={(option) => option.value}
          onValueChange={(next) => next && void feedback.dispatch(next.value)}
        >
          <ComboboxInput
            {...motionContent('value')}
            {...feedback.attributes}
            id={node.id}
            aria-label={text(node.props?.['label'])}
            placeholder={optionalText(node.props?.['placeholder']) ?? 'Search options…'}
            disabled={feedback.disabled}
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
    </ActionFeedback>
  )
}

export function ComboboxAtom(props: AtomProps<'Combobox'>): ReactNode {
  return <ComboboxControl {...props} />
}

export {
  ButtonAtom,
  CheckboxAtom,
  SelectAtom,
  RadioGroupAtom,
  DatePickerAtom,
} from './atoms-selection.tsx'
