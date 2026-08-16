import { neutralizeDelimiters } from './taint.ts'

/** Neutralizes external delimiters and keeps the ellipsis inside the declared bound. */
export function boundedDecisionText(input: string, maxChars: number): string {
  if (maxChars < 1) throw new Error('Pending decision text bound must be positive')
  const value = neutralizeDelimiters(input).trim()
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`
}
