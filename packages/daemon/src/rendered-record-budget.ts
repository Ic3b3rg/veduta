export const MODEL_VISIBLE_MEMORY_BUDGET = 8_000

export interface BoundedRecordProjection<T> {
  text: string
  included: T[]
  omitted: T[]
}

interface BoundedRecordOptions<T> {
  records: readonly T[]
  renderRecord: (record: T) => string
  renderOmission: (omitted: readonly T[]) => string
  emptyText: string
  prefixLines?: readonly string[]
  suffixLines?: readonly string[]
  selection?: 'start' | 'end'
  maxRecords?: number
  budget?: number
}

/**
 * Renders complete model-visible records under one UTF-16-code-unit budget.
 * Input order is always output order. `selection: 'end'` only changes which
 * records receive priority when the complete set does not fit.
 */
export function projectBoundedRecords<T>(
  options: BoundedRecordOptions<T>,
): BoundedRecordProjection<T> {
  const budget = options.budget ?? MODEL_VISIBLE_MEMORY_BUDGET
  const prefixLines = options.prefixLines ?? []
  const suffixLines = options.suffixLines ?? []
  const allIndices = options.records.map((_, index) => index)
  const maxRecords = Math.max(
    0,
    Math.min(options.maxRecords ?? allIndices.length, allIndices.length),
  )
  const rendered = new Map<number, string>()
  const renderAt = (index: number): string => {
    const cached = rendered.get(index)
    if (cached !== undefined) return cached
    const text = options.renderRecord(options.records[index]!)
    rendered.set(index, text)
    return text
  }

  const renderSelection = (selected: ReadonlySet<number>): BoundedRecordProjection<T> => {
    const includedIndices = allIndices.filter((index) => selected.has(index))
    const included = includedIndices.map((index) => options.records[index]!)
    const omitted = allIndices
      .filter((index) => !selected.has(index))
      .map((index) => options.records[index]!)
    const lines = [...prefixLines]
    if (included.length === 0 && omitted.length === 0) lines.push(options.emptyText)
    lines.push(...includedIndices.map(renderAt))
    if (omitted.length > 0) {
      lines.push(options.renderOmission(omitted))
    }
    lines.push(...suffixLines)
    return {
      text: lines.join('\n'),
      included,
      omitted,
    }
  }

  if (allIndices.length <= maxRecords) {
    const all = renderSelection(new Set(allIndices))
    if (all.text.length <= budget) return all
  }

  let selected = new Set<number>()
  const selectionOrder = options.selection === 'end' ? [...allIndices].reverse() : allIndices
  let changed = true
  while (changed && selected.size < maxRecords) {
    changed = false
    for (const index of selectionOrder) {
      if (selected.size >= maxRecords) break
      if (selected.has(index)) continue
      const candidate = new Set(selected)
      candidate.add(index)
      if (renderSelection(candidate).text.length <= budget) {
        selected = candidate
        changed = true
      }
    }
  }

  const projection = renderSelection(selected)
  if (projection.text.length > budget) {
    throw new Error('rendered memory framing exceeds the model-visible budget')
  }
  return projection
}
