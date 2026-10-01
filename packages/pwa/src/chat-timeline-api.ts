import { ChatTimelinePageSchema, type ChatScope, type ChatTimelinePage } from '@veduta/protocol'
import { getJson } from './api-http.ts'

export async function fetchChatTimeline(
  scope: ChatScope,
  before?: string,
  token?: string,
): Promise<ChatTimelinePage> {
  const query = new URLSearchParams()
  if (scope.type === 'space') query.set('spaceId', scope.spaceId)
  if (before !== undefined) query.set('before', before)
  const suffix = query.size ? `?${query.toString()}` : ''
  return ChatTimelinePageSchema.parse(await getJson(`/api/chat/timeline${suffix}`, token))
}
