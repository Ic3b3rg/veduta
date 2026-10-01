import {
  canonicalJson,
  fastActionInputsSchema,
  type JsonObject,
  type JsonValue,
} from '@veduta/protocol'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { boundValue, choicesFrom, motionContent, optionalText, text } from './atom-helpers.ts'
import { fieldStyle, inlineControlStyle, labelStyle } from './atom-styles.ts'
import { tokensFor } from './design-system.ts'
import type { AtomProps } from './types.ts'
import { Button } from './ui/button.tsx'
import { Checkbox } from './ui/checkbox.tsx'
import { Input } from './ui/input.tsx'
import { Label } from './ui/label.tsx'
import { NativeSelect } from './ui/native-select.tsx'
import { RadioGroup, RadioGroupItem } from './ui/radio-group.tsx'

interface ControlAttempt {
  revision: string | undefined
  inputs: string
  confirmed: boolean
}

/** Local feedback observes the host's canonical confirmation; the host owns execution and retry. */
function ActionControl({
  node,
  ctx,
  'data-veduta-atom-id': atomId,
  'data-veduta-motion-id': motionId,
}: AtomProps & {
  'data-veduta-atom-id'?: string
  'data-veduta-motion-id'?: string
}): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const errorId = useId()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const pendingRef = useRef(false)
  const currentAttempt = useRef<ControlAttempt | undefined>(undefined)
  const acknowledged = useRef<string | undefined>(undefined)
  const action = node.actions?.[0]
  const { acknowledgeAction } = ctx
  const confirmation = action ? ctx.actionConfirmations?.[node.id]?.[action.name] : undefined
  const value = boundValue(node, ctx)
  const label = text(node.props?.['label'])
  const disabled = node.props?.['disabled'] === true || pending

  useEffect(() => {
    if (
      !action ||
      action.path !== 'fast' ||
      !confirmation ||
      confirmation.actionRevision !== action.revision ||
      acknowledged.current === confirmation.intentId
    )
      return
    acknowledged.current = confirmation.intentId
    const attempt = currentAttempt.current
    if (
      attempt?.revision === confirmation.actionRevision &&
      attempt.inputs === canonicalJson(confirmation.inputs)
    ) {
      attempt.confirmed = true
      pendingRef.current = false
      setPending(false)
      setError(undefined)
    }
    acknowledgeAction?.(node.id, action.name, confirmation.intentId)
  }, [action, confirmation, acknowledgeAction, node.id])

  const dispatch = async (next?: JsonValue) => {
    if (!action || node.props?.['disabled'] === true || pendingRef.current) return
    if (node.type !== 'Button' && next === value) return
    const inputs: JsonObject = node.type === 'Button' ? {} : { value: next ?? null }
    if (action.path === 'fast' && !fastActionInputsSchema(node, action).safeParse(inputs).success) {
      setError(
        node.type === 'DatePicker'
          ? 'Choose a valid calendar date.'
          : 'Choose one of the offered values.',
      )
      return
    }
    const attempt: ControlAttempt = {
      revision: action.path === 'fast' ? action.revision : undefined,
      inputs: canonicalJson(inputs),
      confirmed: false,
    }
    currentAttempt.current = attempt
    pendingRef.current = true
    setPending(true)
    setError(undefined)
    try {
      if (node.type === 'Button') await ctx.dispatch(node, action.name)
      else await ctx.dispatch(node, action.name, next)
    } catch (failure) {
      if (!attempt.confirmed && currentAttempt.current === attempt) {
        setError(
          failure instanceof Error && failure.message.trim()
            ? failure.message
            : 'Could not save changes. Try again.',
        )
      }
    } finally {
      if (currentAttempt.current === attempt) {
        pendingRef.current = false
        setPending(false)
      }
    }
  }

  const feedback = {
    'aria-busy': pending || undefined,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? errorId : undefined,
  } as const
  let control: ReactNode
  if (node.type === 'Button') {
    const variant = optionalText(node.props?.['variant'])
    control = (
      <Button
        {...motionContent('content')}
        {...feedback}
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
          {...feedback}
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
          {...feedback}
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
          <Input
            {...motionContent('value')}
            {...feedback}
            aria-label={label}
            type="date"
            required={node.props?.['allowEmpty'] !== true}
            disabled={disabled}
            value={text(value)}
            onChange={(event) => void dispatch(event.currentTarget.value)}
          />
        ) : (
          <NativeSelect
            {...motionContent('value', { signature: `value:${text(value)}` })}
            {...feedback}
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
    <div
      data-veduta-atom-id={atomId}
      data-veduta-motion-id={motionId}
      style={{ display: 'grid', gap: tokens.space.xs }}
    >
      {control}
      {pending && (
        <span role="status" aria-live="polite">
          Working…
        </span>
      )}
      {error && (
        <div id={errorId} role="alert" style={{ color: tokens.color.danger }}>
          {error}
        </div>
      )}
    </div>
  )
}

export function ButtonAtom(props: AtomProps): ReactNode {
  return <ActionControl {...props} />
}
export function CheckboxAtom(props: AtomProps): ReactNode {
  return <ActionControl {...props} />
}
export function SelectAtom(props: AtomProps): ReactNode {
  return <ActionControl {...props} />
}
export function RadioGroupAtom(props: AtomProps): ReactNode {
  return <ActionControl {...props} />
}
export function DatePickerAtom(props: AtomProps): ReactNode {
  return <ActionControl {...props} />
}
