import { literalSetPlan } from '@veduta/protocol'
import type { AtomNode } from '@veduta/protocol'

export const DECISION_ERROR_CAPTION_NODE_ID = 'error'
export const DECISION_ERROR_CAPTION_PATH = '/children/3'

export function decisionButtonNode(id: string, label: string, stateKey: string): AtomNode {
  return {
    id,
    type: 'Button',
    props: { label },
    actions: [{ name: 'press', path: 'fast', plan: literalSetPlan(stateKey, true) }],
  }
}

export function decisionErrorCaptionNode(message: string): AtomNode {
  return { id: DECISION_ERROR_CAPTION_NODE_ID, type: 'Caption', props: { text: message } }
}
