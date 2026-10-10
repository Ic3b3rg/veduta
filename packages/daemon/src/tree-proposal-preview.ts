import {
  inspectSurfacePatch,
  JsonValueSchema,
  type AtomNode,
  type JsonObject,
  type JsonValue,
  type Surface,
  type SurfacePatchInspectionStep,
} from '@veduta/protocol'
import { boundedDecisionText } from './pending-decision-summary.ts'
import type { TreeProposal } from './surface-engine.ts'
import { neutralizeDelimiters } from './taint.ts'

export const TREE_REVIEW_SUMMARY_KEY = 'review.summary'
export const TREE_REVIEW_FORMAT_KEY = 'review.format'
export const TREE_REVIEW_READY_KEY = 'review.ready'
export const TREE_REVIEW_FORMAT = 1

/** Only the complete validated batch is inspected; no proposed Atom is ever rendered or invoked. */
export function treeProposalPreview(proposal: TreeProposal, target: Surface) {
  const inspection = inspectSurfacePatch(target, {
    surfaceId: proposal.surfaceId,
    operations: proposal.operations,
  })
  const descriptions = inspection.steps.map(stepDescription)
  const summary = decisionSummary(target.title, descriptions)
  const details: AtomNode[] = inspection.steps.map((step, index) => ({
    id: `change-${index}`,
    type: 'Collapsible',
    props: { label: boundedDecisionText(`${index + 1}. ${descriptions[index]}`, 120) },
    children: [
      ...literalText(`change-${index}-location`, describeLocation(step)),
      ...reviewSide(`change-${index}-before`, 'Before', step.before, target.state),
      ...reviewSide(`change-${index}-after`, 'After', step.after, target.state),
    ],
  }))
  details.push({
    id: 'result',
    type: 'Collapsible',
    props: { label: 'Result after acceptance · complete Surface content' },
    children: readOnlyValue(
      'result-content',
      JsonValueSchema.parse(inspection.surface.tree),
      target.state,
    ),
  })
  return { summary, details }
}

/** A terminal or unavailable proposal has no trustworthy old subtree to name. */
export function treeProposalFallbackSummary(proposal: TreeProposal, targetTitle: string): string {
  return decisionSummary(
    targetTitle,
    proposal.operations.map((operation) => {
      if (operation.op === 'add' || operation.op === 'replace') {
        return `${operation.op === 'add' ? 'Add' : 'Replace with'} ${valueName(JsonValueSchema.parse(operation.value))}`
      }
      return `${operation.op === 'move' ? 'Move' : 'Remove'} content at ${operation.path || 'the Surface root'}`
    }),
  )
}

function decisionSummary(title: string, descriptions: string[]): string {
  const more = descriptions.length > 2 ? `; +${descriptions.length - 2} more changes` : ''
  return boundedDecisionText(
    `“${boundedDecisionText(title, 120)}”: ${descriptions
      .slice(0, 2)
      .map((text) => boundedDecisionText(text, 150))
      .join('; ')}${more}`,
    500,
  )
}

function stepDescription(step: SurfacePatchInspectionStep): string {
  const { operation, before, after } = step
  if (operation.op === 'remove') return `Remove ${valueName(before)}`
  if (operation.op === 'move') return `Move ${valueName(before)}`
  if (operation.op === 'add' && before === undefined) return `Add ${valueName(after)}`
  if (isObject(before) && isObject(after)) {
    const actionsChanged = JSON.stringify(before['actions']) !== JSON.stringify(after['actions'])
    const bindingChanged = before['binding'] !== after['binding']
    const sameContent = JSON.stringify(before['props']) === JSON.stringify(after['props'])
    if (sameContent && actionsChanged && bindingChanged)
      return `Change actions and data binding on ${valueName(before)}`
    if (sameContent && actionsChanged) return `Change actions on ${valueName(before)}`
    if (sameContent && bindingChanged) return `Change data binding on ${valueName(before)}`
  }
  return `Replace ${valueName(before, after)} with ${valueName(after, before)}`
}

function valueName(value: JsonValue | undefined, comparedWith?: JsonValue): string {
  if (isObject(value)) {
    const props = value['props']
    if (isObject(props)) {
      for (const key of ['label', 'title', 'text', 'caption', 'alt']) {
        const text = props[key]
        if (typeof text === 'string' && text.trim()) {
          const comparedProps = isObject(comparedWith) ? comparedWith['props'] : undefined
          const comparedText = isObject(comparedProps) ? comparedProps[key] : undefined
          return `“${boundedDecisionText(changeExcerpt(text, comparedText).replace(/\s+/g, ' '), 64)}”`
        }
      }
    }
    if (typeof value['type'] === 'string' && typeof value['id'] === 'string') {
      return `${value['type']} “${boundedDecisionText(value['id'], 64)}”`
    }
  }
  return value === undefined ? 'content' : boundedDecisionText(JSON.stringify(value), 80)
}

