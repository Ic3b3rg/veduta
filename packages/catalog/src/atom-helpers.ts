import type { Action, AtomNode, JsonObject, JsonValue } from '@veduta/protocol'
import type { CSSProperties } from 'react'
import type { CatalogTokens } from './design-system.ts'
import type { RenderContext } from './types.ts'

type Choice = { label: string; value: string }
type DataPoint = { label: string; value: number }

export const text = (value: unknown): string =>
  typeof value === 'string' ? value : String(value ?? '')

export const optionalText = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

export function boundValue(node: AtomNode, ctx: RenderContext): JsonValue | undefined {
  return node.binding ? ctx.state[node.binding] : undefined
}

export function findAction(node: AtomNode, names: string[]): Action | undefined {
  for (const name of names) {
    const action = node.actions?.find((candidate) => candidate.name === name)
    if (action) return action
  }
  return undefined
}

export function actionValue(action: Action): JsonValue | undefined {
  return action.payload['value']
}

export function spacing(
  tokens: CatalogTokens,
  value: unknown,
  fallback: keyof CatalogTokens['space'],
): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value in tokens.space) {
    return tokens.space[value as keyof CatalogTokens['space']]
  }
  return tokens.space[fallback]
}

export function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export function propBoolean(
  props: JsonObject | undefined,
  key: string,
  fallback: boolean,
): boolean {
  const value = props?.[key]
  return typeof value === 'boolean' ? value : fallback
}

export function align(value: unknown): CSSProperties['alignItems'] {
  return value === 'start' || value === 'end' || value === 'center' || value === 'stretch'
    ? value
    : 'center'
}

export function ratioValue(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(1, Math.max(0, number > 1 ? number / 100 : number))
}

export function choicesFrom(value: unknown): Choice[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry === 'string') return [{ label: humanLabel(entry), value: entry }]
    if (!isRecord(entry)) return []
    const optionValue = entry['value']
    if (typeof optionValue !== 'string') return []
    return [{ label: text(entry['label'] ?? optionValue), value: optionValue }]
  })
}

export function tableRows(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : []
}

export function tableColumns(value: unknown, rows: JsonObject[]): string[] {
  if (Array.isArray(value)) {
    const fromProps = value.flatMap((entry) => (typeof entry === 'string' ? [entry] : []))
    if (fromProps.length > 0) return fromProps
  }
  return Object.keys(rows[0] ?? {})
}

export function dataPoints(value: unknown): DataPoint[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => {
      if (typeof entry === 'number') return [{ label: String(index + 1), value: entry }]
      if (!isRecord(entry)) return []
      const pointValue = Number(entry['value'])
      if (!Number.isFinite(pointValue)) return []
      return [{ label: text(entry['label'] ?? index + 1), value: pointValue }]
    })
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([label, raw]) => {
      const pointValue = Number(raw)
      return Number.isFinite(pointValue) ? [{ label: humanLabel(label), value: pointValue }] : []
    })
  }
  return []
}

export function toneColor(tokens: CatalogTokens, tone: string | undefined): string {
  if (tone === 'success' || tone === 'enabled' || tone === 'done') return tokens.color.success
  if (tone === 'warning' || tone === 'pending') return tokens.color.warning
  if (tone === 'danger' || tone === 'error') return tokens.color.danger
  return tokens.color.accent
}

export function iconGlyph(name: string | undefined): string {
  if (name === 'check') return '✓'
  if (name === 'clock') return '◷'
  if (name === 'alert') return '!'
  if (name === 'bolt') return '↯'
  return '•'
}

export function humanLabel(value: string): string {
  return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonObject(value: unknown): value is JsonObject {
  if (!isRecord(value)) return false
  return Object.values(value).every(isJsonValue)
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true
  }
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isJsonObject(value)
}
