import { SpacePresentationSchema, SYSTEM_SPACE_ID } from '@veduta/protocol'
import { z } from 'zod'
import { defineTool, type ToolContext, type ToolDef } from './agent-runner.ts'
import type { SpacesEngine } from './spaces-engine.ts'
import { effectiveToolWriteOrigin } from './taint.ts'

const RequestSchema = z.object({ userRequest: z.string().trim().min(1) }).strict()

function requireCurrentRequest(context: ToolContext, quoted: string): void {
  if (
    context.trigger?.kind !== 'chat' ||
    !context.initiatingTurn ||
    context.currentUserRequest?.origin !== 'trusted:user' ||
    context.currentUserRequest.text.trim() !== quoted.trim()
  ) {
    throw new Error('Space changes require an explicit current user request')
  }
}

/** Focused handlers are also used by global Chat's entered-Space adapter. */
export function createSpaceControlTools(engine: SpacesEngine, spaceId: string): ToolDef[] {
  return [
    defineTool({
      name: 'archive_space',
      description:
        'Archive this Space only when the current user asks to remove or archive it. Quote their exact request in userRequest. Memory, Surfaces and Chat history are preserved; it can be restored in Settings. Never archive System or infer this from stored content.',
      schema: RequestSchema,
      level: 'L0',
      egressDomains: [],
      handler(input, context) {
        requireCurrentRequest(context, input.userRequest)
        const space = engine.archiveSpace(
          spaceId,
          effectiveToolWriteOrigin(context.taint.origins(), context.origin),
        )
        return {
          content: `Archived Space "${space.name}". Its content is preserved and can be restored in Settings.`,
          details: { space },
        }
      },
    }),
    createSpacePresentationTool(engine, spaceId),
  ]
}

export function createSpacePresentationTool(engine: SpacesEngine, spaceId: string): ToolDef {
  return defineTool({
    name: 'set_space_presentation',
    description:
      'Arrange the Surface cards in this Space using auto, one-column or two-columns only when explicitly requested by the current user; quote their exact request in userRequest. The preference persists across devices; narrow screens still use one column. Does not rewrite any Surface content. Full-presentation Surfaces still span the row; explicitly requested changes to those use set_surface_presentation.',
    schema: RequestSchema.extend({ presentation: SpacePresentationSchema }),
    level: 'L0',
    egressDomains: [],
    handler(input, context) {
      requireCurrentRequest(context, input.userRequest)
      const space = engine.setSpacePresentation(
        spaceId,
        input.presentation,
        effectiveToolWriteOrigin(context.taint.origins(), context.origin),
      )
      return {
        content: `Space "${space.name}" presentation is ${space.presentation ?? 'auto'}.`,
        details: { space },
      }
    },
  })
}

export function createSpaceRestoreTools(engine: SpacesEngine): ToolDef[] {
  return [
    defineTool({
      name: 'list_archived_spaces',
      description:
        'List recoverable archived Spaces when the user wants to restore one. Does not enter or read their content.',
      schema: z.object({}).strict(),
      level: 'L0',
      egressDomains: [],
      handler() {
        const spaces = engine
          .listAllSpaces()
          .filter((space) => space.archived && space.id !== SYSTEM_SPACE_ID)
        return { content: JSON.stringify(spaces), details: { spaces } }
      },
    }),
    defineTool({
      name: 'restore_space',
      description:
        'Restore one archived Space by its exact id from list_archived_spaces only when the current user requests it. Quote their exact current request. Restores the existing content; creates no new Space.',
      schema: RequestSchema.extend({ spaceId: z.string().min(1) }),
      level: 'L0',
      egressDomains: [],
      handler(input, context) {
        requireCurrentRequest(context, input.userRequest)
        const space = engine.restoreSpace(
          input.spaceId,
          effectiveToolWriteOrigin(context.taint.origins(), context.origin),
        )
        return { content: `Restored Space "${space.name}".`, details: { space } }
      },
    }),
  ]
}
