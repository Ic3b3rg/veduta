import { z } from 'zod'
import { defineTool, type ToolDef } from './agent-runner.ts'
import type { HimalayaConnections } from './himalaya-connections.ts'
import type { Store } from './store.ts'

export function createHimalayaInstallTool(connections: HimalayaConnections, store: Store): ToolDef {
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
      const result = await connections.install(context.signal)
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
