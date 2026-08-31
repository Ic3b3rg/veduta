import type { FormEvent, ReactNode } from 'react'
import { boundValue, boundedNumber, motionContent, optionalText, text } from './atom-helpers.ts'
import { buttonStyle, controlStyle, fieldStyle, labelStyle } from './atom-styles.ts'
import { tokensFor } from './design-system.ts'
import type { AtomProps } from './types.ts'

const FORM_FIELD_SELECTOR = '[data-veduta-form-field]'
const FORM_ERROR_SELECTOR = '[data-veduta-form-error]'
const FORM_SUBMIT_SELECTOR = '[data-veduta-form-submit]'

export function InputAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const value = text(boundValue(node, ctx))
  const label = text(node.props?.['label'])
  return (
    <label style={fieldStyle(tokens)}>
      <span {...motionContent('label')} style={labelStyle(tokens)}>
        {label}
      </span>
      <input
        {...motionContent('value')}
        aria-label={label}
        data-veduta-form-field
        defaultValue={value}
        name={node.binding}
        onChange={(event) => markFormDirty(event.currentTarget.form)}
        placeholder={optionalText(node.props?.['placeholder'])}
        ref={(element) => reconcileCanonicalValue(element, value)}
        style={controlStyle(tokens)}
        type={optionalText(node.props?.['inputType']) ?? 'text'}
      />
    </label>
  )
}

export function TextareaAtom({ node, ctx }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const value = text(boundValue(node, ctx))
  const label = text(node.props?.['label'])
  return (
    <label style={fieldStyle(tokens)}>
      <span {...motionContent('label')} style={labelStyle(tokens)}>
        {label}
      </span>
      <textarea
        {...motionContent('value')}
        aria-label={label}
        data-veduta-form-field
        defaultValue={value}
        name={node.binding}
        onChange={(event) => markFormDirty(event.currentTarget.form)}
        placeholder={optionalText(node.props?.['placeholder'])}
        ref={(element) => reconcileCanonicalValue(element, value)}
        rows={boundedNumber(node.props?.['rows'], 3, 2, 12)}
        style={{ ...controlStyle(tokens), resize: 'vertical' }}
      />
    </label>
  )
}

export function FormAtom({ node, ctx, children }: AtomProps): ReactNode {
  const tokens = tokensFor(ctx.theme)
  const action = node.actions?.find(
    (candidate) => candidate.name === 'submit' && candidate.stateKeys !== undefined,
  )
  const submitLabel = text(node.props?.['submitLabel'])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    if (!action || form.dataset['vedutaSubmitting'] === 'true') return

    const draft = readFormDraft(form, action.stateKeys ?? [])
    if (!draft) {
      showFormError(form, 'This Form is incomplete and cannot be submitted.')
      return
    }

    clearFormError(form)
    setFormPending(form, true)
    try {
      await ctx.dispatch(node, action.name, draft)
      delete form.dataset['vedutaFormDirty']
    } catch (error) {
      showFormError(form, submitErrorMessage(error))
    } finally {
      setFormPending(form, false)
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
      style={{ display: 'grid', gap: tokens.space.md }}
    >
      {children}
      <div aria-live="polite" data-veduta-form-error hidden role="alert" />
      <button
        {...motionContent('submit')}
        data-veduta-form-submit
        style={buttonStyle(tokens, undefined, false)}
        type="submit"
      >
        {submitLabel}
      </button>
    </form>
  )
}

function markFormDirty(form: HTMLFormElement | null): void {
  if (!form) return
  form.dataset['vedutaFormDirty'] = 'true'
  clearFormError(form)
}

function reconcileCanonicalValue(
  element: HTMLInputElement | HTMLTextAreaElement | null,
  canonicalValue: string,
): void {
  if (!element) return
  if (element.form?.dataset['vedutaFormDirty'] === 'true') return
  if (element.value !== canonicalValue) element.value = canonicalValue
}

function readFormDraft(
  form: HTMLFormElement,
  stateKeys: readonly string[],
): Record<string, string> | undefined {
  const draft: Record<string, string> = {}
  for (const stateKey of stateKeys) {
    const field = form.elements.namedItem(stateKey)
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) {
      return undefined
    }
    draft[stateKey] = field.value
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
