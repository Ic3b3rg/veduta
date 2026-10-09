import { canonicalJson, findAtom, SurfaceSchema } from '@veduta/protocol'
import { isRecord, parseJson, toolCallMessage, toolResultText } from './mock-fixture-support.ts'
import { piFauxAssistantMessage, type PiChatContext } from './pi-provider-bridge.ts'

type ToolResult = Extract<PiChatContext['messages'][number], { role: 'toolResult' }>

/** Deterministic Agent-action journey, isolated from production action interpretation. */
export function respondToMockAgentAction(text: string, results: ToolResult[]) {
  if (!text.startsWith('Surface Action request\n')) return undefined
  const request = parseJson(text.split('\n')[1] ?? '')
  if (
    !isRecord(request) ||
    typeof request['surfaceId'] !== 'string' ||
    typeof request['atomId'] !== 'string' ||
    !isRecord(request['payload'])
  )
    return undefined
  if (request['actionName'] === 'edit_facts')
    return piFauxAssistantMessage('Which fact would you like to correct, and what should it say?')
  const fail = request['actionName'] === 'fail_demo'
  if (
    !(request['actionName'] === 'complete_demo' || fail) ||
    request['payload']['request'] !==
      (fail ? 'Try an invalid Agent action demo' : 'Complete the Agent action demo')
  )
    return undefined

  const list = results.find((result) => result.toolName === 'list_surfaces')
  if (!list)
    return toolCallMessage('list_surfaces', {}, 'Finding the requested Agent action Surface.')
  const summaries = parseJson(toolResultText(list))
  if (
    list.isError ||
    !Array.isArray(summaries) ||
    !summaries.some((item) => isRecord(item) && item['id'] === request['surfaceId'])
  )
    return piFauxAssistantMessage('The requested Agent action Surface is unavailable.')

  const read = results.find((result) => result.toolName === 'read_surface')
  if (!read)
    return toolCallMessage(
      'read_surface',
      { surfaceId: request['surfaceId'] },
      'Reading the current Surface before acting.',
    )
  const content = parseJson(toolResultText(read))
  const parsed = SurfaceSchema.safeParse(isRecord(content) ? content['surface'] : undefined)
  if (
    read.isError ||
    !parsed.success ||
    parsed.data.id !== request['surfaceId'] ||
    !isRecord(content) ||
    !Number.isInteger(content['treeVersion'])
  )
    return piFauxAssistantMessage('The Agent action Surface could not be read safely.')
  const node = findAtom(parsed.data.tree, request['atomId'])
  const action = node?.actions?.find((candidate) => candidate.name === request['actionName'])
  if (
    action?.path !== 'agent' ||
    canonicalJson(action.payload) !== canonicalJson(request['payload']) ||
    !Array.isArray(parsed.data.state['records'])
  )
    return piFauxAssistantMessage('The requested demo action is not declared by this Surface.')

  const patched = results.find((result) => result.toolName === 'patch_state')
  if (patched)
    return piFauxAssistantMessage(
      patched.isError
        ? `The Agent action was not completed: ${toolResultText(patched)}`
        : 'The Agent action completed.',
    )
  const records = parsed.data.state['records']
  let index = records.length + 1
  while (records.some((record) => isRecord(record) && record['id'] === `agent-demo-${index}`))
    index++
  return toolCallMessage(
    'patch_state',
    {
      surfaceId: parsed.data.id,
      operations: [
        { target: 'state', op: 'replace', path: '/result', value: 'Completed' },
        {
          target: 'state',
          op: 'replace',
          path: '/records',
          value: fail ? 42 : [...records, { id: `agent-demo-${index}`, label: 'Completed' }],
        },
      ],
    },
    // The failed fixture proves the loop never publishes an uncommitted success prefix.
    fail ? 'The Agent action is complete.' : 'Applying the declared demo action to current state.',
  )
}
