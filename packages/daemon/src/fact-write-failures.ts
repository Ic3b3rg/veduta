import type { AgentEvent } from './agent-runner.ts'
import { sanitizeErrorText } from './model-routing.ts'
import { normalizeFactText } from './facts.ts'

interface FactWrite {
  spaceId: string | undefined
  fact: string | undefined
  replacing: boolean
  error?: string
}

/** A successful unrelated fact cannot conceal a rejected correction in the same turn. */
export class FactWriteFailures {
  private calls = new Map<string, FactWrite>()

  constructor(
    private readonly resolveSpaceId: (target: string | undefined) => string | undefined,
  ) {}

  observe(event: AgentEvent): boolean {
    if (event.type !== 'tool-start' && event.type !== 'tool-result') return false
    if (event.toolName !== 'write_fact') return false
    if (event.type === 'tool-start') {
      const input = isRecord(event.input) ? event.input : {}
      this.calls.set(event.toolCallId, {
        spaceId: this.resolveSpaceId(
          typeof input['spaceId'] === 'string' ? input['spaceId'] : undefined,
        ),
        fact: typeof input['fact'] === 'string' ? normalizeFactText(input['fact']) : undefined,
        replacing: typeof input['supersedes'] === 'string',
      })
      return true
    }
    const call = this.calls.get(event.toolCallId)
    if (!call) return false
    if (event.isError) {
      call.error = sanitizeErrorText(new Error(event.content)).slice(0, 240)
    } else {
      const result = isRecord(event.details) ? event.details : undefined
      const fact = result && isRecord(result['fact']) ? result['fact']['text'] : undefined
      const replaced =
        result &&
        (result['operation'] === 'update' || result['operation'] === 'supersede') &&
        isRecord(result['previous']) &&
        typeof result['previous']['text'] === 'string'
      this.calls.delete(event.toolCallId)
      for (const [id, earlier] of this.calls) {
        if (
          earlier.error !== undefined &&
          call.spaceId !== undefined &&
          call.spaceId === earlier.spaceId &&
          call.fact !== undefined &&
          call.fact === earlier.fact &&
          typeof fact === 'string' &&
          normalizeFactText(fact) === call.fact &&
          (!earlier.replacing || replaced)
        )
          this.calls.delete(id)
      }
    }
    return true
  }

  failure(): string | undefined {
    const failures = [...this.calls.values()].flatMap((call) =>
      call.error ? [`A FACTS change was not saved: ${call.error}`] : [],
    )
    return failures.length > 0 ? [...new Set(failures)].join('\n\n') : undefined
  }

  reset(): void {
    this.calls.clear()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
