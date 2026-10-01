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

type ControlAttempt = { confirmed: boolean } & (
  | { path: 'fast'; revision: string | undefined; inputs: string }
  | { path: 'agent'; payload: string }
)

export interface AtomMotionAttributes {
  'data-veduta-atom-id'?: string
  'data-veduta-motion-id'?: string
}

/** Local feedback observes canonical confirmations; the host owns execution and retry. */
export function useActionFeedback({ node, ctx }: AtomProps) {
  const errorId = useId()
  const [pending, setPending] = useState(false)
  const [localError, setError] = useState<string>()
  const pendingRef = useRef(false)
  const currentAttempt = useRef<ControlAttempt | undefined>(undefined)
  const acknowledged = useRef<string | undefined>(undefined)
  const action = node.actions?.[0]
  const { acknowledgeAction } = ctx
  const confirmation = action ? ctx.actionConfirmations?.[node.id]?.[action.name] : undefined
  const runtimeStatus =
    action?.path === 'agent' ? ctx.actionStatuses?.[node.id]?.[action.name] : undefined
  const waiting = pending || runtimeStatus?.status === 'pending'
  const queued = !waiting && runtimeStatus?.status === 'queued'
  const error = waiting ? undefined : runtimeStatus ? runtimeStatus.message : localError
  const value = boundValue(node, ctx)
  const ownsValue = Object.hasOwn(owningActionInputs(node), 'value')

  useEffect(() => {
    if (
      !action ||
      !confirmation ||
      (action.path === 'fast'
        ? confirmation.path === 'agent' || confirmation.actionRevision !== action.revision
        : confirmation.path !== 'agent') ||
      acknowledged.current === confirmation.intentId
    )
      return
    acknowledged.current = confirmation.intentId
    const attempt = currentAttempt.current
    if (
      attempt &&
      (confirmation.path === 'agent'
        ? attempt.path === 'agent' && attempt.payload === canonicalJson(confirmation.payload)
        : attempt.path === 'fast' &&
          attempt.revision === confirmation.actionRevision &&
          attempt.inputs === canonicalJson(confirmation.inputs))
    ) {
      attempt.confirmed = true
      pendingRef.current = false
      setPending(false)
      setError(undefined)
    }
    acknowledgeAction?.(node.id, action.name, confirmation.intentId)
  }, [action, confirmation, acknowledgeAction, node.id])

  const dispatch = async (next?: JsonValue) => {
    if (!action || node.props?.['disabled'] === true || pendingRef.current || waiting) return
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
    const attempt: ControlAttempt =
      action.path === 'fast'
        ? {
            path: 'fast',
            revision: action.revision,
            inputs: canonicalJson(inputs),
            confirmed: false,
          }
        : {
            path: 'agent',
            payload: canonicalJson(ownsValue ? { ...action.payload, ...inputs } : action.payload),
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
    pending: waiting,
    queued,
    error,
    errorId,
    disabled: node.props?.['disabled'] === true || waiting,
    attributes: {
      'aria-busy': waiting || undefined,
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
  feedback: Pick<ReturnType<typeof useActionFeedback>, 'pending' | 'queued' | 'error' | 'errorId'>
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
      {feedback.queued && (
        <span role="status" aria-live="polite">
          Queued. Awaiting confirmation.
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
