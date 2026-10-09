import type { AgentEvent, ToolDef } from './agent-runner.ts'
import { FactWriteConfirmation } from './fact-write-confirmation.ts'
import { SurfaceChatConfirmation } from './surface-chat-confirmation.ts'
import type { Store } from './store.ts'

/** One write-outcome projection for focused/global Chat and declared Agent actions. */
export class ChatWriteConfirmation {
  private readonly facts: FactWriteConfirmation
  private readonly surfaces: SurfaceChatConfirmation

  constructor(store: Store, focusedSpaceId: string | undefined) {
    const cursorBeforeTurn = store.latestSurfaceCursor()
    this.facts = new FactWriteConfirmation({
      resolveSpaceId(target) {
        const reference = target ?? focusedSpaceId
        return store.spacesEngine
          .listAllSpaces()
          .find((space) => space.id === reference || space.slug === reference)?.id
      },
      readSpace(spaceId) {
        const space = store.getSpace(spaceId)
        return space ? { name: space.name, facts: store.readFacts(spaceId) } : undefined
      },
    })
    this.surfaces = new SurfaceChatConfirmation(
      (id) => store.getSurface(id),
      (surface) =>
        store
          .surfaceEventsAfter(cursorBeforeTurn)
          .some(
            (entry) =>
              entry.kind === 'archived' &&
              entry.event.surfaceId === surface.id &&
              entry.event.spaceId === surface.spaceId &&
              entry.event.at === surface.freshness.updatedAt,
          ),
    )
  }

  static observesTools(tools: readonly ToolDef[]): boolean {
    return (
      SurfaceChatConfirmation.hasAuthoringTools(tools) ||
      tools.some((tool) => tool.name === 'write_fact')
    )
  }

  observe(event: AgentEvent): boolean {
    return this.facts.observe(event) || this.surfaces.observe(event)
  }

  failure(): string | undefined {
    return joined(this.facts.failure(), this.surfaces.failure())
  }

  feedback(): string | undefined {
    return joined(this.facts.feedback(), this.surfaces.feedback())
  }
}

function joined(...parts: (string | undefined)[]): string | undefined {
  return parts.filter(Boolean).join('\n\n') || undefined
}
