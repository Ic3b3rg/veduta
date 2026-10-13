import { expect, test, type Page } from '@playwright/test'
import { DEMO_CREATE_REQUEST, DEMO_EDIT_REQUEST, DEMO_SPACE_REQUEST } from '@veduta/demo-data'

async function openChat(page: Page) {
  const launcher = page.getByRole('button', { name: 'Open Chat', exact: true })
  if (await launcher.isVisible()) await launcher.click()
}

async function closeChat(page: Page) {
  const close = page.getByRole('button', { name: 'Back to Space', exact: true })
  if (await close.isVisible()) await close.click()
}

async function acceptWork(page: Page) {
  await openChat(page)
  const conversation = page.locator('.chat-dock')
  await conversation.getByRole('button', { name: 'Accept Create Space “Work”' }).click()
  await conversation.getByRole('link', { name: 'Open Work', exact: true }).click()
  await expect(page.getByRole('main', { name: 'Work Space', exact: true })).toBeVisible()
}

for (const width of [1440, 390]) {
  test(`guided tour preserves an edited Surface and Chat at ${width}px without any API or external requests`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const requests: string[] = []
    const errors: string[] = []
    page.on('request', (request) => requests.push(request.url()))
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('demo.html')
    await expect(page.locator('.app-shell > .topbar')).toBeVisible()
    await expect(page.locator('.app-shell > .shell-layout > .space-navigation')).toBeVisible()
    if (width >= 960) {
      await expect(page.locator('.shell-layout > .chat-panel')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Open Chat', exact: true })).toBeHidden()
    } else {
      await expect(page.locator('.space-picker')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Open Chat', exact: true })).toBeVisible()
    }
    await page.locator('.demo-guide summary').click()
    await expect(page.getByText('Scripted responses.', { exact: false })).toBeVisible()
    await page.locator('.demo-guide summary').click()
    const send = async (text: string) => {
      await openChat(page)
      await page.getByRole('textbox', { name: /^Message Veduta/ }).fill(text)
      await page.getByRole('button', { name: 'Send message' }).click()
    }
    await send(DEMO_SPACE_REQUEST)
    await acceptWork(page)
    await send(DEMO_CREATE_REQUEST)
    await closeChat(page)
    await expect(page.getByRole('heading', { name: 'This week, in focus' })).toBeVisible()
    await send(DEMO_EDIT_REQUEST)
    await closeChat(page)
    await expect(page.getByRole('cell', { name: 'Tuesday', exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('cell', { name: 'Tuesday', exact: true })).toBeVisible()
    await expect(page.locator('[data-veduta-atom-id="weekly-priority"]')).toContainText(
      'Talk to testers',
    )
    await openChat(page)
    await expect(page.getByRole('log', { name: 'Conversation' })).toContainText(DEMO_EDIT_REQUEST)
    await closeChat(page)
    await page
      .getByRole('navigation', { name: 'Breadcrumb' })
      .getByRole('link', { name: 'Home', exact: true })
      .click()
    await page
      .locator('.space-card')
      .filter({ has: page.getByRole('heading', { name: 'Work', exact: true }) })
      .click()
    await expect(page.getByRole('cell', { name: 'Tuesday', exact: true })).toBeVisible()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1)
    expect(errors).toEqual([])
    expect(
      requests.filter(
        (url) =>
          new URL(url).origin !== 'http://127.0.0.1:5191' ||
          /\/(api|ws)(\/|$)/.test(new URL(url).pathname),
      ),
    ).toEqual([])
  })
}

test('visitors are isolated, Reset preserves unrelated storage, and corrupt/blocked storage is visible', async ({
  browser,
  page,
}) => {
  await page.goto('demo.html')
  await page.locator('.demo-guide summary').click()
  await page.getByRole('button', { name: DEMO_SPACE_REQUEST }).click()
  await acceptWork(page)
  const second = await browser.newContext()
  try {
    const visitor = await second.newPage()
    await visitor.goto('http://127.0.0.1:5191/veduta/demo.html')
    await visitor.locator('.demo-guide summary').click()
    await expect(visitor.getByRole('button', { name: DEMO_SPACE_REQUEST })).toBeVisible()
    await page.evaluate(() => localStorage.setItem('unrelated-test-value', 'keep'))
    await page.getByRole('button', { name: 'Reset demo' }).click()
    expect(await page.evaluate(() => localStorage.getItem('unrelated-test-value'))).toBe('keep')
    await page.evaluate(() => localStorage.setItem('veduta.public-demo.v1', '{"stage":"invalid"}'))
    await page.reload()
    await expect(page.getByRole('alert')).toContainText('could not be restored')
    await page.evaluate(() => {
      Storage.prototype.setItem = () => {
        throw new Error('Storage blocked')
      }
    })
    await page.locator('.demo-guide summary').click()
    await page.getByRole('button', { name: DEMO_SPACE_REQUEST }).click()
    await expect(page.getByRole('alert')).toContainText('refreshing will discard them')
  } finally {
    await second.close()
  }
})

test('landing serves its video, captions and proof images under a static-host subpath', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('./')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('AI agent a home')
  for (const selector of ['video source', 'video track', '.how img', 'video a']) {
    const src = await page.locator(selector).getAttribute(selector === 'video a' ? 'href' : 'src')
    if (!src) throw new Error(`Missing ${selector} asset`)
    expect((await page.request.get(new URL(src, page.url()).href)).ok()).toBe(true)
  }
  await page.locator('video').evaluate((video: HTMLVideoElement) => {
    video.muted = true
    video.load()
  })
  await expect
    .poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.readyState))
    .toBeGreaterThanOrEqual(1)
  await page.locator('video').evaluate((video: HTMLVideoElement) => video.play())
  await expect
    .poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeGreaterThan(0)
  await page.locator('video').evaluate((video: HTMLVideoElement) => video.pause())
  await page.getByText('Demo transcript and persistence proof', { exact: true }).click()
  await expect(
    page.getByText('The mock provider uses fixed responses.', { exact: false }),
  ).toBeVisible()
  expect(errors).toEqual([])
})

