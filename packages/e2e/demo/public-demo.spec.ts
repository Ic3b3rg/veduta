import { expect, test } from '@playwright/test'
import { DEMO_CREATE_REQUEST, DEMO_EDIT_REQUEST, DEMO_SPACE_REQUEST } from '@veduta/demo-data'

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
    await expect(page.getByText('Scripted responses.', { exact: false })).toBeVisible()
    const send = async (text: string) => {
      await page.getByRole('textbox', { name: /^Message Veduta/ }).fill(text)
      await page.getByRole('button', { name: 'Send message' }).click()
    }
    await send(DEMO_SPACE_REQUEST)
    await page.getByRole('button', { name: 'Accept Create Space “Work”' }).click()
    await send(DEMO_CREATE_REQUEST)
    await expect(page.getByRole('heading', { name: 'This week, in focus' })).toBeVisible()
    await send(DEMO_EDIT_REQUEST)
    await expect(page.getByRole('cell', { name: 'Tuesday', exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('cell', { name: 'Tuesday', exact: true })).toBeVisible()
    await expect(page.locator('[data-veduta-atom-id="weekly-priority"]')).toContainText(
      'Talk to testers',
    )
    await expect(page.getByRole('log', { name: 'Conversation' })).toContainText(DEMO_EDIT_REQUEST)
    await page
      .getByRole('navigation', { name: 'Demo Spaces' })
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
  await page.getByRole('button', { name: DEMO_SPACE_REQUEST }).click()
  await page.getByRole('button', { name: 'Accept Create Space “Work”' }).click()
  const second = await browser.newContext()
  try {
    const visitor = await second.newPage()
    await visitor.goto('http://127.0.0.1:5191/veduta/demo.html')
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
