import { canonicalJson, SurfaceSchema, type AtomNode, type Surface } from '@veduta/protocol'
import type { AgentEvent, ToolDef } from './agent-runner.ts'
import { sanitizeErrorText } from './model-routing.ts'

const SURFACE_WRITE_TOOLS = new Set([
  'create_surface',
  'create_surface_from_template',
  'patch_state',
  'patch_tree',
  'set_surface_presentation',
  'archive_surface',
  'pin_surface',
])

type Confirmation = {
  toolName: string
  target: string | undefined
  effects: readonly string[] | undefined
} & (
  | { status: 'pending' | 'unconfirmed' | 'proposed' }
  | { status: 'saved'; surfaceId: string }
  | { status: 'archived'; title: string }
  | { status: 'failed'; error: string }
)

/** Chat confirmations are derived from Gateway writes, never model descriptions of a write. */
export class SurfaceChatConfirmation {
  private readonly calls = new Map<string, Confirmation>()

  constructor(
    private readonly readSurface: (id: string) => Surface | undefined,
    private readonly isArchived: (surface: Surface) => boolean = () => false,
  ) {}

  static hasAuthoringTools(tools: readonly ToolDef[]): boolean {
    return tools.some((tool) => SURFACE_WRITE_TOOLS.has(tool.name))
  }

  observe(event: AgentEvent): boolean {
    if (event.type === 'tool-start' && SURFACE_WRITE_TOOLS.has(event.toolName)) {
      if (!this.calls.has(event.toolCallId)) {
        const input = isRecord(event.input) ? event.input : undefined
        const target = input?.['surfaceId'] ?? input?.['id']
        this.calls.set(event.toolCallId, {
          status: 'pending',
          toolName: event.toolName,
          target: typeof target === 'string' ? target : undefined,
          effects: mutationEffects(event.toolName, input),
        })
      }
      return true
    }
    if (event.type !== 'tool-result') return false
    const call = this.calls.get(event.toolCallId)
    if (!call || call.toolName !== event.toolName) return false

    if (event.isError) {
      this.calls.set(event.toolCallId, {
        status: 'failed',
        toolName: call.toolName,
        target: call.target,
        effects: call.effects,
        error: sanitizeErrorText(new Error(event.content)).slice(0, 240),
      })
      return true
    }

    const details = isRecord(event.details) ? event.details : undefined
    const parsed = SurfaceSchema.safeParse(details?.['surface'])
    const canonical = parsed.success ? this.readSurface(parsed.data.id) : undefined
    const sameTarget =
      parsed.success && (call.target === undefined || call.target === parsed.data.id)
    if (
      sameTarget &&
      parsed.success &&
      call.toolName === 'archive_surface' &&
      this.isArchived(parsed.data)
    ) {
      this.calls.set(event.toolCallId, {
        status: 'archived',
        toolName: call.toolName,
        target: call.target,
        effects: call.effects,
        title: parsed.data.title,
      })
    } else if (
      sameTarget &&
      parsed.success &&
      canonical &&
      canonicalJson(canonical) === canonicalJson(parsed.data)
    ) {
      this.calls.set(event.toolCallId, {
        status: 'saved',
        toolName: call.toolName,
        target: call.target,
        effects: call.effects,
        surfaceId: canonical.id,
      })
    } else {
      this.calls.set(event.toolCallId, {
        status:
          call.toolName === 'patch_tree' &&
          Number.isSafeInteger(details?.['proposalId']) &&
          typeof details?.['proposalId'] === 'number' &&
          details['proposalId'] > 0
            ? 'proposed'
            : 'unconfirmed',
        toolName: call.toolName,
        target: call.target,
        effects: call.effects,
      })
    }
    const result = this.calls.get(event.toolCallId)
    if (
      call.target !== undefined &&
      call.effects !== undefined &&
      (result?.status === 'saved' || result?.status === 'archived')
    ) {
      for (const [id, earlier] of this.calls) {
        if (
          earlier.status === 'failed' &&
          earlier.toolName === call.toolName &&
          earlier.target === call.target &&
          earlier.effects !== undefined
        ) {
          const remaining = earlier.effects.filter((effect) => !call.effects?.includes(effect))
          if (remaining.length === 0) this.calls.delete(id)
          else this.calls.set(id, { ...earlier, effects: remaining })
        }
      }
    }
    return true
  }

