import { SurfaceSchema } from '@veduta/protocol'
import { isRecord, parseJson, toolCallMessage, toolResultText } from './mock-fixture-support.ts'
import {
  piFauxAssistantMessage,
  type PiAssistantMessage,
  type PiChatContext,
} from './pi-provider-bridge.ts'

/** Exact deterministic model fixture for the generic issue #148 browser journey. */
export const COMPOSED_SURFACE_REQUEST = 'show composed surface demo'
type ToolResult = Extract<PiChatContext['messages'][number], { role: 'toolResult' }>

export async function respondToComposedSurface(
  results: ToolResult[],
  delayMs: number,
): Promise<PiAssistantMessage> {
  if (!results.some((result) => result.toolName === 'list_surfaces'))
    return toolCallMessage('list_surfaces', {}, 'Checking Surfaces before composing the layout.')
  const created = results.find((result) => result.toolName === 'create_surface')
  if (!created)
    return toolCallMessage(
      'create_surface',
      composedSurfaceInput(),
      'Composing the canonical layout with one Pending preview.',
    )
  if (created.isError)
    return piFauxAssistantMessage(
      `The composed Surface was not created: ${toolResultText(created)}`,
    )
  const patched = results.find((result) => result.toolName === 'patch_tree')
  if (patched?.isError)
    return piFauxAssistantMessage(
      'The composed preview could not be completed; the existing Surface remains available.',
    )
  const reads = results.filter((result) => result.toolName === 'read_surface')
  const latestRead = reads.at(-1)
  if (!latestRead || (patched && reads.length < 2))
    return toolCallMessage(
      'read_surface',
      { surfaceId: 'srf-composed-demo' },
      'Reading the canonical composition.',
    )
  const parsed = parseJson(toolResultText(latestRead))
  const surface = SurfaceSchema.safeParse(isRecord(parsed) ? parsed['surface'] : undefined)
  if (latestRead.isError || !surface.success)
    return piFauxAssistantMessage(
      'The composed Surface could not be verified; no content summary is available.',
    )
  if (!patched) {
    const treeVersion = isRecord(parsed) ? parsed['treeVersion'] : undefined
    if (typeof treeVersion !== 'number' || !Number.isInteger(treeVersion) || treeVersion < 1)
      return piFauxAssistantMessage('The composed Surface version could not be verified.')
    if (delayMs > 0) await new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs))
    return toolCallMessage(
      'patch_tree',
      {
        surfaceId: surface.data.id,
        expectedTreeVersion: treeVersion,
        operations: [
          {
            target: 'tree',
            op: 'replace',
            path: '/children/6',
            value: {
              id: 'composed-preview',
              type: 'Text',
              props: { text: 'Comparison preview ready' },
            },
          },
        ],
      },
      'Replacing the Pending preview in the committed layout.',
    )
  }
  const preview = surface.data.tree.children?.find((node) => node.id === 'composed-preview')
  if (preview?.type !== 'Text' || typeof preview.props?.['text'] !== 'string')
    return piFauxAssistantMessage('The committed preview remains unavailable.')
  return piFauxAssistantMessage(`Saved ${surface.data.title}: ${preview.props['text']}.`)
}

function composedSurfaceInput(): Record<string, unknown> {
  return {
    id: 'srf-composed-demo',
    title: 'Composed Surface',
    state: {},
    tree: {
      id: 'composed-root',
      type: 'Box',
      props: { gap: 'lg', padding: 'md' },
      children: [
        { id: 'composed-title', type: 'Title', props: { text: 'Composed Surface', level: 2 } },
        {
          id: 'composed-row',
          type: 'Row',
          props: { gap: 'md', align: 'stretch', wrap: true },
          children: [
            {
              id: 'composed-overview',
              type: 'Col',
              props: { gap: 'xs' },
              children: [
                {
                  id: 'composed-overview-copy',
                  type: 'Text',
                  props: { text: 'Canonical overview' },
                },
                {
                  id: 'composed-stat',
                  type: 'Stat',
                  props: { label: 'Available sections', value: 2, unit: 'sections' },
                },
              ],
            },
            {
              id: 'composed-details',
              type: 'Col',
              props: { gap: 'sm' },
              children: [
                {
                  id: 'composed-table',
                  type: 'Table',
                  props: {
                    caption: 'Section status',
                    columns: ['section', 'status'],
                    rows: [
                      { section: 'Overview', status: 'Ready' },
                      { section: 'Details', status: 'Ready' },
                    ],
                  },
                },
              ],
            },
          ],
        },
        { id: 'composed-spacer', type: 'Spacer', props: { size: 'xs' } },
        { id: 'composed-divider', type: 'Divider' },
        {
          id: 'composed-media',
          type: 'Col',
          props: { gap: 'sm' },
          children: [
            {
              id: 'composed-icon',
              type: 'Icon',
              props: { name: 'check', label: 'All sections available', tone: 'success' },
            },
            {
              id: 'composed-image',
              type: 'Image',
              props: { src: '/icons/icon-192.svg', alt: 'Veduta mark', loading: 'eager' },
            },
            {
              id: 'composed-failed-image',
              type: 'Image',
              props: {
                src: '/missing-surface-preview.png',
                alt: 'Surface preview',
                loading: 'eager',
              },
            },
          ],
        },
        {
          id: 'composed-transition',
          type: 'Transition',
          props: { visible: false },
          children: [
            {
              id: 'composed-transition-copy',
              type: 'Text',
              props: { text: 'Canonical content stays visible with reduced motion.' },
            },
          ],
        },
        {
          id: 'composed-preview',
          type: 'Pending',
          props: { variant: 'text', label: 'Comparison preview', lines: 2 },
        },
      ],
    },
  }
}
