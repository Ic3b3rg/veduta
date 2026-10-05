import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OnboardingConfigSchema, saveOnboardingConfig } from '../../daemon/src/onboarding-config.ts'
import { buildServer } from '../../daemon/src/server.ts'
import { findFreePort } from './stack.ts'

test('ClawHub links produce inspection-only Chat reports that survive refresh and Gateway restart', async ({
  browser,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'veduta-e2e-clawhub-'))
  const port = await findFreePort()
  const origin = `http://localhost:${port}`
  const context = await browser.newContext()
  const page = await context.newPage()
  const requests: string[] = []
  let unavailable = false
  let server: ReturnType<typeof buildServer> | undefined
  const boot = () =>
    buildServer({
      dataDir: root,
      onboarding: { env: { VEDUTA_LEGACY_HOME: root } },
      clawHubFetch: async (input, init) => {
        const url = new URL(String(input))
        requests.push(url.href)
        expect(url.hostname).toBe('clawhub.ai')
        expect(init?.redirect).toBe('error')
        if (unavailable) return new Response('PRIVATE-CATALOG-ERROR', { status: 503 })
        const slug = url.searchParams.get('slug') ?? url.pathname.split('/')[4]!
        const version = slug === 'obsidian' ? '1.0.0' : '4.0.2'
        const name = url.pathname.includes('/versions/')
          ? `${slug}-version.json`
          : url.pathname === '/api/v1/download'
            ? `${slug}-${version}.zip`
            : `${slug}-catalog.json`
        return new Response(
          readFileSync(new URL(`../../daemon/src/fixtures/clawhub/${name}`, import.meta.url)),
        )
      },
    })
  try {
    saveOnboardingConfig(root, OnboardingConfigSchema.parse({ steps: { finish: 'completed' } }))
    server = boot()
    await server.app.listen({ host: '127.0.0.1', port })
    const before = server.serviceConnections.snapshot()
    await page.goto(origin)
    const composer = page.getByRole('textbox', { name: 'Message Veduta', exact: true })
    await expect(composer).toBeVisible()
    await composer.fill('Install steipete/obsidian@1.0.0')
    await page.getByRole('button', { name: 'Send message' }).click()
    const reports = page.locator('.chat-entry.assistant', {
      hasText: 'ClawHub compatibility report',
    })
    await expect(reports).toHaveCount(1)
    const obsidian = reports.first()
    await expect(obsidian).toContainText('Adaptation required')
    await expect(obsidian).toContainText('Publisher: steipete. Version: 1.0.0.')
    await expect(obsidian).toContainText('notesmd-cli')
    await expect(obsidian).toContainText(
      'ff964e127170088a5e5e280f9f437afcba3a6e3d579c05b947a37b7f4253bf1b',
    )
    await expect(obsidian).toContainText('File inventory')
    await expect(obsidian).toContainText('No package or dependency was installed')
    await expect(page.getByRole('button', { name: /Approve|Install package/ })).toHaveCount(0)

    await composer.fill('Inspect @pskoett/self-improving-agent@4.0.2')
    await page.getByRole('button', { name: 'Send message' }).click()
    await expect(reports).toHaveCount(2)
    const hooks = reports.last()
    await expect(hooks).toContainText('Unsupported')
    await expect(hooks).toContainText('agent:bootstrap')
    await expect(hooks).toContainText('transcript')
    await expect(hooks).toContainText('hooks/openclaw/handler.js')
    expect(requests).toHaveLength(10)

    await page.reload()
    await expect(reports).toHaveCount(2)
    await expect(hooks).toContainText('No package or dependency was installed')
    expect(requests).toHaveLength(10)
    await server.app.close()
    server = boot()
    await server.app.listen({ host: '127.0.0.1', port })
    await page.reload()
    await expect(reports).toHaveCount(2)
    await expect(obsidian).toContainText('notesmd-cli')
    expect(requests).toHaveLength(10)
    expect(server.serviceConnections.snapshot()).toEqual(before)

    await composer.fill('Inspect https://clawhub.ai/steipete/obsidian?url=https://evil.test')
    await page.getByRole('button', { name: 'Send message' }).click()
    await expect(page.locator('.chat-entry.assistant').last()).toContainText('No package')
    expect(requests).toHaveLength(10)
    unavailable = true
    await composer.fill('Inspect @steipete/obsidian')
    await page.getByRole('button', { name: 'Send message' }).click()
    await expect(page.locator('.chat-entry.assistant').last()).toContainText('Inspection refused')
    await expect(page.locator('.chat-entry.assistant').last()).toContainText('unavailable')
    await expect(page.getByText('PRIVATE-CATALOG-ERROR')).toHaveCount(0)
    expect(requests).toHaveLength(11)
    await page.reload()
    await expect(page.locator('.chat-entry.assistant').last()).toContainText('Inspection refused')
    expect(requests).toHaveLength(11)
    expect(server.serviceConnections.snapshot()).toEqual(before)
  } finally {
    try {
      await context.close()
    } finally {
      try {
        await server?.app.close()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  }
})
