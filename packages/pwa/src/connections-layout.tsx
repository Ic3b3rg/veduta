import { Badge } from '@veduta/catalog/ui/badge'
import { Button } from '@veduta/catalog/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@veduta/catalog/ui/sheet'
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from '@veduta/catalog/ui/sidebar'
import {
  ArrowLeft,
  Blocks,
  Cable,
  KeyRound,
  MonitorSmartphone,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import { Link } from 'react-router-dom'
import { clientPath } from './client-router.tsx'

export type ConnectionsSection =
  'services' | 'models' | 'extensions' | 'access' | 'devices' | 'spaces' | 'automations'

const sections: { id: ConnectionsSection; label: string; icon: LucideIcon }[] = [
  { id: 'services', label: 'Accounts & services', icon: Cable },
  { id: 'models', label: 'Models', icon: Sparkles },
  { id: 'spaces', label: 'Spaces & memory', icon: Blocks },
  { id: 'automations', label: 'Automations', icon: Sparkles },
  { id: 'extensions', label: 'Extensions', icon: Blocks },
  { id: 'access', label: 'Space access', icon: KeyRound },
  { id: 'devices', label: 'Devices', icon: MonitorSmartphone },
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
      <Sidebar className="connections-sidebar">
        <SidebarHeader className="px-5 pt-6 pb-4">
          <span className="text-sm font-semibold">Connections</span>
          <span className="text-xs text-muted-foreground">Manage your Veduta</span>
        </SidebarHeader>
        <SidebarContent>
          <nav aria-label="Settings">
            <SidebarMenu className="connections-navigation">
              {sections.map(({ id, label, icon: Icon }) => (
                <SidebarMenuItem key={id}>
                  <SidebarMenuButton asChild isActive={section === id}>
                    <Link
                      to={`${clientPath.serviceConnections}?section=${id}`}
                      aria-current={section === id ? 'page' : undefined}
                    >
                      <Icon aria-hidden="true" />
                      <span>{label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </nav>
        </SidebarContent>
        <SidebarFooter className="border-t border-border">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <Link to={clientPath.home}>
                  <ArrowLeft aria-hidden="true" />
                  <span>Back to Veduta</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <main className="connections-content">{children}</main>
    </div>
  )
}

export function ConnectionListItem({
  title,
  subtitle,
  state,
  selected,
  disabled = false,
  onClick,
  returnFocusRef,
  children,
}: {
  title: string
  subtitle: string
  state: string
  selected: boolean
  disabled?: boolean
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
      disabled={disabled}
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
  fallbackOpener,
  modal = false,
  busy = false,
}: {
  title: string
  description: string
  children: ReactNode
  onClose: () => void
  opener: RefObject<HTMLElement | null>
  fallbackOpener?: RefObject<HTMLElement | null>
  modal?: boolean
  busy?: boolean
}) {
  const mobile = useMobileDetail()
  const header = (
    <header className="connection-detail-header">
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Close details"
        disabled={busy}
        onClick={onClose}
      >
        ×
      </Button>
    </header>
  )
  if (mobile || modal)
    return (
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open && !busy) onClose()
        }}
      >
        <SheetContent
          className={mobile ? 'connection-drawer' : 'connection-drawer connection-modal'}
          showCloseButton={false}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const target =
              opener.current?.isConnected && !opener.current.matches(':disabled')
                ? opener.current
                : fallbackOpener?.current
            target?.focus()
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
