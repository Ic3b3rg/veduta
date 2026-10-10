/**
 * The approved operation has durable recovery work. Keep the Trust effect executing;
 * its idempotent handler must resume it at boot before recording a terminal outcome.
 * Ordinary executor failures must not use this signal.
 */
export class ToolRecoveryPendingError extends Error {
  constructor(cause: unknown) {
    super('Approved operation is awaiting recovery. It will resume when Veduta restarts.', {
      cause,
    })
    this.name = 'ToolRecoveryPendingError'
  }
}