test('shared mobile Chat preserves drafts and focus while device effects stay disconnected', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'granted' })
    Notification.requestPermission = () => {
      throw new Error('The demo requested native permissions')
    }
    navigator.serviceWorker.register = () => {
      throw new Error('The demo registered a service worker')
    }
  })
  const requests: string[] = []
  const errors: string[] = []
  page.on('request', (request) => requests.push(request.url()))
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('demo.html')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('self-hosted app')
  await openChat(page)
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const bounds = await dialog.boundingBox()
  expect(bounds?.width).toBe(390)
  expect(bounds?.height).toBe(844)
  const input = page.getByRole('textbox', { name: /^Message Veduta/ })
  await expect(input).not.toBeFocused()
  await expect(page.getByRole('log', { name: 'Conversation' })).toContainText(DEMO_SPACE_REQUEST)
  await input.fill('A draft to keep')
  await closeChat(page)
  await expect(page.getByRole('button', { name: 'Open Chat', exact: true })).toBeFocused()
  await openChat(page)
  await expect(input).toHaveValue('A draft to keep')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByRole('log', { name: 'Conversation' })).toContainText(
    'three sample prompts',
  )
  await expect(input).toHaveValue('A draft to keep')
  await input.fill(DEMO_SPACE_REQUEST)
  await page.getByRole('button', { name: 'Send message' }).click()
  await page
    .locator('.chat-dock')
    .getByRole('button', { name: 'Reject Create Space “Work”' })
    .click()
  await expect(page.getByRole('log', { name: 'Conversation' })).toContainText('Rejected:')
  await page.reload()
  await openChat(page)
  await expect(page.getByRole('log', { name: 'Conversation' })).toContainText('Rejected:')
  await closeChat(page)
  await expect(
    page
      .locator('.space-card')
      .filter({ has: page.getByRole('heading', { name: 'Work', exact: true }) }),
  ).toHaveCount(0)
  expect(errors).toEqual([])
  expect(requests.filter((url) => /\/(api|ws)(\/|$)/.test(new URL(url).pathname))).toEqual([])
})
