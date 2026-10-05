import { Button } from '@veduta/catalog/ui/button'
import { Component, lazy, Suspense, type ComponentProps, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { clientPath } from './client-router.tsx'

const ConnectionsPage = lazy(() =>
  import('./connections-page.tsx').then((module) => ({ default: module.ConnectionsPage })),
)

export function ConnectionsRoute(props: ComponentProps<typeof ConnectionsPage>) {
  return (
    <ConnectionsLoadBoundary>
      <Suspense
        fallback={
          <main className="p-8" role="status">
            Loading Connections…
          </main>
        }
      >
        <ConnectionsPage {...props} />
      </Suspense>
    </ConnectionsLoadBoundary>
  )
}

class ConnectionsLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override render() {
    if (!this.state.failed) return this.props.children
    return (
      <main className="p-8">
        <div role="alert">
          <h1>Connections could not load</h1>
          <p>Check your connection, then reload to try again.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => window.location.reload()}>Reload Connections</Button>
          <Button asChild variant="outline">
            <Link to={clientPath.home}>Back to Veduta</Link>
          </Button>
        </div>
      </main>
    )
  }
}