/** A late edit needs its changed words in the compact summary, not two identical prefixes. */
function changeExcerpt(text: string, comparedWith: JsonValue | undefined): string {
  if (typeof comparedWith !== 'string' || comparedWith === text) return text
  let firstDifference = 0
  while (firstDifference < text.length && text[firstDifference] === comparedWith[firstDifference])
    firstDifference += 1
  const start = Math.max(0, firstDifference - 24)
  return `${start === 0 ? '' : '…'}${text.slice(start)}`
}

function describeLocation({ operation }: SurfacePatchInspectionStep): string {
  const destination = location(operation.path)
  if (operation.op === 'move')
    return `Move from ${location(operation.from)} to ${destination}. Positions follow the preceding changes.`
  return `${operation.op === 'add' ? 'Insert at' : 'Location:'} ${destination}. Changes are applied in the order shown.`
}

function location(path: string): string {
  if (!path) return 'the entire Surface'
  const positions = [...path.matchAll(/\/children\/(\d+|-)/g)].map((match) =>
    match[1] === '-' ? 'the end' : `item ${Number(match[1]) + 1}`,
  )
  return positions.length > 0
    ? `${positions.reverse().join(' inside ')} (${neutralizeDelimiters(path)})`
    : neutralizeDelimiters(path)
}

function reviewSide(
  id: string,
  title: string,
  value: JsonValue | undefined,
  state: JsonObject,
): AtomNode[] {
  return [
    { id: `${id}-title`, type: 'Title', props: { text: title, level: 3 } },
    ...(value === undefined
      ? literalText(
          id,
          title === 'Before'
            ? 'Nothing here: new content will be inserted.'
            : 'Removed: this content will no longer appear.',
        )
      : readOnlyValue(id, value, state)),
  ]
}

/** The closed catalog's declarations become literal text, including URLs, bindings and Action plans. */
function readOnlyValue(id: string, value: JsonValue, state: JsonObject): AtomNode[] {
  if (!isObject(value) || typeof value['type'] !== 'string' || typeof value['id'] !== 'string') {
    return literalText(id, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  }
  const children: AtomNode[] = literalText(`${id}-identity`, `${value['type']} · ${value['id']}`)
  const props = value['props']
  if (isObject(props)) {
    Object.entries(props).forEach(([key, content], index) => {
      children.push(...field(`${id}-prop-${index}`, fieldLabel(key), content))
    })
  }
  const binding = value['binding']
  if (typeof binding === 'string') {
    children.push(...field(`${id}-binding`, 'Data binding', binding))
    children.push(
      ...field(`${id}-bound-value`, 'Value when this review was prepared', state[binding] ?? null),
    )
  }
  const actions = value['actions']
  if (actions !== undefined)
    children.push(
      ...field(
        `${id}-actions`,
        'Declared actions · shown as text, never executed by this review',
        actions,
      ),
    )
  const nodes = value['children']
  if (Array.isArray(nodes)) {
    nodes.forEach((child, index) => {
      children.push({
        id: `${id}-child-${index}`,
        type: 'Col',
        children: [
          {
            id: `${id}-child-${index}-heading`,
            type: 'Caption',
            props: { text: `Item ${index + 1}` },
          },
          ...readOnlyValue(`${id}-child-${index}-content`, child, state),
        ],
      })
    })
  }
  return children
}

function field(id: string, label: string, value: JsonValue): AtomNode[] {
  return [
    { id: `${id}-label`, type: 'Label', props: { text: label } },
    ...literalText(
      id,
      typeof value === 'string' ? value || '(empty text)' : JSON.stringify(value, null, 2),
    ),
  ]
}

function fieldLabel(key: string): string {
  if (key === 'src') return 'Source URL'
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (first) => first.toUpperCase())
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Chunking respects the Text Atom limit without dropping any content or interpreting Markdown. */
function literalText(id: string, input: string): AtomNode[] {
  const text = neutralizeDelimiters(input)
  const chunks: AtomNode[] = []
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 32_000, text.length)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1
    chunks.push({
      id: `${id}-${chunks.length}`,
      type: 'Text',
      props: { text: text.slice(start, end) },
    })
    start = end
  }
  return chunks.length > 0 ? chunks : [{ id, type: 'Text', props: { text: '(empty)' } }]
}
