import type { FormEvent, ReactNode } from 'react'
import {
  canonicalJson,
  owningActionInputs,
  type ActionScalarSpec,
  type JsonObject,
} from '@veduta/protocol'
import { boundValue, boundedNumber, motionContent, optionalText, text } from './atom-helpers.ts'
import { fieldStyle, labelStyle } from './atom-styles.ts'
import { tokensFor } from './design-system.ts'
import type { AtomProps, RenderContext } from './types.ts'
import { Button } from './ui/button.tsx'
import { Input } from './ui/input.tsx'
import { Label } from './ui/label.tsx'
import { Textarea } from './ui/textarea.tsx'

const FORM_FIELD_SELECTOR = '[data-veduta-form-field]'
const FORM_ERROR_SELECTOR = '[data-veduta-form-error]'
const FORM_SUBMIT_SELECTOR = '[data-veduta-form-submit]'

interface SubmittedDraft {
  actionName: string
  actionRevision: string | undefined
  fingerprint: string
  editGeneration: number
  confirmed: boolean
}

interface FormDraftState {
  editGeneration: number
  submissions: Map<string, SubmittedDraft>
  acknowledgedIntentId?: string
  current?: SubmittedDraft
  pending?: SubmittedDraft
}

const formDrafts = new WeakMap<HTMLFormElement, FormDraftState>()

export function InputAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const value = text(boundValue(node, ctx))
  const label = text(node.props?.['label'])
  return (
    <Label style={fieldStyle(tokens)}>
      <span {...motionContent('label')} style={labelStyle(tokens)}>
        {label}
      </span>
      <Input
        {...motionContent('value')}
        aria-label={label}
        data-veduta-form-field
        defaultValue={value}
        name={node.binding}
        onChange={(event) => markFormDirty(event.currentTarget.form)}
        placeholder={optionalText(node.props?.['placeholder'])}
        ref={(element) => reconcileCanonicalValue(element, value)}
        type={
          node.props?.['valueType'] === 'number'
            ? 'number'
            : (optionalText(node.props?.['inputType']) ?? 'text')
        }
      />
    </Label>
  )
}

export function TextareaAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const value = text(boundValue(node, ctx))
  const label = text(node.props?.['label'])
  return (
    <Label style={fieldStyle(tokens)}>
      <span {...motionContent('label')} style={labelStyle(tokens)}>
        {label}
      </span>
      <Textarea
        {...motionContent('value')}
        aria-label={label}
        data-veduta-form-field
        defaultValue={value}
        name={node.binding}
        onChange={(event) => markFormDirty(event.currentTarget.form)}
        placeholder={optionalText(node.props?.['placeholder'])}
        ref={(element) => reconcileCanonicalValue(element, value)}
        rows={boundedNumber(node.props?.['rows'], 3, 2, 12)}
      />
    </Label>
  )
}

export function FormAtom({ node, ctx, children }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const declaredAction = node.actions?.find(
    (candidate) => candidate.name === 'submit' && candidate.path === 'fast',
  )
  const action = declaredAction?.path === 'fast' ? declaredAction : undefined
  const submitLabel = text(node.props?.['submitLabel'])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    if (!action || form.dataset['vedutaSubmitting'] === 'true') return

    const draft = readFormDraft(form, owningActionInputs(node))
    if (!draft) {
      showFormError(form, 'This Form is incomplete and cannot be submitted.')
      return
    }

    clearFormError(form)
    const draftState = formDraftState(form)
    const submitted: SubmittedDraft = {
      actionName: action.name,
      actionRevision: action.revision,
      fingerprint: canonicalJson(draft),
      editGeneration: draftState.editGeneration,
      confirmed: false,
    }
    draftState.submissions.set(submitted.fingerprint, submitted)
    draftState.current = submitted
    draftState.pending = submitted
    setFormPending(form, true)
    try {
      await ctx.dispatch(node, action.name, draft)
      if (
        draftState.current === submitted &&
        draftState.editGeneration === submitted.editGeneration
      ) {
        resetFormDraft(form)
      }
    } catch (error) {
      if (!submitted.confirmed && draftState.current === submitted) {
        showFormError(form, submitErrorMessage(error))
      }
    } finally {
      if (draftState.pending === submitted) {
        delete draftState.pending
        setFormPending(form, false)
      }
    }
  }

  if (!action) {
    return (
      <div role="alert" style={{ color: tokens.color.danger }}>
        This Form has no valid submit action.
      </div>
    )
  }

  return (
    <form
      aria-label={text(node.props?.['label'])}
      noValidate
      onSubmit={submit}
      ref={(form) => reconcileFormConfirmation(form, node.id, action.name, action.revision, ctx)}
      style={{ display: 'grid', gap: tokens.space.md }}
    >
      {children}
      <div aria-live="polite" data-veduta-form-error hidden role="alert" />
      <Button {...motionContent('submit')} data-veduta-form-submit type="submit">
        {submitLabel}
      </Button>
    </form>
  )
}

