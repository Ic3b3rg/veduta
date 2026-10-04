// Three throwaway #181 connection layouts on /app/prototype/connections?variant=A|B|C.
// Probe: can one dedicated page make accounts, models, extensions, and Space access clear?
// Uses Veduta catalog components and tokens; demo changes live only in React memory.
import { Button } from '@veduta/catalog/ui/button'
import { Input } from '@veduta/catalog/ui/input'
import { Badge } from '@veduta/catalog/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@veduta/catalog/ui/card'
import { Checkbox } from '@veduta/catalog/ui/checkbox'
import { Separator } from '@veduta/catalog/ui/separator'
import { catalogTokens } from '@veduta/catalog'
import { useCallback, useState, type CSSProperties } from 'react'
import { BrowserRouter, useSearchParams } from 'react-router-dom'
import {
  demoConnections,
  demoSpaces,
  sectionDescriptions,
  sectionLabels,
  type DemoConnection,
  type PrototypeSection,
  type PrototypeVariant,
} from './connections-prototype-data.ts'
import { ProviderMark, PrototypeIcon } from './connections-prototype-icons.tsx'
import { CatalogVariant, ControlVariant, GuidedVariant } from './connections-prototype-variants.tsx'
import { PrototypeConnectionWizard } from './connections-prototype-wizard.tsx'
import { PrototypeSwitcher } from './prototype-switcher.tsx'
import './connections-prototype.css'

const typography: CSSProperties & Record<`--cp-font-${string}`, string> = Object.fromEntries(
  Object.entries(catalogTokens.light.font)
    .filter((entry) => typeof entry[1] === 'number')
    .map(([key, value]) => [`--cp-font-${key}`, `${value}px`]),
)

function connectionMode(item: DemoConnection) {
  return item.status === 'connected' ||
    item.status === 'disabled' ||
    item.status === 'included' ||
    item.status === 'previewed'
    ? 'manage'
    : 'connect'
}

export function ConnectionsPrototype() {
  return (
    <BrowserRouter>
      <ConnectionsPrototypePage />
    </BrowserRouter>
  )
}

