import { expect, test, type Page } from '@playwright/test'
import { SurfaceSnapshotSchema } from '../../protocol/src/index.ts'
import { cleanupStackDirs, startLocalVpsStack } from './stack.ts'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

for (const name of ['Home', 'Health']) {
  test(`first boot creates only System and the chosen ${name} Space`, async ({
    page,
    context,
  }, info) => {
    const cdp = await context.newCDPSession(page)
    await cdp.send('WebAuthn.enable')
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    })
    let stack = await startLocalVpsStack()
    try {
      const [setup] = await Promise.all([stack.waitForSetupUrl(), stack.waitForReadyLine()])
      await page.goto(setup.url)
      await page.getByRole('button', { name: 'Register passkey' }).click()
      await expect(page.getByRole('heading', { name: 'Set up Veduta' })).toBeVisible()
      expect((await snapshot(page, stack.origin)).spaces.map((space) => space.name)).toEqual([
        'System',
      ])
      await page.getByRole('button', { name: 'Continue' }).click()
      await page.getByLabel(/built-in mock provider/i).click()
      await expect(page.getByLabel(/built-in mock provider/i)).toBeChecked()
      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByLabel('Name', { exact: true })).toBeVisible()
      await expect(page.getByText('Existing Spaces:', { exact: false })).toHaveCount(0)
      await page.getByLabel('Name', { exact: true }).fill('System')
      await page.getByRole('button', { name: 'Create', exact: true }).click()
      await expect(page.getByRole('alert')).toContainText('Choose a different name')
      await page.reload()
      await expect(page.getByLabel('Name', { exact: true })).toBeVisible()
      await page.getByLabel('Name', { exact: true }).fill(name)
      await page.screenshot({ path: info.outputPath(`choose-${name.toLowerCase()}.png`) })
      await page.getByRole('button', { name: 'Create', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Skip', exact: true })).toBeVisible()
      await page.reload()
      await page.getByRole('button', { name: 'Skip', exact: true }).click()
      await page.getByRole('button', { name: 'Finish', exact: true }).click()
      await stack.waitForReadyLine()
      const home = page.getByRole('main', { name: 'Home', exact: true })
      await expect(home).toBeVisible({ timeout: 60_000 })
      await expect(home.getByRole('link', { name: new RegExp(name) })).toBeVisible()
      await assertChosenSpaces(page, stack.origin, name)
      await page.reload()
      await expect(home).toBeVisible()
      await assertChosenSpaces(page, stack.origin, name)

      await stack.stop()
      stack = await startLocalVpsStack({
        port: stack.port,
        baseDir: stack.baseDir,
        legacyHome: stack.legacyHome,
      })
      await stack.waitForReadyLine()
      await page.reload()
      await expect(home).toBeVisible()
      await assertChosenSpaces(page, stack.origin, name)
      await home.getByRole('link', { name: new RegExp(name) }).click()
      await expect(page.getByRole('main', { name: `${name} Space`, exact: true })).toBeVisible()
      await page.reload()
      await expect(page.getByRole('main', { name: `${name} Space`, exact: true })).toBeVisible()
      await page.screenshot({ path: info.outputPath(`chosen-${name.toLowerCase()}.png`) })
    } finally {
      await stack.stop()
      await cleanupStackDirs(stack)
    }
  })
}

async function snapshot(page: Page, origin: string) {
  const token = await page.evaluate(() => localStorage.getItem('veduta.authToken'))
  const response = await page.request.get(`${origin}/api/spaces`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  expect(response.ok()).toBe(true)
  return SurfaceSnapshotSchema.parse(await response.json())
}

async function assertChosenSpaces(page: Page, origin: string, name: string) {
  const result = await snapshot(page, origin)
  expect(result.spaces.map((space) => space.name).sort()).toEqual([name, 'System'])
  expect(
    result.spaces.flatMap(({ surfaces }) => surfaces).map((surface) => surface.id),
  ).not.toEqual(expect.arrayContaining(['srf-goal', 'srf-meals', 'srf-groceries']))
  const personal = result.spaces.find((space) => space.name === name)
  expect(personal?.surfaces.filter((surface) => !surface.management)).toEqual([])
}
