import type { AgentEvent } from './agent-runner.ts'
import { sanitizeErrorText } from './model-routing.ts'
import { normalizeFactText, type FactsDocument } from './facts.ts'

interface FactWrite {
  spaceId: string | undefined
  fact: string | undefined
  replacing: boolean
  confirmed?: boolean
  unchanged?: boolean
  error?: string
}

export interface FactConfirmationSource {
  resolveSpaceId(target: string | undefined): string | undefined
  readSpace(spaceId: string): { name: string; facts: FactsDocument } | undefined
}

/** A successful unrelated fact cannot conceal a rejected correction in the same turn. */
export class FactWriteConfirmation {
  private calls = new Map<string, FactWrite>()

  constructor(private readonly source: FactConfirmationSource) {}

  observe(event: AgentEvent): boolean {
    if (event.type !== 'tool-start' && event.type !== 'tool-result') return false
    if (event.toolName !== 'write_fact') return false
    if (event.type === 'tool-start') {
      const input = isRecord(event.input) ? event.input : {}
      this.calls.set(event.toolCallId, {
        spaceId: this.source.resolveSpaceId(
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
      const operation = result?.['operation']
      const fact = result && isRecord(result['fact']) ? result['fact']['text'] : undefined
      const replaced =
        result &&
        (result['operation'] === 'update' || result['operation'] === 'supersede') &&
        isRecord(result['previous']) &&
        typeof result['previous']['text'] === 'string'
      call.confirmed =
        typeof fact === 'string' &&
        normalizeFactText(fact) === call.fact &&
        typeof operation === 'string' &&
        ['add', 'update', 'supersede', 'noop', 'reactivate'].includes(operation)
      call.unchanged = result?.['operation'] === 'noop'
      delete call.error
      const space = call.spaceId === undefined ? undefined : this.source.readSpace(call.spaceId)
      const persisted = [...(space?.facts.active ?? []), ...(space?.facts.dormant ?? [])].some(
        (entry) => normalizeFactText(entry.text) === call.fact,
      )
      if (!call.confirmed || !persisted) return true
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

  feedback(): string | undefined {
    if (this.calls.size === 0) return undefined
    const messages = new Set<string>()
    const failure = this.failure()
    if (failure) messages.add(failure)
    for (const call of this.calls.values()) {
      if (call.error) continue
      const space = call.spaceId === undefined ? undefined : this.source.readSpace(call.spaceId)
      const current = [...(space?.facts.active ?? []), ...(space?.facts.dormant ?? [])].find(
        (fact) => normalizeFactText(fact.text) === call.fact,
      )
      if (call.confirmed && current && space) {
        messages.add(
          `${call.unchanged ? 'Already remembered' : 'Remembered'} in “${space.name}”: ${current.text}`,
        )
      } else if (
        call.confirmed &&
        space?.facts.superseded.some((fact) => normalizeFactText(fact.text) === call.fact)
      ) {
        messages.add('An earlier FACTS write has since been superseded.')
      } else {
        messages.add('A FACTS write is not confirmed.')
      }
    }
    return [...messages].join('\n\n')
  }

  reset(): void {
    this.calls.clear()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