function ConnectionsPrototypePage() {
  const [params, setParams] = useSearchParams()
  const variant: PrototypeVariant =
    params.get('variant') === 'B' ? 'B' : params.get('variant') === 'C' ? 'C' : 'A'
  const rawSection = params.get('section')
  const section: PrototypeSection =
    rawSection === 'overview' ||
    rawSection === 'models' ||
    rawSection === 'extensions' ||
    rawSection === 'access'
      ? rawSection
      : 'services'
  const [connections, setConnections] = useState(() =>
    demoConnections.map((item) => ({ ...item, spaces: [...item.spaces] })),
  )
  const [selectedModel, setSelectedModel] = useState('chatgpt')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'connected' | 'available'>('all')
  const [mobileNav, setMobileNav] = useState(false)
  const [dialog, setDialog] = useState<{
    item: DemoConnection | null
    mode: 'connect' | 'manage'
  } | null>(() => {
    const item = demoConnections.find((connection) => connection.category === section)
    return item && variant !== 'B' && !window.matchMedia('(max-width: 880px)').matches
      ? { item, mode: connectionMode(item) }
      : null
  })
  const [notice, setNotice] = useState('')
  const changeVariant = useCallback(
    (next: PrototypeVariant) =>
      setParams(
        (current) => {
          const nextParams = new URLSearchParams(current)
          nextParams.set('variant', next)
          return nextParams
        },
        { replace: true },
      ),
    [setParams],
  )
  const changeSection = (next: PrototypeSection) => {
    setParams((current) => {
      const nextParams = new URLSearchParams(current)
      nextParams.set('section', next)
      return nextParams
    })
    setSearch('')
    setFilter('all')
    setMobileNav(false)
    setDialog(null)
  }
  const openItem = (item: DemoConnection) =>
    setDialog({
      item,
      mode: connectionMode(item),
    })
  const saveItem = (item: DemoConnection) => {
    setConnections((current) => current.map((value) => (value.id === item.id ? item : value)))
    setDialog(null)
    if (selectedModel === item.id && item.status !== 'connected') setSelectedModel('')
    setNotice(
      `Demo ${item.name} updated. ${item.category === 'models' ? 'Model inference only.' : item.status === 'previewed' ? 'Setup preview saved.' : item.spaces.length ? `Access: ${item.spaces.join(', ')}.` : 'No Space access.'}`,
    )
  }
  const items = connections.filter(
    (item) =>
      item.category === section &&
      `${item.name} ${item.description} ${item.account}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (filter === 'all' ||
        (filter === 'connected'
          ? item.status === 'connected' || item.status === 'included'
          : item.status === 'available')),
  )
  const connectedServices = connections.filter(
    (item) => item.category === 'services' && item.status === 'connected',
  )
  const attention = connections.filter((item) => item.status === 'needs_reconnect')
  const variantProps = {
    items,
    onOpen: openItem,
    selectedModel,
    selectedConnection: dialog?.item?.id,
  }
  const hasDetailPanel =
    dialog !== null ||
    (variant !== 'B' &&
      (section === 'services' || section === 'models' || section === 'extensions'))
  const connectionDetail = dialog ? (
    <PrototypeConnectionWizard
      key={`${dialog.item?.id ?? 'choose'}-${dialog.mode}`}
      item={dialog.item}
      mode={dialog.mode}
      catalog={connections.filter((item) =>
        section === 'models' || section === 'extensions' ? item.category === section : true,
      )}
      onChoose={(item) => setDialog({ item, mode: connectionMode(item) })}
      onClose={() => setDialog(null)}
      onSave={saveItem}
      onReconnect={() => {
        if (dialog.item) setDialog({ item: dialog.item, mode: 'connect' })
      }}
      onSelectModel={() => {
        if (dialog.item) {
          setSelectedModel(dialog.item.id)
          setDialog(null)
          setNotice(`Demo Agent default set to ${dialog.item.name}.`)
        }
      }}
    />
  ) : (
    <Card className="cp-detail-empty" id="cp-connection-detail">
      <PrototypeIcon name="services" size={26} />
      <strong>Select a connection</strong>
      <p>Account details, setup, and Space access appear here.</p>
    </Card>
  )
  const navSections: PrototypeSection[] = ['overview', 'services', 'models', 'extensions', 'access']
  return (
    <div className={`cp-app cp-variant-${variant}`} style={typography}>
      <a className="cp-skip" href="#cp-main">
        Skip to content
      </a>
      <aside
        className={`cp-sidebar ${mobileNav ? 'cp-nav-open' : ''}`}
        aria-label="Connections navigation"
      >
        <div className="cp-brand">
          <span className="cp-brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32">
              <path
                d="M6 8l10 18L26 8 M11 8l5 9 5-9"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <div>
            <strong>Veduta</strong>
            <span>Connections & integrations</span>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="cp-mobile-close"
            aria-label="Close navigation"
            onClick={() => setMobileNav(false)}
          >
            <PrototypeIcon name="close" />
          </Button>
        </div>
        <nav>
          {navSections.map((value) => (
            <Button
              key={value}
              variant="ghost"
              className={`cp-nav-item ${section === value ? 'cp-nav-active' : ''}`}
              aria-current={section === value ? 'page' : undefined}
              onClick={() => changeSection(value)}
            >
              <PrototypeIcon name={value} />
              <span>{sectionLabels[value]}</span>
              {value === 'models' && attention.length > 0 && (
                <Badge variant="secondary">{attention.length}</Badge>
              )}
            </Button>
          ))}
        </nav>
        <div className="cp-sidebar-bottom">
          <Separator />
          <div className="cp-installation">
            <span className="cp-demo-dot" />
            <span>Demo installation</span>
            <Badge variant="outline">Prototype</Badge>
          </div>
          <Button variant="ghost" className="cp-back" asChild>
            <a href="http://localhost:8788/">
              <PrototypeIcon name="back" />
              <span>Back to Veduta</span>
            </a>
          </Button>
        </div>
      </aside>
      <div className="cp-content">
        <header className="cp-topbar">
          <div>
            <Button
              variant="ghost"
              size="icon-sm"
              className="cp-mobile-toggle"
              aria-label="Open navigation"
              onClick={() => setMobileNav(true)}
            >
              <PrototypeIcon name="menu" />
            </Button>
            <span>Connections & integrations</span>
            <span className="cp-breadcrumb">/</span>
            <strong>{sectionLabels[section]}</strong>
          </div>
          <Badge variant="outline">Demo data</Badge>
        </header>
        <main id="cp-main" className="cp-main">
          <div className="cp-page-heading">
            <div>
              <h1>{sectionLabels[section]}</h1>
              <p>{sectionDescriptions[section]}</p>
            </div>
            <Button onClick={() => setDialog({ item: null, mode: 'connect' })}>
              <PrototypeIcon name="plus" />
              {section === 'models'
                ? 'Add model'
                : section === 'extensions'
                  ? 'Add extension'
                  : 'Add connection'}
            </Button>
          </div>
          {notice && (
            <div className="cp-notice" role="status">
              <PrototypeIcon name="check" />
              <span>{notice}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Dismiss notice"
                onClick={() => setNotice('')}
              >
                <PrototypeIcon name="close" />
              </Button>
            </div>
          )}
          <div className={hasDetailPanel ? 'cp-workspace cp-with-detail' : 'cp-workspace'}>
            <div className="cp-workspace-list">
              {(section === 'services' || section === 'models' || section === 'extensions') && (
                <>
                  <div className="cp-toolbar">
                    <div className="cp-filters" aria-label="Filter connections">
                      {(['all', 'connected', 'available'] as const).map((value) => (
                        <Button
                          key={value}
                          variant={filter === value ? 'secondary' : 'ghost'}
                          size="sm"
                          aria-pressed={filter === value}
                          onClick={() => setFilter(value)}
                        >
                          {value === 'all'
                            ? 'All'
                            : value === 'connected'
                              ? 'Connected / included'
                              : 'Available'}
                        </Button>
                      ))}
                    </div>
                    <label className="cp-search">
                      <PrototypeIcon name="search" size={17} />
                      <Input
                        aria-label="Search connections"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Search connections…"
                      />
                    </label>
                  </div>
                  {!items.length ? (
                    <Card className="cp-empty">
                      <CardContent>
                        No matching connections. Try another search or filter.
                      </CardContent>
                    </Card>
                  ) : variant === 'A' ? (
                    <CatalogVariant {...variantProps} />
                  ) : variant === 'B' ? (
                    <ControlVariant {...variantProps} />
                  ) : (
                    <GuidedVariant {...variantProps} />
                  )}
                  <div className="cp-explainer">
                    <PrototypeIcon name="access" size={20} />
                    <div>
                      <strong>
                        {section === 'services'
                          ? 'One account, explicit access for each Space'
                          : section === 'models'
                            ? 'Same Agent, whichever model you choose'
                            : 'Capabilities and accounts stay separate'}
                      </strong>
                      <p>
                        {section === 'services'
                          ? 'A connected account is passive until you ask for work or a confirmed Automation runs. Manage its Space access here.'
                          : section === 'models'
                            ? 'Your Model connection provides inference. Veduta keeps ownership of tools, memory, and Surfaces.'
                            : 'Included GitHub MCP support is ready to configure. Your GitHub account still needs to be connected and granted to a Space.'}
                      </p>
                      {section === 'services' && (
                        <Button variant="link" size="sm" onClick={() => changeSection('access')}>
                          Manage Space access
                        </Button>
                      )}
                    </div>
                  </div>
                </>
              )}
              {section === 'overview' && (
                <>
                  <div className="cp-overview-stats">
                    {[
                      {
                        title: 'Service accounts',
                        value: connectedServices.length,
                        detail: 'Connected in this demo',
                        section: 'services',
                      },
                      {
                        title: 'Model connections',
                        value: connections.filter(
                          (item) => item.category === 'models' && item.status === 'connected',
                        ).length,
                        detail: selectedModel
                          ? `${connections.find((item) => item.id === selectedModel)?.name ?? 'Model'} is the Agent default`
                          : 'Choose an Agent default',
                        section: 'models',
                      },
                      {
                        title: 'Included capabilities',
                        value: connections.filter((item) => item.status === 'included').length,
                        detail: 'Skills and MCP support',
                        section: 'extensions',
                      },
                    ].map((stat) => (
                      <Card key={stat.title} className="cp-stat-card">
                        <CardHeader>
                          <CardTitle>{stat.title}</CardTitle>
                        </CardHeader>
                        <CardContent>
                          <strong>{stat.value}</strong>
                          <p>{stat.detail}</p>
                          <Button
                            variant="link"
                            onClick={() =>
                              changeSection(
                                stat.section === 'models'
                                  ? 'models'
                                  : stat.section === 'extensions'
                                    ? 'extensions'
                                    : 'services',
                              )
                            }
                          >
                            Manage
                            <PrototypeIcon name="arrow" size={16} />
                          </Button>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                  <div className="cp-overview-columns">
                    <Card>
                      <CardHeader>
                        <CardTitle>Needs your attention</CardTitle>
                      </CardHeader>
                      <CardContent>
                        {attention.map((item) => (
                          <div className="cp-attention-row" key={item.id}>
                            <PrototypeIcon name="alert" />
                            <div>
                              <strong>{item.name}</strong>
                              <p>The demo API connection needs authorization again.</p>
                            </div>
                            <Button variant="outline" onClick={() => openItem(item)}>
                              Reconnect
                            </Button>
                          </div>
                        ))}
                        {!attention.length && <p>Your demo connections are up to date.</p>}
                      </CardContent>
                    </Card>
                    <Card>
                      <CardHeader>
                        <CardTitle>Add your next service</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <p>Connect GitHub to bring repository work into the Space you choose.</p>
                        <Button
                          onClick={() => {
                            const item = connections.find((value) => value.id === 'github')
                            if (item) openItem(item)
                          }}
                        >
                          Connect GitHub
                          <PrototypeIcon name="arrow" size={16} />
                        </Button>
                      </CardContent>
                    </Card>
                  </div>
                </>
              )}
              {section === 'access' && (
                <div className="cp-access-grid">
                  {demoSpaces.map((space) => (
                    <Card key={space} className="cp-space-card">
                      <CardHeader>
                        <CardTitle>
                          <span className={`cp-space-icon cp-space-${space.toLowerCase()}`}>
                            {space.slice(0, 1)}
                          </span>
                          {space}
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        {connections
                          .filter((item) => item.category === 'services')
                          .map((item) => (
                            <div className="cp-grant-row" key={item.id}>
                              <ProviderMark id={item.id} />
                              <div>
                                <strong>{item.name}</strong>
                                <span>
                                  {item.status === 'connected'
                                    ? item.spaces.includes(space)
                                      ? 'Read access'
                                      : 'No access'
                                    : 'Connect the account first'}
                                </span>
                              </div>
                              <Checkbox
                                aria-label={`${space} access to ${item.name}`}
                                disabled={item.status !== 'connected'}
                                checked={item.spaces.includes(space)}
                                onCheckedChange={() => {
                                  const spaces = item.spaces.includes(space)
                                    ? item.spaces.filter((value) => value !== space)
                                    : [...item.spaces, space]
                                  setConnections((current) =>
                                    current.map((value) =>
                                      value.id === item.id ? { ...item, spaces } : value,
                                    ),
                                  )
                                  setNotice(`Demo ${item.name} access updated for ${space}.`)
                                }}
                              />
                            </div>
                          ))}
                      </CardContent>
                    </Card>
                  ))}
                  <p className="cp-access-footnote">
                    Changing access applies to future work. Existing Surfaces and results stay in
                    their owning Space.
                  </p>
                </div>
              )}
              <details className="cp-state">
                <summary>
                  Prototype state <span>In memory · resets on reload</span>
                </summary>
                <pre>
                  {JSON.stringify(
                    {
                      variant,
                      section,
                      selectedModel,
                      selectedConnection: dialog?.item?.id,
                      connections,
                    },
                    null,
                    2,
                  )}
                </pre>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setConnections(
                      demoConnections.map((item) => ({ ...item, spaces: [...item.spaces] })),
                    )
                    setSelectedModel('chatgpt')
                    setDialog(null)
                    setNotice('Demo state reset.')
                  }}
                >
                  Reset demo
                </Button>
              </details>
            </div>
            {hasDetailPanel && connectionDetail}
          </div>
        </main>
      </div>
      <PrototypeSwitcher variant={variant} onChange={changeVariant} />
    </div>
  )
}
