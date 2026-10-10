import type { TurnError } from './codex-app-server-protocol.ts'
import { ModelConnectionError } from './model-connection-adapter.ts'
import { sanitizeErrorText } from './model-routing.ts'

export const CODEX_USAGE_LIMIT_MESSAGE =
  'ChatGPT subscription allowance or plan limit reached. Check your ChatGPT usage, then send a new message or use Test model in Model connections. Reconnecting does not restore allowance.'

export const CODEX_RATE_LIMIT_MESSAGE =
  'ChatGPT is temporarily rate limited. Wait, then send a new message or use Test model in Model connections.'

/** Classifies the pinned provider contract before pi turns errors into message text. */
export function codexInferenceError(
  error: TurnError | null | undefined,
  resetsAt: readonly string[] = [],
): ModelConnectionError {
  switch (error?.codexErrorInfo) {
    case 'usageLimitExceeded':
      return new ModelConnectionError(
        'usage-limit',
        CODEX_USAGE_LIMIT_MESSAGE +
          (resetsAt.length ? ` Provider reset times: ${resetsAt.join(', ')}.` : ''),
        resetsAt,
      )
    case 'rateLimitExceeded':
      return new ModelConnectionError('rate-limit', CODEX_RATE_LIMIT_MESSAGE)
    case 'unauthorized':
      return new ModelConnectionError(
        'unauthorized',
        'ChatGPT authorization was rejected. Open Model connections to reconnect, then send a new message.',
      )
    default: {
      const message =
        error === undefined || error === null ? '' : sanitizeErrorText(error.message).trim()
      return new ModelConnectionError(
        'unreachable',
        message || 'the Codex provider turn failed without an error message',
      )
    }
  }
}

/** Only known pinned provider wording can repair records written before structured classification. */
export function legacyCodexLimitError(message: string): ModelConnectionError | undefined {
  if (message.startsWith('rate limit exceeded: ')) {
    return new ModelConnectionError('rate-limit', CODEX_RATE_LIMIT_MESSAGE)
  }
  if (
    /^You[’']ve hit your usage limit[. ]/.test(message) ||
    message === 'Quota exceeded. Check your plan and billing details.' ||
    message === 'Your workspace is out of credits. Add credits to continue.' ||
    message ===
      'Your workspace is out of credits. Ask your workspace owner to refill in order to continue.' ||
    message ===
      'You hit your spend cap set in your workspace. Increase your spend cap to continue.' ||
    message ===
      'You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.'
  )
    return new ModelConnectionError('usage-limit', CODEX_USAGE_LIMIT_MESSAGE)
  return undefined
}