  failure(): string | undefined {
    const errors = [...this.calls.values()].flatMap((call) =>
      call.status === 'failed' ? [surfaceFailureText(call.error)] : [],
    )
    return errors.length === 0 ? undefined : [...new Set(errors)].join('\n\n')
  }

  feedback(): string | undefined {
    if (this.calls.size === 0) return undefined
    const saved = new Map<string, Surface>()
    const failures = new Set<string>()
    const archives = new Set<string>()
    let pending = false
    let proposed = false
    let unconfirmed = false
    for (const call of this.calls.values()) {
      if (call.status === 'saved') {
        const canonical = this.readSurface(call.surfaceId)
        if (canonical) saved.set(canonical.id, canonical)
        else unconfirmed = true
      } else if (call.status === 'archived') {
        archives.add(`Archived Surface “${call.title}”.`)
      } else if (call.status === 'failed') {
        failures.add(surfaceFailureText(call.error))
      } else if (call.status === 'pending') pending = true
      else if (call.status === 'proposed') proposed = true
      else unconfirmed = true
    }

    const text = [...saved.values()].map(
      (surface) =>
        `Saved Surface “${surface.title}” (${surface.presentation} presentation). Open the Surface to view its confirmed content.${confirmedContent(surface)}`,
    )
    text.push(...archives, ...failures)
    if (proposed) text.push('A Surface change is proposed and awaits your decision.')
    if (pending) text.push('A Surface change is not yet confirmed.')
    if (unconfirmed) text.push('No Surface change is confirmed.')
    return text.join('\n\n')
  }
}

function surfaceFailureText(error: string): string {
  return `A Surface change was not saved: ${error}`
}

function mutationEffects(
  toolName: string,
  input: Record<string, unknown> | undefined,
): readonly string[] | undefined {
  if (toolName !== 'patch_state' && toolName !== 'patch_tree') return [toolName]
  const operations = input?.['operations']
  if (!Array.isArray(operations) || operations.length === 0) return undefined
  const effects: string[] = []
  for (const operation of operations) {
    if (
      !isRecord(operation) ||
      typeof operation['target'] !== 'string' ||
      typeof operation['path'] !== 'string'
    )
      return undefined
    effects.push(canonicalJson({ target: operation['target'], path: operation['path'] }))
  }
  return [...new Set(effects)]
}

/** A bounded excerpt of visible text and metrics, excluding unused state and control claims. */
function confirmedContent(surface: Surface): string {
  const excerpts: string[] = []
  function visit(node: AtomNode): void {
    if (excerpts.length >= 8) return
    let text: unknown
    if (
      node.type === 'Title' ||
      node.type === 'Text' ||
      node.type === 'Caption' ||
      node.type === 'Label' ||
      node.type === 'Markdown'
    ) {
      text = node.binding === undefined ? node.props?.['text'] : surface.state[node.binding]
      if (text === '') text = node.props?.['emptyText']
    } else if (node.type === 'Stat') {
      const value = node.binding === undefined ? node.props?.['value'] : surface.state[node.binding]
      const displayed = value === null ? node.props?.['emptyText'] : value
      if (typeof displayed === 'string' || typeof displayed === 'number') {
        const unit = value === null ? undefined : node.props?.['unit']
        text = `${node.props?.['label']}: ${displayed}${typeof unit === 'string' ? ` ${unit}` : ''}`
      }
    }
    if (typeof text === 'string' && text.trim() !== '') {
      excerpts.push(text.replace(/\s+/g, ' ').trim())
    }
    node.children?.forEach(visit)
  }
  visit(surface.tree)
  const excerpt = excerpts.join('; ')
  return excerpt === ''
    ? ''
    : `\nConfirmed content: ${excerpt.slice(0, 1200)}${excerpt.length > 1200 ? '…' : ''}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
