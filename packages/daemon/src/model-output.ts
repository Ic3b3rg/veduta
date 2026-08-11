const JSON_CODE_FENCE_RE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i

/** Removes one optional outer JSON code fence from a model response. */
export function stripJsonCodeFence(text: string): string {
  const trimmed = text.trim()
  const match = JSON_CODE_FENCE_RE.exec(trimmed)
  return match?.[1] !== undefined ? match[1].trim() : trimmed
}
