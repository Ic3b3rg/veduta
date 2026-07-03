import type { AtomNode } from '@veduta/protocol'
import type { ReactNode } from 'react'
import {
  BadgeAtom,
  BoxAtom,
  ButtonAtom,
  CaptionAtom,
  CheckboxAtom,
  ColAtom,
  DividerAtom,
  ProgressAtom,
  RowAtom,
  StatAtom,
  TextAtom,
  TitleAtom,
  UnknownAtom,
} from './atoms.tsx'
import type { AtomProps, RenderContext } from './types.ts'

type AtomRenderer = (props: AtomProps) => ReactNode

/**
 * The scaffold subset of the catalog (issue #1). Types not yet
 * implemented render as UnknownAtom instead of crashing — visible,
 * never silent. Full catalog is issue #8.
 */
const renderers: Partial<Record<AtomNode['type'], AtomRenderer>> = {
  Box: BoxAtom,
  Row: RowAtom,
  Col: ColAtom,
  Divider: DividerAtom,
  Title: TitleAtom,
  Text: TextAtom,
  Caption: CaptionAtom,
  Badge: BadgeAtom,
  Stat: StatAtom,
  Progress: ProgressAtom,
  Checkbox: CheckboxAtom,
  Button: ButtonAtom,
}

export function renderNode(node: AtomNode, ctx: RenderContext): ReactNode {
  const Renderer = renderers[node.type] ?? UnknownAtom
  const children = (node.children ?? []).map((child) => renderNode(child, ctx))
  return (
    <Renderer key={node.id} node={node} ctx={ctx}>
      {children}
    </Renderer>
  )
}
