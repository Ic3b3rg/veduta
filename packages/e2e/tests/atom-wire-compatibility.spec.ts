import { expect, test } from './surface-contracts-fixture.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Simulates a newer Gateway at the browser transport, never at the canonical write boundary. */
function futureComposition(surface: unknown): void {
  if (!isRecord(surface) || surface['title'] !== 'Composed Surface') return
  const tree = surface['tree']
  if (!isRecord(tree)) return
  tree['type'] = 'FutureLayout'
  tree['futureRevision'] = 2
  visitChildren(tree)
}

function futurePreview(node: Record<string, unknown>): void {
  if (node['id'] !== 'composed-preview' || node['type'] !== 'Text') return
  const known = { ...node, id: 'future-preview-known' }
  node['type'] = 'FuturePreview'
  node['children'] = [known]
  node['actions'] = { futureVerb: 'record' }
}

function visitChildren(node: Record<string, unknown>): void {
  futurePreview(node)
  if (Array.isArray(node['children'])) {
    for (const child of node['children']) if (isRecord(child)) visitChildren(child)
  }
}

test('future Atoms from real HTTP and WebSocket reads remain visible after live replay and cached reload', async ({
  page,
  surfaceStack,
}) => {
  test.setTimeout(5 * 60_000)
  expect(surfaceStack.origin).toContain('localhost')
  let offlineSnapshot = false
  let liveCreation = 0
  let liveTreePatch = 0
  await page.route('**/api/spaces', async (route) => {
    if (offlineSnapshot) return route.abort('internetdisconnected')
    const response = await route.fetch()
    const snapshot: unknown = await response.json()
    if (isRecord(snapshot) && Array.isArray(snapshot['spaces'])) {
      for (const space of snapshot['spaces']) {
        if (!isRecord(space) || !Array.isArray(space['surfaces'])) continue
        for (const surface of space['surfaces']) futureComposition(surface)
      }
    }
    await route.fulfill({ response, json: snapshot })
  })
  await page.routeWebSocket('**/ws/gateway', (socket) => {
    const server = socket.connectToServer()
    server.onMessage((message) => {
      const frame: unknown = JSON.parse(message.toString())
      if (isRecord(frame) && isRecord(frame['event'])) {
        const event = frame['event']
        if (frame['type'] === 'surface.created' && isRecord(event['surface'])) {
          if (event['surface']['title'] === 'Composed Surface') liveCreation += 1
          futureComposition(event['surface'])
        }
        if (frame['type'] === 'surface.patch' && isRecord(event['patch'])) {
          const operations = event['patch']['operations']
          if (Array.isArray(operations)) {
            for (const operation of operations) {
              if (
                !isRecord(operation) ||
                operation['target'] !== 'tree' ||
                !isRecord(operation['value'])
              )
                continue
              if (operation['value']['id'] === 'composed-preview') liveTreePatch += 1
              futurePreview(operation['value'])
            }
          }
        }
      }
      socket.send(JSON.stringify(frame))
    })
  })
  // Reconnect after installing the wire transformation so the PWA uses its real transport and runtime.
  await page.reload()
  await page
    .getByRole('textbox', { name: 'Message Veduta in Health' })
    .fill('show composed surface demo')
  await page.getByRole('button', { name: 'Send message' }).click()
  const surface = page.locator('article.surface-card', {
    has: page.getByRole('button', { name: 'Focus Composed Surface', exact: true }),
  })
  await expect(surface.getByRole('status', { name: 'Comparison preview loading' })).toBeVisible()
  await expect(surface.getByText('Comparison preview ready', { exact: true })).toBeVisible()
  expect(liveCreation).toBeGreaterThan(0)
  expect(liveTreePatch).toBeGreaterThan(0)

  async function expectCompatibleComposition() {
    const root = surface.locator(
      '[data-testid="unknown-atom"][data-veduta-atom-id="composed-root"]',
    )
    const preview = surface.locator(
      '[data-testid="unknown-atom"][data-veduta-atom-id="composed-preview"]',
    )
    await expect(root).toBeVisible()
    await expect(root).toContainText('FutureLayout')
    await expect(preview).toBeVisible()
    await expect(preview).toContainText('FuturePreview (composed-preview)')
    await expect(
      surface.getByRole('heading', { name: 'Composed Surface', exact: true }),
    ).toBeVisible()
    await expect(surface.getByRole('table', { name: 'Section status' })).toBeVisible()
    await expect(surface.getByText('Canonical overview', { exact: true })).toBeVisible()
    await expect(surface.getByText('Comparison preview ready', { exact: true })).toBeVisible()
  }

  await expectCompatibleComposition()
  await page.reload()
  await expectCompatibleComposition()
  offlineSnapshot = true
  await page.reload()
  await expectCompatibleComposition()
  await expect(page.getByRole('alert')).toContainText(/fetch|network/i)
  offlineSnapshot = false
  await page.reload()
  await expectCompatibleComposition()
})
