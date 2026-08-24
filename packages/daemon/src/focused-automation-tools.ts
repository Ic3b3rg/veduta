import { z } from 'zod'
import { defineTool, type ToolDef } from './agent-runner.ts'
import { bindToolToSpace, renderFocusedStoredJson } from './focused-tool-support.ts'
import {
  ArmTimerSchema,
  CancelAutomationSchema,
  CreateJobSchema,
  SetAutomationEnabledSchema,
  type Automation,
  type Scheduler,
} from './scheduler.ts'
import type { Origin } from './taint.ts'

const ListAutomationsSchema = z.object({})
const FocusedArmTimerSchema = ArmTimerSchema.omit({ spaceId: true })
const FocusedCancelAutomationSchema = CancelAutomationSchema.omit({ spaceId: true })
const FocusedCreateJobSchema = CreateJobSchema.omit({ spaceId: true })
const FocusedSetAutomationEnabledSchema = SetAutomationEnabledSchema.omit({ spaceId: true })

export interface FocusedAutomationToolsOptions {
  scheduler: Scheduler
  spaceId: string
}

/** Builds the Automation portion of one focused-Space Agent registry. */
export function createFocusedAutomationTools(options: FocusedAutomationToolsOptions): ToolDef[] {
  const rawTools = options.scheduler.tools()
  return [
    defineTool({
      name: 'list_automations',
      description:
        'List a compact inventory of every non-cancelled Automation in this Space for complete-set management.',
      schema: ListAutomationsSchema,
      level: 'L0',
      egressDomains: [],
      handler() {
        const automations = options.scheduler
          .listAutomations(options.spaceId)
          .filter((automation) => automation.status !== 'cancelled')
        const summaries = automations.map(automationSummary)
        const origins = automationOrigins(automations)
        return {
          content: renderFocusedStoredJson(summaries, origins, 'automations'),
          details: { automations: summaries },
          origins,
        }
      },
    }),
    bindToolToSpace(toolNamed(rawTools, 'arm_timer'), FocusedArmTimerSchema, options.spaceId),
    bindToolToSpace(toolNamed(rawTools, 'create_job'), FocusedCreateJobSchema, options.spaceId),
    bindToolToSpace(
      toolNamed(rawTools, 'set_automation_enabled'),
      FocusedSetAutomationEnabledSchema,
      options.spaceId,
    ),
    bindToolToSpace(toolNamed(rawTools, 'cancel'), FocusedCancelAutomationSchema, options.spaceId),
  ]
}

function automationSummary(automation: Automation): Record<string, unknown> {
  return {
    id: automation.id,
    kind: automation.kind,
    description: automation.description,
    enabled: automation.enabled,
    status: automation.status,
    ...(automation.fireAt === undefined ? {} : { fireAt: automation.fireAt }),
    ...(automation.cron === undefined ? {} : { cron: automation.cron }),
    ...(automation.nextRunAt === undefined ? {} : { nextRunAt: automation.nextRunAt }),
  }
}

function automationOrigins(automations: Automation[]): Origin[] {
  return Array.from(new Set(automations.map((automation) => automation.origin ?? 'trusted:system')))
}

function toolNamed(tools: ToolDef[], name: string): ToolDef {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`missing Scheduler tool: ${name}`)
  return tool
}
