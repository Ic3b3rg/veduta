import { z } from 'zod'
import { defineTool, type ToolDef } from './agent-runner.ts'
import type { HimalayaConnections } from './himalaya-connections.ts'
import type { Store } from './store.ts'
import type { TrustLayer } from './trust-layer.ts'

export function createHimalayaInstallTool(
  connections: HimalayaConnections,
  store: Store,
  audit: Pick<TrustLayer, 'recordGeneralExecution'>,
): ToolDef {
  return defineTool({
    name: 'install_himalaya',
    description:
      'Reuse or install the reviewed Himalaya 2.1.0 binary after an explicit user setup request. The Gateway verifies the release checksum and version.',
    schema: z.object({}).strict(),
    level: 'general',
    egressDomains: ['github.com'],
    async handler(_input, context) {
      if (
        !context.currentUserRequest ||
        !context.spaceId ||
        !/\b(set up|setup|install)\s+himalaya\b/i.test(context.currentUserRequest.text)
      ) {
        return { content: 'An explicit Himalaya setup request is required.' }
      }
      let result: Awaited<ReturnType<HimalayaConnections['install']>>
      try {
        result = await connections.install(context.signal)
      } catch {
        audit.recordGeneralExecution({
          toolName: 'install_himalaya',
          context,
          command: 'install_himalaya',
          outcome: 'error',
          detail: 'Himalaya installation failed before a result was returned',
        })
        throw new Error('Himalaya installation failed')
      }
      audit.recordGeneralExecution({
        toolName: 'install_himalaya',
        context,
        command: 'install_himalaya',
        outcome: result.state === 'ready' ? 'executed' : 'error',
        detail:
          result.state === 'ready' ? 'Reviewed Himalaya release is ready' : 'Himalaya setup failed',
      })
      store.spacesEngine.appendEvent(context.spaceId, {
        type: 'tool.execution',
        text: result.state === 'ready' ? 'Himalaya setup completed' : 'Himalaya setup failed',
        origin: 'trusted:system',
        payload: { command: 'install_himalaya', state: result.state },
      })
      return { content: JSON.stringify(result), details: result }
    },
  })
}