function markFormDirty(form: HTMLFormElement | null): void {
  if (!form) return
  formDraftState(form).editGeneration += 1
  form.dataset['vedutaFormDirty'] = 'true'
  clearFormError(form)
}

function formDraftState(form: HTMLFormElement): FormDraftState {
  let state = formDrafts.get(form)
  if (!state) {
    state = { editGeneration: 0, submissions: new Map() }
    formDrafts.set(form, state)
  }
  return state
}

function reconcileFormConfirmation(
  form: HTMLFormElement | null,
  nodeId: string,
  actionName: string,
  actionRevision: string | undefined,
  ctx: RenderContext,
): void {
  if (!form) return
  const confirmation = ctx.actionConfirmations?.[nodeId]?.[actionName]
  if (
    !confirmation ||
    confirmation.path === 'agent' ||
    confirmation.actionRevision !== actionRevision
  )
    return
  const state = formDraftState(form)
  if (state.acknowledgedIntentId === confirmation.intentId) return
  const submitted = state.submissions.get(canonicalJson(confirmation.inputs))

  state.acknowledgedIntentId = confirmation.intentId
  if (submitted?.actionName === actionName && submitted.actionRevision === actionRevision) {
    state.submissions.delete(submitted.fingerprint)
    const current = state.current === submitted
    if (current) delete state.current
    submitted.confirmed = true
    if (current && state.editGeneration === submitted.editGeneration) resetFormDraft(form)
    if (state.pending === submitted) {
      delete state.pending
      setFormPending(form, false)
    }
  }
  // A discarded local draft leaves an orphaned receipt; retire it without changing the Form.
  ctx.acknowledgeAction?.(nodeId, actionName, confirmation.intentId)
}

function resetFormDraft(form: HTMLFormElement): void {
  delete form.dataset['vedutaFormDirty']
  clearFormError(form)
  form.reset()
}

function reconcileCanonicalValue(
  element: HTMLInputElement | HTMLTextAreaElement | null,
  canonicalValue: string,
): void {
  if (!element) return
  element.defaultValue = canonicalValue
  if (element.form?.dataset['vedutaFormDirty'] === 'true') return
  if (element.value !== canonicalValue) element.value = canonicalValue
}

function readFormDraft(
  form: HTMLFormElement,
  fields: Record<string, ActionScalarSpec>,
): JsonObject | undefined {
  const draft: JsonObject = {}
  for (const [stateKey, spec] of Object.entries(fields)) {
    const field = form.elements.namedItem(stateKey)
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) {
      return undefined
    }
    if (spec.type === 'number') {
      if (field.value.trim() === '') return undefined
      const value = Number(field.value)
      if (!Number.isFinite(value)) return undefined
      draft[stateKey] = value
    } else draft[stateKey] = field.value
  }
  return draft
}

function setFormPending(form: HTMLFormElement, pending: boolean): void {
  if (pending) {
    form.dataset['vedutaSubmitting'] = 'true'
    form.setAttribute('aria-busy', 'true')
  } else {
    delete form.dataset['vedutaSubmitting']
    form.removeAttribute('aria-busy')
  }

  form
    .querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(FORM_FIELD_SELECTOR)
    .forEach((field) => {
      field.disabled = pending
    })
  const submit = form.querySelector<HTMLButtonElement>(FORM_SUBMIT_SELECTOR)
  if (submit) {
    submit.disabled = pending
    submit.style.cursor = pending ? 'not-allowed' : 'pointer'
    submit.style.opacity = pending ? '0.55' : '1'
  }
}

function clearFormError(form: HTMLFormElement): void {
  const error = form.querySelector<HTMLElement>(FORM_ERROR_SELECTOR)
  if (!error) return
  error.hidden = true
  error.textContent = ''
}

function showFormError(form: HTMLFormElement, message: string): void {
  const error = form.querySelector<HTMLElement>(FORM_ERROR_SELECTOR)
  if (!error) return
  error.textContent = message
  error.hidden = false
}

function submitErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message
  return 'Could not save changes. Try again.'
}
