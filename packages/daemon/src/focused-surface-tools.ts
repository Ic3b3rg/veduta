import { z } from 'zod'
import { defineTool, type ToolDef } from './agent-runner.ts'
import { bindToolToSpace, renderFocusedStoredJson } from './focused-tool-support.ts'
import type { Store } from './store.ts'
import { CreateSurfaceToolInputSchema } from './surface-engine.ts'
import {
  CreateSurfaceGateExtensionSchema,
  gateCreateSurfaceTool,
  type TemplateEngine,
} from './template-engine.ts'

const ListSurfacesSchema = z.object({})
const ReadSurfaceSchema = z.object({
  surfaceId: z.string().min(1),
})
const FocusedCreateSurfaceSchema = CreateSurfaceToolInputSchema.omit({ spaceId: true }).and(
  CreateSurfaceGateExtensionSchema,
)

export interface FocusedSurfaceToolsOptions {
  store: Store
  templateEngine: TemplateEngine
  spaceId: string
}

/**
 * Builds the Surface-authoring portion of one focused-Space registry. The
 * reader is bound to the focused Space and therefore exposes no routing id;
 * the raw engine tools remain the single mutation implementation.
 */
export function createFocusedSurfaceTools(options: FocusedSurfaceToolsOptions): ToolDef[] {
  const surfaceTools = options.store.surfaceTools().map((tool) => {
    if (tool.name !== 'create_surface') return tool
    const gated = gateCreateSurfaceTool(tool, options.templateEngine)
    return bindToolToSpace(gated, FocusedCreateSurfaceSchema, options.spaceId)
  })

  return [
    defineTool({
      name: 'list_surfaces',
      description:
        'List compact summaries of the active Surfaces the Agent may author in this Space.',
      schema: ListSurfacesSchema,
      level: 'L0',
      egressDomains: [],
      handler() {
        const inventory = options.store.listAuthorableSurfaces(options.spaceId)
        return {
          content: renderFocusedStoredJson(
            inventory.surfaces,
            inventory.origins,
            'surface summaries',
          ),
          details: { surfaces: inventory.surfaces },
          origins: inventory.origins,
        }
      },
    }),
    defineTool({
      name: 'read_surface',
      description:
        'Read one complete current Surface, including its declarative tree, typed state, and versions.',
      schema: ReadSurfaceSchema,
      level: 'L0',
      egressDomains: [],
      handler(input) {
        const read = options.store.readAuthorableSurface(options.spaceId, input.surfaceId)
        const modelRead = {
          surface: read.surface,
          version: read.version,
          treeVersion: read.treeVersion,
          ...(read.relativeTime === undefined ? {} : { relativeTime: read.relativeTime }),
        }
        return {
          content: renderFocusedStoredJson(modelRead, read.origins, 'surface'),
          details: modelRead,
          origins: read.origins,
        }
      },
    }),
    ...surfaceTools,
  ]
}
