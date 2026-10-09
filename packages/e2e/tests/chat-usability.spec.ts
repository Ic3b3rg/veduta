import { expect, test } from './surface-contracts-fixture.ts'

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

test('mobile Chat preserves navigation focus, multiline drafts and readable replies after reload', async ({
  page,
  surfaceStack,
}, testInfo) => {
  test.setTimeout(5 * 60_000)
  expect(surfaceStack.origin).toBeTruthy()
  const composer = page.getByRole('textbox', { name: 'Message Veduta in Health' })
  const conversation = page.getByRole('log', { name: 'Conversation' })
  const latest = page.getByRole('button', { name: 'Scroll to latest message' })
  const send = page.getByRole('button', { name: 'Send message' })
  await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
  await expect(composer).not.toBeFocused()

  await page.getByRole('button', { name: 'Focus Weight goal', exact: true }).tap()
  await expect(page).toHaveURL(/\/surface\/srf-goal$/)
  await expect(composer).not.toBeFocused()

  await composer.tap()
  await composer.fill('**Important**')
  await composer.press('Enter')
  await expect(composer).toHaveValue('**Important**\n')
  await expect(conversation.locator('.chat-entry.user')).toHaveCount(0)
  const draft =
    '**Important**\n\n- First item\n- Second item\n\n```\n' + 'long-code-'.repeat(80) + '\n```'
  await composer.fill(draft)
  const hitTarget = await send.boundingBox()
  expect(hitTarget?.width).toBeGreaterThanOrEqual(44)
  expect(hitTarget?.height).toBeGreaterThanOrEqual(44)
  await send.tap()
  await expect(composer).toHaveValue('')
  const reply = conversation.locator('.chat-entry.assistant').last()
  await expect(reply.locator('.chat-message strong')).toHaveText('Important')
  await expect(reply.getByRole('listitem')).toHaveCount(2)
  await expect(reply.locator('pre code')).toContainText('long-code-')
  await expect(conversation.locator('.chat-entry.user .chat-message')).toHaveText(draft)
  await expect(latest).toBeHidden()

  await conversation.evaluate((element) => {
    element.scrollTop = 0
  })
  await expect(latest).toBeVisible()
  await latest.tap()
  await expect(latest).toBeHidden()

  await page.setViewportSize({ width: 320, height: 640 })
  await expect(latest).toBeHidden()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const emphasis = await reply.locator('.chat-message strong').evaluate((element) => ({
    size: getComputedStyle(element).fontSize,
    transform: getComputedStyle(element).textTransform,
  }))
  expect(emphasis).toEqual({ size: '14px', transform: 'none' })
  await page.screenshot({ path: testInfo.outputPath('mobile-chat.png'), fullPage: true })

  await page.reload()
  await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
  await expect(composer).not.toBeFocused()
  await expect(reply.locator('.chat-message strong')).toHaveText('Important')
  await expect(reply.getByRole('listitem')).toHaveCount(2)
  await expect(latest).toBeHidden()
})
