import { Badge } from '@veduta/catalog/ui/badge'
import { Button } from '@veduta/catalog/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@veduta/catalog/ui/sheet'
import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import { Link } from 'react-router-dom'
import { clientPath } from './client-router.tsx'

export type ConnectionsSection = 'services' | 'models' | 'extensions' | 'access'

const sections: { id: ConnectionsSection; label: string; icon: string }[] = [
  { id: 'services', label: 'Accounts & services', icon: '◎' },
  { id: 'models', label: 'Models', icon: '✧' },
  { id: 'extensions', label: 'Extensions', icon: '◇' },
  { id: 'access', label: 'Space access', icon: '⊞' },
]

export function ConnectionsLayout({
  section,
  children,
}: {
  section: ConnectionsSection
  children: ReactNode
}) {
  return (
    <div className="connections-page">
      <aside className="connections-sidebar">
        <nav aria-label="Settings">
          {sections.map((item) => (
            <Button key={item.id} asChild variant="ghost" className="connections-nav-item">
              <Link
                to={`${clientPath.serviceConnections}?section=${item.id}`}
                aria-current={section === item.id ? 'page' : undefined}
              >
                <span aria-hidden="true">{item.icon}</span>
                {item.label}
              </Link>
            </Button>
          ))}
        </nav>
        <Button asChild variant="ghost" className="connections-back">
          <Link to={clientPath.home}>← Back to Veduta</Link>
        </Button>
      </aside>
      <main className="connections-content">{children}</main>
    </div>
  )
}

export function ConnectionListItem({
  title,
  subtitle,
  state,
  selected,
  onClick,
  returnFocusRef,
  children,
}: {
  title: string
  subtitle: string
  state: string
  selected: boolean
  onClick: () => void
  returnFocusRef?: RefObject<HTMLElement | null>
  children?: ReactNode
}) {
  return (
    <button
      ref={(element) => {
        if (element && selected && returnFocusRef) returnFocusRef.current = element
      }}
      type="button"
      className="connection-list-item"
      aria-pressed={selected}
      onClick={onClick}
    >
      <span className="connection-list-top">
        <strong>{title}</strong>
        <Badge variant="outline">{state.replaceAll('_', ' ').replaceAll('-', ' ')}</Badge>
      </span>
      <span className="connection-list-subtitle">{subtitle}</span>
      <span className="connection-list-meta">
        {children ?? 'View details'}
        <span aria-hidden="true">↗</span>
      </span>
    </button>
  )
}

function useMobileDetail(): boolean {
  const [mobile, setMobile] = useState(
    () => window.matchMedia?.('(max-width: 880px)').matches ?? false,
  )
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 880px)')
    if (!media) return
    const update = () => setMobile(window.matchMedia('(max-width: 880px)').matches)
    update()
    media.addEventListener('change', update)
    window.addEventListener('resize', update)
    return () => {
      media.removeEventListener('change', update)
      window.removeEventListener('resize', update)
    }
  }, [])
  return mobile
}

export function ConnectionDetail({
  title,
  description,
  children,
  onClose,
  opener,
}: {
  title: string
  description: string
  children: ReactNode
  onClose: () => void
  opener: RefObject<HTMLElement | null>
}) {
  const mobile = useMobileDetail()
  const header = (
    <header className="connection-detail-header">
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <Button variant="ghost" size="icon" aria-label="Close details" onClick={onClose}>
        ×
      </Button>
    </header>
  )
  if (mobile)
    return (
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open) onClose()
        }}
      >
        <SheetContent
          className="connection-drawer"
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            opener.current?.focus()
          }}
        >
          <SheetTitle className="sr-only">{title}</SheetTitle>
          <SheetDescription className="sr-only">{description}</SheetDescription>
          {header}
          {children}
        </SheetContent>
      </Sheet>
    )
  return (
    <aside className="connection-detail" aria-label={`${title} details`}>
      {header}
      {children}
    </aside>
  )
}

export function ConnectionDetailBody({ children }: { children: ReactNode }) {
  return <div className="connection-detail-body">{children}</div>
}

export function ConnectionDetailFooter({ children }: { children: ReactNode }) {
  return <footer className="connection-detail-footer">{children}</footer>
}
