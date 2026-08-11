import { z } from 'zod'
import { defineTool, type ToolDef } from './agent-runner.ts'
import type { Store } from './store.ts'
import { CreateSurfaceToolInputSchema } from './surface-engine.ts'
import {
  CreateSurfaceGateExtensionSchema,
  gateCreateSurfaceTool,
  type TemplateEngine,
} from './template-engine.ts'
import { isUntrusted, untrustedDataBlock, untrustedSource, type Origin } from './taint.ts'

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
    return bindCreateSurfaceToSpace(gated, options.spaceId)
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
          content: renderStoredJson(inventory.surfaces, inventory.origins, 'surface summaries'),
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
        }
        return {
          content: renderStoredJson(modelRead, read.origins, 'surface'),
          details: modelRead,
          origins: read.origins,
        }
      },
    }),
    ...surfaceTools,
  ]
}

/** Injects the trusted turn scope after parsing, so caller input cannot redirect creation. */
function bindCreateSurfaceToSpace(tool: ToolDef, spaceId: string): ToolDef {
  return defineTool({
    name: tool.name,
    description: tool.description,
    schema: FocusedCreateSurfaceSchema,
    level: tool.level,
    egressDomains: tool.egressDomains,
    handler(input, context) {
      return tool.handler({ ...input, spaceId }, context)
    },
  })
}

/** Marks any model-visible JSON carrying untrusted Surface content as data. */
function renderStoredJson(value: unknown, origins: Origin[], field: string): string {
  const json = JSON.stringify(value)
  const untrusted = origins.find(isUntrusted)
  if (!untrusted) return json
  return untrustedDataBlock(untrustedSource(untrusted) ?? 'external', [[field, json]])
}
