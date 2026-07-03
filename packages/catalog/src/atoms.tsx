import type { ReactNode } from 'react'
import type { AtomProps } from './types.ts'

/**
 * Minimal renderers for the scaffold (issue #1). The real design system
 * lands with issue #8 — these exist so the Home renders seed Surfaces.
 * Every interactive Atom dispatches through its declared actions only.
 * Children arrive pre-rendered from the tree walker (render.tsx), so
 * atoms never depend on the renderer.
 */

const text = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''))

export function BoxAtom({ children }: AtomProps): ReactNode {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
}

export function RowAtom({ children }: AtomProps): ReactNode {
  return <div style={{ display: 'flex', gap: 16 }}>{children}</div>
}

export function ColAtom({ children }: AtomProps): ReactNode {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>{children}</div>
}

export function DividerAtom(): ReactNode {
  return <hr style={{ border: 'none', borderTop: '1px solid #e2e2e2', margin: '4px 0' }} />
}

export function TitleAtom({ node }: AtomProps): ReactNode {
  return <h3 style={{ margin: 0, fontSize: 16 }}>{text(node.props?.['text'])}</h3>
}

export function TextAtom({ node }: AtomProps): ReactNode {
  return <p style={{ margin: 0 }}>{text(node.props?.['text'])}</p>
}

export function CaptionAtom({ node }: AtomProps): ReactNode {
  return <small style={{ color: '#777' }}>{text(node.props?.['text'])}</small>
}

export function BadgeAtom({ node }: AtomProps): ReactNode {
  return (
    <span style={{ background: '#eef', borderRadius: 999, padding: '2px 10px', fontSize: 12 }}>
      {text(node.props?.['text'])}
    </span>
  )
}

export function StatAtom({ node, ctx }: AtomProps): ReactNode {
  const value = node.binding ? ctx.state[node.binding] : undefined
  return (
    <div>
      <div style={{ fontSize: 12, color: '#777' }}>{text(node.props?.['label'])}</div>
      <div style={{ fontSize: 24, fontWeight: 600 }}>{text(value)}</div>
    </div>
  )
}

export function ProgressAtom({ node, ctx }: AtomProps): ReactNode {
  const raw = node.binding ? ctx.state[node.binding] : 0
  const ratio = Math.min(1, Math.max(0, typeof raw === 'number' ? raw : 0))
  return (
    <div aria-label={text(node.props?.['label'])} role="progressbar" aria-valuenow={ratio * 100}>
      <div style={{ background: '#eee', borderRadius: 6, height: 8 }}>
        <div style={{ background: '#4a7', borderRadius: 6, height: 8, width: `${ratio * 100}%` }} />
      </div>
    </div>
  )
}

export function CheckboxAtom({ node, ctx }: AtomProps): ReactNode {
  const checked = node.binding ? Boolean(ctx.state[node.binding]) : false
  const toggle = node.actions?.find((a) => a.name === 'toggle')
  return (
    <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={() => toggle && ctx.dispatch(node, toggle.name, !checked)}
      />
      {text(node.props?.['label'])}
    </label>
  )
}

export function ButtonAtom({ node, ctx }: AtomProps): ReactNode {
  const action = node.actions?.[0]
  return (
    <button type="button" onClick={() => action && ctx.dispatch(node, action.name)}>
      {text(node.props?.['label'])}
    </button>
  )
}

export function UnknownAtom({ node }: AtomProps): ReactNode {
  return <em data-testid="unknown-atom">unsupported atom: {node.type}</em>
}
