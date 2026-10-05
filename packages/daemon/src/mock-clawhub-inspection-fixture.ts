import { clawHubSourceInText } from './clawhub-catalog.ts'
import { toolCallMessage } from './mock-fixture-support.ts'

/** Uses the same read-only tool as real Model connections, with no catalog or report fixture here. */
export function respondToMockClawHubInspection(text: string) {
  const source = clawHubSourceInText(text)
  return source === undefined ? undefined : toolCallMessage('inspect_clawhub_skill', { source }, '')
}
