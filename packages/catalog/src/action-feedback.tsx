import {
  canonicalJson,
  fastActionInputsSchema,
  owningActionInputs,
  type JsonObject,
  type JsonValue,
} from '@veduta/protocol'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { boundValue } from './atom-helpers.ts'
import { tokensFor } from './design-system.ts'
import type { AtomProps, RenderContext } from './types.ts'

interface ControlAttempt {
  revision: string | undefined
  inputs: string
  confirmed: boolean
}

export interface AtomMotionAttributes {
  'data-veduta-atom-id'?: string
  'data-veduta-motion-id'?: string
}

/** Local feedback observes canonical confirmations; the host owns execution and retry. */
export function useActionFeedback({ node, ctx }: AtomProps) {
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
  const ownsValue = Object.hasOwn(owningActionInputs(node), 'value')

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
    if (ownsValue && next === value) return
    const inputs: JsonObject = ownsValue ? { value: next ?? null } : {}
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
      if (ownsValue) await ctx.dispatch(node, action.name, next)
      else await ctx.dispatch(node, action.name)
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

  return {
    dispatch,
    pending,
    error,
    errorId,
    disabled: node.props?.['disabled'] === true || pending,
    attributes: {
      'aria-busy': pending || undefined,
      'aria-invalid': error ? true : undefined,
      'aria-describedby': error ? errorId : undefined,
    } as const,
  }
}

export function ActionFeedback({
  feedback,
  ctx,
  children,
  'data-veduta-atom-id': atomId,
  'data-veduta-motion-id': motionId,
}: AtomMotionAttributes & {
  feedback: Pick<ReturnType<typeof useActionFeedback>, 'pending' | 'error' | 'errorId'>
  ctx: RenderContext
  children: ReactNode
}): ReactNode {
  const tokens = tokensFor(ctx.theme)
  return (
    <div
      data-veduta-atom-id={atomId}
      data-veduta-motion-id={motionId}
      style={{ display: 'grid', gap: tokens.space.xs }}
    >
      {children}
      {feedback.pending && (
        <span role="status" aria-live="polite">
          Working…
        </span>
      )}
      {feedback.error && (
        <div id={feedback.errorId} role="alert" style={{ color: tokens.color.danger }}>
          {feedback.error}
        </div>
      )}
    </div>
  )
}
