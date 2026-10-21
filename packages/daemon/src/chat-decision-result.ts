import { pendingDecisionChatFeedback, type ChatMessage } from '@veduta/protocol'

/** Keeps result content after its decisions have their own canonical Chat entries. */
export function decisionResultMessage(message: ChatMessage): ChatMessage {
  const {
    pendingDecisions,
    pendingDecisionIds,
    decisionFeedbackId: _decisionFeedbackId,
    ...content
  } = message
  const feedback = pendingDecisionChatFeedback(
    pendingDecisions ?? [],
    (pendingDecisionIds?.length ?? 0) > 0,
  )
  const prefix = `${feedback}\n\n`
  return {
    ...content,
    text:
      message.text === feedback
        ? ''
        : message.text.startsWith(prefix)
          ? message.text.slice(prefix.length)
          : message.text,
  }
}
