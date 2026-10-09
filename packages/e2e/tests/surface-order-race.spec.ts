import { GatewayServerMessageSchema } from '../../protocol/src/index.ts'
import { expect, test } from './surface-contracts-fixture.ts'
import { signal, surfaceCard } from './fast-actions-journey.ts'

for (const recovery of ['snapshot', 'Pin confirmation'] as const) {
  test(`reconciles out-of-order accepted commands through ${recovery} without a false failure`, async ({
    page,
    surfaceStack,
  }) => {
    expect(surfaceStack.origin).toBeTruthy()
    const heldFrames: (() => void)[] = []
    let holdFrames = true
    await page.routeWebSocket('**/ws/gateway', (socket) => {
      const server = socket.connectToServer()
      server.onMessage((message) => {
        const frame = GatewayServerMessageSchema.parse(JSON.parse(message.toString()))
        const send = () => socket.send(message)
        if (holdFrames && (frame.type === 'surface.pinned' || frame.type === 'surface.moved'))
          heldFrames.push(send)
        else send()
      })
    })
    await page.reload()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
    const pinCommitted = signal<void>()
    const pinReply = signal<void>()
    const readReply = signal<void>()
    const readRequested = signal<void>()
    let holdReads = false
    let pinRequests = 0
    let moveRequests = 0
    await page.route('**/api/spaces', async (route) => {
      if (holdReads) {
        readRequested.resolve()
        await readReply.promise
      }
      await route.continue()
    })
    await page.route('**/api/surfaces/*/pin', async (route) => {
      pinRequests += 1
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      pinCommitted.resolve()
      await pinReply.promise
      await route.fulfill({ response })
    })
    await page.route('**/api/spaces/*/surfaces/*/move', async (route) => {
      moveRequests += 1
      await route.continue()
    })
    const goal = surfaceCard(page, 'Weight goal')
    const groceries = surfaceCard(page, 'Groceries')
    await goal.getByRole('button', { name: 'Pin Weight goal', exact: true }).click()
    await pinCommitted.promise
    holdReads = true
    await groceries.getByRole('button', { name: 'Move Groceries up', exact: true }).click()
    await expect(groceries.getByRole('status')).toHaveText(
      'Move "Groceries" up accepted. Waiting for the current Surface order…',
    )
    await expect(groceries.getByRole('alert')).toHaveCount(0)
    await readRequested.promise
    if (recovery === 'snapshot') {
      holdReads = false
      readReply.resolve()
    } else pinReply.resolve()
    await expect(groceries.getByRole('status')).toHaveCount(0)
    await expect(groceries.getByRole('button', { name: 'Move Groceries up' })).toBeEnabled()
    await expect(
      goal.getByRole('button', { name: 'Pinned Weight goal', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    holdReads = false
    readReply.resolve()
    pinReply.resolve()
    holdFrames = false
    heldFrames.splice(0).forEach((send) => send())
    await expect(goal.getByRole('status')).toHaveCount(0)
    await expect(goal.getByRole('alert')).toHaveCount(0)
    await expect(groceries.getByRole('alert')).toHaveCount(0)
    const titles = () =>
      page
        .getByRole('main', { name: 'Health Space' })
        .getByRole('button', { name: /^Focus / })
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')))
    expect((await titles()).slice(0, 4)).toEqual([
      'Focus Weight goal',
      'Focus Nightly Reflection',
      'Focus Groceries',
      'Focus Automations',
    ])
    await page.reload()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
    expect((await titles()).slice(0, 4)).toEqual([
      'Focus Weight goal',
      'Focus Nightly Reflection',
      'Focus Groceries',
      'Focus Automations',
    ])
    expect(pinRequests).toBe(1)
    expect(moveRequests).toBe(1)
  })
}
