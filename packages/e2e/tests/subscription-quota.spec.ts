import { expect, test, type Page } from '@playwright/test'
import { loadConnectionsConfig } from '../../daemon/src/connections-config.ts'
import { CODEX_USAGE_LIMIT_MESSAGE } from '../../daemon/src/codex-inference-error.ts'
import { cleanupStackDirs, startLocalVpsStack, type LocalVpsStack } from './stack.ts'
import {
  createQuotaRuntimeFixture,
  QUOTA_CONNECTION_ID,
  QUOTA_CONNECTION_LABEL,
  QUOTA_MODEL_ID,
  QUOTA_RECOVERY_REPLY,
} from './subscription-quota-fixture.ts'

test.use({ viewport: { width: 1440, height: 900 } })

test('subscription limits remain actionable across Chat scopes and reload, then recover without replay', async ({
  page,
  context,
}, info) => {
  test.setTimeout(5 * 60_000)
  const fixture = createQuotaRuntimeFixture()
  let stack: LocalVpsStack | undefined
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
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

  const assertSelection = () => {
    const config = loadConnectionsConfig(fixture.rootDir)
    expect(config.selection).toEqual({ connectionId: QUOTA_CONNECTION_ID, modelId: QUOTA_MODEL_ID })
    expect(config.connections[0]?.state).toBe('connected')
    expect(config.mockEnabled).toBe(false)
  }

  try {
    await test.step('authenticate and finish a clean Local VPS setup with the subscription fixture', async () => {
      stack = await startLocalVpsStack({
        baseDir: fixture.baseDir,
        extraEnv: { VEDUTA_CODEX_BIN: fixture.binary },
      })
      const [setup] = await Promise.all([stack.waitForSetupUrl(), stack.waitForReadyLine()])
      await page.goto(setup.url)
      await page.getByRole('button', { name: 'Register passkey' }).click()
      await expect(page.getByRole('heading', { name: 'Set up Veduta' })).toBeVisible()
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await expect(page.getByLabel(/built-in mock provider/i)).not.toBeChecked()
      await expect(page.getByRole('combobox', { name: 'Connection', exact: true })).toHaveValue(
        QUOTA_CONNECTION_ID,
      )
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await page.getByRole('button', { name: 'Create', exact: true }).click()
      await page.getByRole('button', { name: 'Skip', exact: true }).click()
      await page.getByRole('button', { name: 'Finish', exact: true }).click()
      await stack.waitForReadyLine()
      await expect(page.getByRole('main', { name: 'Home' })).toBeVisible()
      const auth = await page.request.get(`${stack.origin}/api/auth/status`)
      expect(await auth.json()).toMatchObject({ mode: 'production' })
      assertSelection()
      expect(fixture.turns()).toBe(0)
    })

    for (const scope of [
      { name: 'global', path: '/', composer: 'Message Veduta' },
      { name: 'focused', path: '/app/space/health', composer: 'Message Veduta in Health' },
      { name: 'System', path: '/app/space/system', composer: 'Message Veduta in System' },
    ]) {
      await test.step(`${scope.name} Chat preserves the quota error and selection on reload`, async () => {
        await page.goto(`${stack!.origin}${scope.path}`)
        await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
        const before = fixture.turns()
        await sendMessage(
          page,
          scope.composer,
          `Check subscription availability in ${scope.name} Chat.`,
        )
        const conversation = page.getByRole('log', { name: 'Conversation' })
        await expect(conversation).toContainText(CODEX_USAGE_LIMIT_MESSAGE)
        await expect(conversation).not.toContainText('no resolvable secret')
        await expect(conversation).toContainText('Provider reset times: 2026-10-10T11:00:00.000Z')
        expect(fixture.turns()).toBe(before + 1)
        assertSelection()
        await page.reload()
        await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
        await expect(conversation).toContainText(CODEX_USAGE_LIMIT_MESSAGE)
        await assertVisibleSelection(page)
        expect(fixture.turns()).toBe(before + 1)
        assertSelection()
      })
    }

    await test.step('Model connections retains the same reason, then a fresh user turn proves recovery', async () => {
      await openModelConnection(page, stack!.origin)
      await expect(page.locator('.model-connection-lifecycle')).toContainText(
        CODEX_USAGE_LIMIT_MESSAGE,
      )
      await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toHaveCount(0)
      await page.screenshot({ path: info.outputPath('subscription-quota-models.png') })
      const before = fixture.turns()
      fixture.setPhase('recovered')
      await page.goto(`${stack!.origin}/app/space/system`)
      await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
      await expect(page.getByRole('log', { name: 'Conversation' })).toContainText(
        CODEX_USAGE_LIMIT_MESSAGE,
      )
      expect(fixture.turns()).toBe(before)
      await sendMessage(
        page,
        'Message Veduta in System',
        'Try a fresh message after allowance recovery.',
      )
      await expect(page.getByRole('log', { name: 'Conversation' })).toContainText(
        QUOTA_RECOVERY_REPLY,
      )
      expect(fixture.turns()).toBe(before + 1)
      assertSelection()
      expect(loadConnectionsConfig(fixture.rootDir).connections[0]?.inferenceIssue).toBeUndefined()
      await page.reload()
      await expect(page.getByRole('log', { name: 'Conversation' })).toContainText(
        QUOTA_RECOVERY_REPLY,
      )
      await expect(page.getByRole('log', { name: 'Conversation' })).toContainText(
        CODEX_USAGE_LIMIT_MESSAGE,
      )
      expect(fixture.turns()).toBe(before + 1)
    })

    await test.step('Test model clears a new limit without replaying the interrupted Chat submission', async () => {
      fixture.setPhase('limited')
      await sendMessage(page, 'Message Veduta in System', 'Check another limited request.')
      await expect(
        page
          .getByRole('log', { name: 'Conversation' })
          .getByText(CODEX_USAGE_LIMIT_MESSAGE, { exact: false }),
      ).toHaveCount(2)
      await openModelConnection(page, stack!.origin)
      await expect(page.locator('.model-connection-lifecycle')).toContainText(
        'Subscription usage limit',
      )
      const before = fixture.turns()
      fixture.setPhase('recovered')
      expect(fixture.turns()).toBe(before)
      await page.getByRole('button', { name: 'Test model', exact: true }).click()
      await expect(page.locator('.model-connection-lifecycle')).toContainText('Connected')
      await expect(page.locator('.model-connection-lifecycle')).not.toContainText(
        'Subscription usage limit',
      )
      expect(fixture.turns()).toBe(before + 1)
      assertSelection()
      await page.reload()
      await page
        .locator('.connection-list-item')
        .filter({ hasText: QUOTA_CONNECTION_LABEL })
        .click()
      await expect(page.locator('.model-connection-lifecycle')).toContainText('Connected')
      await page.goto(`${stack!.origin}/app/space/system`)
      const conversation = page.getByRole('log', { name: 'Conversation' })
      await expect(conversation.getByText(QUOTA_RECOVERY_REPLY, { exact: true })).toHaveCount(1)
      await expect(
        conversation.getByText('Check another limited request.', { exact: true }),
      ).toHaveCount(1)
      await expect(conversation.getByText(CODEX_USAGE_LIMIT_MESSAGE, { exact: false })).toHaveCount(
        2,
      )
      expect(fixture.turns()).toBe(before + 1)
      expect(fixture.turns()).toBe(6)
      expect(fixture.authorizationCalls()).toBe(0)
      expect(pageErrors).toEqual([])
      await page.screenshot({ path: info.outputPath('subscription-quota-recovered-chat.png') })
    })
  } finally {
    if (stack) {
      await stack.stop()
      await cleanupStackDirs(stack)
    }
  }
})

async function sendMessage(page: Page, composer: string, text: string): Promise<void> {
  await page.getByRole('textbox', { name: composer, exact: true }).fill(text)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
}

async function assertVisibleSelection(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Choose model', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Model settings' })
  await expect(dialog.getByRole('combobox', { name: 'Connection', exact: true })).toHaveValue(
    QUOTA_CONNECTION_ID,
  )
  await expect(dialog.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(
    QUOTA_MODEL_ID,
  )
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

async function openModelConnection(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/app/settings/models`)
  await page.locator('.connection-list-item').filter({ hasText: QUOTA_CONNECTION_LABEL }).click()
}
