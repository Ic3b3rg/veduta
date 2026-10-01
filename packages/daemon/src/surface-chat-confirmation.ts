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

type Confirmation =
  | { status: 'pending' | 'unconfirmed' | 'proposed'; toolName: string }
  | { status: 'saved'; toolName: string; surfaceId: string }
  | { status: 'archived'; toolName: string; title: string }
  | { status: 'failed'; toolName: string; error: string }

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
        this.calls.set(event.toolCallId, { status: 'pending', toolName: event.toolName })
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
        error: sanitizeErrorText(new Error(event.content)).slice(0, 240),
      })
      return true
    }

    const details = isRecord(event.details) ? event.details : undefined
    const parsed = SurfaceSchema.safeParse(details?.['surface'])
    const canonical = parsed.success ? this.readSurface(parsed.data.id) : undefined
    if (parsed.success && call.toolName === 'archive_surface' && this.isArchived(parsed.data)) {
      this.calls.set(event.toolCallId, {
        status: 'archived',
        toolName: call.toolName,
        title: parsed.data.title,
      })
    } else if (
      parsed.success &&
      canonical &&
      canonicalJson(canonical) === canonicalJson(parsed.data)
    ) {
      this.calls.set(event.toolCallId, {
        status: 'saved',
        toolName: call.toolName,
        surfaceId: canonical.id,
      })
    } else {
      this.calls.set(event.toolCallId, {
        status: typeof details?.['proposalId'] === 'string' ? 'proposed' : 'unconfirmed',
        toolName: call.toolName,
      })
    }
    return true
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
        failures.add(`A Surface change was not saved: ${call.error}`)
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

/** A bounded excerpt of visible text and metrics, excluding unused state and control claims. */
function confirmedContent(surface: Surface): string {
  const excerpts: string[] = []
  function visit(node: AtomNode): void {
    if (excerpts.length >= 8) return
    let text: unknown
    if (['Title', 'Text', 'Caption', 'Label', 'Markdown'].includes(node.type)) {
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
