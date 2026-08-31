import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test'
import { cleanupStackDirs, startLocalVpsStack, type LocalVpsStack } from './stack.ts'

/**
 * Real-browser e2e journey for the Local VPS profile (issue 023,
 * `docs/adr/0009-local-vps-profile.md`). One long, serial test rather than
 * several independent ones: every later step depends on daemon/browser state
 * built up by an earlier one (the registered passkey, the completed wizard,
 * the logged meal, the toggled checkbox), and re-deriving that state per
 * test would mean re-running the slow first boot (PWA build + wizard) every
 * time. `test.step` keeps the reporter output readable despite the length.
 *
 * Acceptance criteria covered (issues/023-local-vps-profile.md):
 *   AC1 - a fresh local run boots the full stack and reaches Home.
 *   AC2 - passkey auth + a core chat flow (meal logging) updates a Surface.
 *   AC3 - restarting the stack preserves auth, the Meals entry, and the
 *         Groceries checkbox state.
 *   Issue #134 - the Meals projection carries explicit relative-time validity,
 *                a durable occurrence-dated source record, and no expired UI.
 *   Issue #67 - a pinned patch_tree Pending decision is revealed only in the initiating tab.
 *   Issue #142 - Form text stays local until one atomic, retryable submit and survives reload.
 *
 * Also covers the Space Event log (ADR-0003: every fast-path mutation
 * appends to it) via `GET /api/spaces/spc-health/events` -- both right
 * after the chat and fast-path steps, and again after the restart in the
 * AC3 step, so persistence is checked on the log itself, not only on the
 * rendered Surface state.
 */
test.describe.configure({ mode: 'serial' })

test('Local VPS profile: first boot, chat->Surface, fast path, restart, re-login', async ({
  browser,
}) => {
  // Two PWA builds happen in this journey (the first boot, and the fresh
  // runner started for the restart-persistence step) plus a full wizard
  // walk -- generous headroom over the per-wait timeouts in stack.ts.
  test.setTimeout(15 * 60_000)

  let stack: LocalVpsStack | undefined
  let observerContext: BrowserContext | undefined
  const context = await browser.newContext()
  const page = await context.newPage()

  // WebAuthn must be wired up BEFORE the first navigation that will call
  // `navigator.credentials.create`/`.get` (auth-gate.tsx's Register/Sign-in
  // buttons, via @simplewebauthn/browser). One authenticator, one context,
  // kept alive for the whole journey -- its resident credential is the only
  // thing that lets the login leg at the end (step i) reuse the same
  // passkey after the CDP session that registered it is long gone.
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  expect(authenticatorId).toBeTruthy()

  try {
    await test.step('boot the stack fresh (AC1)', async () => {
      stack = await startLocalVpsStack()
      const [setup] = await Promise.all([stack.waitForSetupUrl(), stack.waitForReadyLine()])
      await page.goto(setup.url)
    })

    await test.step('register the passkey and land authenticated', async () => {
      await expect(page.getByRole('button', { name: 'Register passkey' })).toBeVisible()
      await page.getByRole('button', { name: 'Register passkey' }).click()
      // Bootstrap gone: the wizard (or Home) renders next, never the auth gate again.
      await expect(page.getByRole('button', { name: 'Register passkey' })).toBeHidden()
    })

    await test.step('AC1 sanity: /api/auth/status reports production auth', async () => {
      const response = await page.request.get(`${stack!.origin}/api/auth/status`)
      expect(response.ok()).toBe(true)
      const body = await response.json()
      expect(body.mode).toBe('production')
    })

    await test.step('walk the onboarding wizard with defaults (domain, model connection, first-space, integrations)', async () => {
      await expect(page.getByRole('heading', { name: 'Set up Veduta' })).toBeVisible()

      // Domain: read-only for the Local VPS profile, just confirm.
      await page.getByRole('button', { name: 'Continue' }).click()

      // Model connection: no real connection -- tick the Local VPS
      // development-only mock control, then Continue (issue #47).
      // The checkbox is controlled: it reflects the Gateway's persisted
      // mockEnabled only after the POST round-trip, so click and await the
      // state instead of check(), which asserts an immediate flip.
      await expect(page.getByLabel(/built-in mock provider/i)).toBeVisible()
      await page.getByLabel(/built-in mock provider/i).click()
      await expect(page.getByLabel(/built-in mock provider/i)).toBeChecked()
      await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled()
      await page.getByRole('button', { name: 'Continue' }).click()

      // First Space: keep the suggested name.
      await page.getByRole('button', { name: 'Create' }).click()

      // Integrations: optional -- skip.
      await expect(page.getByRole('button', { name: 'Skip' })).toBeVisible()
      await page.getByRole('button', { name: 'Skip' }).click()

      await expect(page.getByRole('button', { name: 'Finish' })).toBeVisible()
    })

    await test.step('finish: daemon restarts, wizard itself waits, then Home renders', async () => {
      await page.getByRole('button', { name: 'Finish' }).click()
      // The runner restarts the daemon (exit 0 from the finish step) -- confirms
      // the Local VPS runner loop actually did its job, independent of the
      // wizard's own `/api/auth/status` poll below.
      await stack!.waitForReadyLine()
      // The wizard shell polls `/api/auth/status` itself and calls
      // `onCompleted()` once the daemon answers again (onboarding-wizard.tsx),
      // so Home appears without any action from this test.
      await expect(
        page.getByRole('main', { name: 'Home' }).getByRole('link', { name: /Health/ }),
      ).toBeVisible({ timeout: 60_000 })
    })

    await test.step('Home links to the seeded Health Space and its Surfaces', async () => {
      await page
        .getByRole('main', { name: 'Home' })
        .getByRole('link', { name: /Health/ })
        .click()
      await expect(page.getByRole('main', { name: 'Health Space' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Focus Meals' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Focus Groceries' })).toBeVisible()
    })

    await test.step('the Italian meal request discovers, reads, and patches Meals (AC2)', async () => {
      // The Gateway WebSocket connects asynchronously after Home's initial
      // render (app.tsx's `connectGateway`); sending chat before it opens
      // gets silently queued for a later retry instead of reaching the
      // daemon (`sendChat` returns false, app.tsx's `queuedChat`) rather
      // than failing loudly, so wait for the "Live" status pill first --
      // otherwise this step can pass on a stale Surface if it checks only
      // static copy rather than the bound state rendered by the Atoms.
      await expect(page.locator('.status-pill.online')).toHaveText('Live')

      const chatInput = page.getByRole('textbox', { name: 'Message Veduta' })
      await chatInput.fill('aggiungi ai meals la fesa di tacchino')
      await page.getByRole('button', { name: 'Send' }).click()

      await expectMealLogged(page)

      const mealsSurface = await fetchSurface(page, stack!.origin, 'srf-meals')
      expect(mealsSurface.validity).toMatchObject({
        kind: 'relative-time',
        window: 'day',
        source: { stateKey: 'mealRecords', occurredAtKey: 'occurredAt' },
        projectionStateKeys: ['meals', 'lastMeal', 'mealCount'],
      })
      const sourceRecords = mealsSurface.state['mealRecords']
      const projectedMeals = mealsSurface.state['meals']
      expect(Array.isArray(sourceRecords)).toBe(true)
      expect(Array.isArray(projectedMeals)).toBe(true)
      const sourceRecord = (sourceRecords as Array<Record<string, unknown>>)[0]
      const projectedMeal = (projectedMeals as Array<Record<string, unknown>>)[0]
      expect(sourceRecord).toMatchObject({ meal: 'fesa di tacchino' })
      expect(projectedMeal).toMatchObject({ meal: 'fesa di tacchino' })
      expect(projectedMeal?.['occurredAt']).toBe(sourceRecord?.['occurredAt'])
      expect(typeof sourceRecord?.['occurredAt']).toBe('string')
      expect(Date.parse(sourceRecord?.['occurredAt'] as string)).toBeGreaterThanOrEqual(
        Date.parse(mealsSurface.validity!.startsAt),
      )
      expect(Date.parse(sourceRecord?.['occurredAt'] as string)).toBeLessThan(
        Date.parse(mealsSurface.validity!.expiresAt),
      )
      await expect(surfaceCard(page, 'Meals').locator('.relative-time-notice.expired')).toHaveCount(
        0,
      )

      // The reply itself must reach the chat log, not only the Surface it
      // patched (issue #37, chat-loop.ts's `chat.turn-end`): the mock chat
      // model's deterministic journey includes the derived patch line, and
      // it must show up exactly once in the rendered chat log, as the
      // assistant's own entry. Not asserted here: the transient streaming
      // affordance (the cursor rendered on an in-flight `chat.turn-delta`) --
      // the mock's stream completes in a handful of milliseconds, so there
      // is no reliable window in which to observe it in this real-browser
      // journey; the manual `pnpm dev` + browser check covers that visually.
      await expect(
        page.locator('.chat-entry.assistant').filter({ hasText: /Logging: fesa di tacchino/ }),
      ).toHaveCount(1)

      // Event log coverage (ADR-0003): the chat turn's own `patch_state` tool
      // call (the mock chat model, gated through the trust-wrapped tool
      // registry, via `SurfaceEngine.patchState`) logs a generic
      // `surface.patch_state` entry naming the Surface it patched -- it does
      // not echo the meal text itself into the Event log (only the Surface
      // state carries it), so "about the meal" here means "about the
      // Meals Surface a chat turn just patched".
      const events = await fetchSpaceEvents(page, stack!.origin)
      expect(events.some(isMealPatchEvent)).toBe(true)
      // The chat turn itself also lands in the Space's Event log as a
      // `type: 'turn'` user entry (issue #37, chat-loop.ts's `runTurn`,
      // ADR-0003: the Agent must find user interactions before reasoning
      // about a Space) -- not just the tool call it went on to make.
      const userTurnIndex = events.findIndex(
        (event) =>
          event.type === 'turn' &&
          event.text === 'aggiungi ai meals la fesa di tacchino' &&
          event.payload?.role === 'user',
      )
      const patchIndex = events.findIndex(isMealPatchEvent)
      const assistantTurnIndex = events.findIndex(
        (event) => event.type === 'turn' && event.payload?.role === 'assistant',
      )
      expect(userTurnIndex).toBeGreaterThanOrEqual(0)
      expect(patchIndex).toBeGreaterThan(userTurnIndex)
      expect(assistantTurnIndex).toBeGreaterThan(patchIndex)
      expect(events[assistantTurnIndex]?.payload?.toolCalls?.map((call) => call.toolName)).toEqual([
        'list_surfaces',
        'read_surface',
        'patch_state',
      ])
    })

    await test.step('the exact Italian calorie question enriches Meals and agrees with chat (issue 095)', async () => {
      const chatInput = page.getByRole('textbox', { name: 'Message Veduta in Health' })
      await chatInput.fill('aggiungi ai meals la colazione con ricotta, cereali e latte')
      await page.getByRole('button', { name: 'Send' }).click()
      await expect(
        page
          .locator('.chat-entry.assistant')
          .filter({ hasText: /Logging: ricotta, cereali e latte/ }),
      ).toHaveCount(1)

      await chatInput.fill('Quante calorie ho mangiato oggi ?')
      await page.getByRole('button', { name: 'Send' }).click()

      const meals = surfaceCard(page, 'Meals')
      await expect(meals.getByText('Today’s calorie estimate')).toBeVisible()
      await expect(meals.getByText('≈ 430–650 kcal')).toBeVisible()
      await expect(meals.getByText('Breakfast: ricotta, cereal, milk')).toBeVisible()
      await expect(meals.getByText('Turkey breast', { exact: true })).toBeVisible()
      await expect(meals.getByText(/Missing quantities for ricotta/)).toBeVisible()
      await expect(
        page
          .locator('.chat-entry.assistant')
          .filter({ hasText: /Estimated total: ≈ 430–650 kcal/ }),
      ).toHaveCount(1)

      const mealsSurface = await fetchSurface(page, stack!.origin, 'srf-meals')
      expect(mealsSurface.state['mealRecords']).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ meal: 'fesa di tacchino' }),
          expect.objectContaining({ meal: 'ricotta, cereali e latte' }),
        ]),
      )
      await chatInput.fill('La ricotta era 100 g, i cereali 40 g e il latte 200 ml')
      await page.getByRole('button', { name: 'Send' }).click()
      await expect(meals.getByText('≈ 470–570 kcal')).toBeVisible()
      await expect(meals.getByText('≈ 430–650 kcal')).toHaveCount(0)
      await expect(meals.getByText('Today’s calorie estimate')).toHaveCount(1)

      await chatInput.fill('Non mostrare più la stima calorie')
      await page.getByRole('button', { name: 'Send' }).click()
      await expect(meals.getByText('Today’s calorie estimate')).toHaveCount(0)
      await expect(meals.getByText('fesa di tacchino', { exact: true }).first()).toBeVisible()
      await expect(
        meals.getByText('ricotta, cereali e latte', { exact: true }).first(),
      ).toBeVisible()
    })

    await test.step('progressive composition publishes layout first, fills independently, then falls back (issue 029)', async () => {
      const chatInput = page.getByRole('textbox', { name: 'Message Veduta in Health' })
      await chatInput.fill('show progressive surface demo')
      await page.getByRole('button', { name: 'Send' }).click()

      const progressive = surfaceCard(page, 'Progressive trip plan')
      await expect(progressive.getByRole('status')).toHaveCount(5, { timeout: 1_100 })
      await expect(progressive).not.toContainText('A four-day coastal route')

      const summary = progressive.getByText('A four-day coastal route', { exact: false })
      await expect(summary).toBeVisible({ timeout: 3_000 })
      await summary.evaluate((node) => node.setAttribute('data-e2e-resolved', 'summary'))

      await expect(progressive.getByText('286 km', { exact: true })).toBeVisible({ timeout: 3_000 })
      await expect(progressive.getByText('Day 4', { exact: true })).toBeVisible({ timeout: 3_000 })
      await expect(progressive.getByText('Camogli', { exact: true })).toBeVisible({
        timeout: 3_000,
      })
      await expect(summary).toHaveAttribute('data-e2e-resolved', 'summary')

      await expect(progressive.getByRole('alert')).toHaveText('Route preview unavailable', {
        timeout: 5_000,
      })
      await expect(progressive.getByRole('status')).toHaveCount(0)
      await expect(summary).toHaveAttribute('data-e2e-resolved', 'summary')
    })

    await test.step('fast path: toggling a Groceries checkbox changes state with no error', async () => {
      const milk = page.getByRole('checkbox', { name: 'Milk' })
      await expect(milk).not.toBeChecked()
      await milk.click()
      await expect(milk).toBeChecked()
      await expect(surfaceCard(page, 'Groceries').getByRole('alert')).toHaveCount(0)

      // Event log coverage (ADR-0003): `SurfaceEngine.applyFastAction`
      // (surface-engine.ts) logs `fast_path` events as
      // `"<Surface title>: <stateKey> -> <JSON value>"`, e.g.
      // `"Groceries: milk -> true"` -- the checkbox's own state key and new
      // value, verbatim.
      const events = await fetchSpaceEvents(page, stack!.origin)
      expect(events.some(isGroceriesToggleEvent)).toBe(true)
    })

    await test.step('chat-created Surface is revealed only in the initiating browser context', async () => {
      const groceries = surfaceCard(page, 'Groceries')
      await groceries.getByRole('button', { name: 'Pin Groceries' }).click()
      await expect(groceries.getByRole('button', { name: 'Pinned Groceries' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )

      const revealViewport = { width: 480, height: 300 }
      await page.setViewportSize(revealViewport)
      observerContext = await browser.newContext({
        storageState: await context.storageState(),
        viewport: revealViewport,
      })
      const observerPage = await observerContext.newPage()
      await observerPage.goto(`${stack!.origin}/app/space/health`)
      await expect(observerPage.locator('.status-pill.online')).toHaveText('Live')
      await expect(observerPage.getByRole('button', { name: 'Focus Groceries' })).toBeVisible()

      await Promise.all([
        page.evaluate(() => window.scrollTo(0, 0)),
        observerPage.evaluate(() => window.scrollTo(0, 0)),
      ])

      const initiatingUrl = page.url()
      const chatInput = page.getByRole('textbox', { name: 'Message Veduta in Health' })
      await chatInput.fill('create Weekly groceries from the Groceries Template')
      await expect(chatInput).toBeFocused()
      await chatInput.press('Enter')

      const initiatingCard = surfaceCard(page, 'Weekly groceries')
      const observerCard = surfaceCard(observerPage, 'Weekly groceries')
      await expect(initiatingCard).toHaveClass(/surface-reveal-highlight/, { timeout: 2_000 })
      await expect(observerCard).toBeAttached()
      await expect(observerCard).not.toHaveClass(/surface-reveal-highlight/)

      const observerCardTop = await observerCard.evaluate(
        (card) => card.getBoundingClientRect().top,
      )
      expect(observerCardTop).toBeGreaterThan(revealViewport.height)
      expect(await observerPage.evaluate(() => window.scrollY)).toBe(0)

      await expect
        .poll(() => page.evaluate(() => window.scrollY), { timeout: 3_000 })
        .toBeGreaterThan(0)
      await expect
        .poll(
          () =>
            initiatingCard.evaluate((card) => {
              const bounds = card.getBoundingClientRect()
              return Math.abs(bounds.top + bounds.height / 2 - window.innerHeight / 2)
            }),
          { timeout: 3_000 },
        )
        .toBeLessThan(80)

      await expect(chatInput).toBeFocused()
      await expect(
        initiatingCard.getByRole('button', { name: 'Focus Weekly groceries' }),
      ).toHaveAttribute('aria-pressed', 'false')
      await expect(
        page.getByRole('complementary', { name: 'Spaces' }).getByRole('button', { name: 'Health' }),
      ).toHaveClass(/selected/)
      expect(page.url()).toBe(initiatingUrl)

      await expect(initiatingCard).not.toHaveClass(/surface-reveal-highlight/, { timeout: 3_000 })
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.reload()
      await expect(page.locator('.status-pill.online')).toHaveText('Live')
      await expect(surfaceCard(page, 'Weekly groceries')).toBeAttached()
      await expect(surfaceCard(page, 'Weekly groceries')).not.toHaveClass(
        /surface-reveal-highlight/,
      )
      expect(await page.evaluate(() => window.scrollY)).toBe(0)

      await observerContext.close()
      observerContext = undefined
    })

    await test.step('a pinned patch_tree decision reveals its real Decision Surface only in the initiating tab (issue 067)', async () => {
      const meals = surfaceCard(page, 'Meals')
      await meals.getByRole('button', { name: 'Pin Meals' }).click()
      await expect(meals.getByRole('button', { name: 'Pinned Meals' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )

      observerContext = await browser.newContext({
        storageState: await context.storageState(),
        viewport: { width: 480, height: 300 },
      })
      const observerPage = await observerContext.newPage()
      await observerPage.goto(`${stack!.origin}/app/space/health`)
      await expect(observerPage.locator('.status-pill.online')).toHaveText('Live')
      const observerUrl = observerPage.url()

      const chatInput = page.getByRole('textbox', { name: 'Message Veduta in Health' })
      const initiatingUrl = page.url()
      await chatInput.fill('Quante calorie ho mangiato oggi ?')
      await expect(chatInput).toBeFocused()
      await chatInput.press('Enter')

      const decisionTitle = 'Proposed layout change: Meals'
      const initiatingDecision = surfaceCard(page, decisionTitle)
      const observerDecision = surfaceCard(observerPage, decisionTitle)
      await expect(initiatingDecision).toHaveClass(/surface-reveal-highlight/, {
        timeout: 5_000,
      })
      await expect(
        initiatingDecision.getByRole('button', { name: `Focus ${decisionTitle}` }),
      ).toHaveAttribute('aria-pressed', 'false')
      await expect(chatInput).toBeFocused()
      expect(page.url()).toBe(initiatingUrl)

      await expect(observerDecision).toBeAttached()
      await expect(observerDecision).not.toHaveClass(/surface-reveal-highlight/)
      expect(observerPage.url()).toBe(observerUrl)

      const notification = page.locator('.pending-decision-notification', {
        hasText: 'Change the “Meals” Surface tree',
      })
      await notification
        .getByRole('button', { name: 'Accept Change the “Meals” Surface tree' })
        .click()
      await expect(initiatingDecision).toHaveCount(0)
      await expect(meals.getByText('Today’s calorie estimate')).toBeVisible()

      await observerContext.close()
      observerContext = undefined
    })

    await test.step('Form text submits atomically, retries visibly, and survives reload (issue 142)', async () => {
      const chatInput = page.getByRole('textbox', { name: 'Message Veduta in Health' })
      await chatInput.fill('send to alice@example.com: original draft')
      await page.getByRole('button', { name: 'Send' }).click()

      const approvalTitle = 'Approval required: Send message to alice@example.com'
      const approval = surfaceCard(page, approvalTitle)
      await expect(approval).toBeVisible()
      const approvalSurface = await fetchSurfaceByTitle(page, stack!.origin, approvalTitle)
      const body = approval.getByRole('textbox', { name: 'Body' })
      const save = approval.getByRole('button', { name: 'Save edits' })
      await expect(body).toHaveValue('original draft')

      const actionRequests: Record<string, unknown>[] = []
      let failNextSubmit = true
      const actionRoute = '**/api/surfaces/*/actions'
      const handleAction = async (route: Route) => {
        const requestBody: unknown = route.request().postDataJSON()
        if (
          !isRecord(requestBody) ||
          requestBody['nodeId'] !== 'editable-fields-form' ||
          requestBody['name'] !== 'submit'
        ) {
          await route.continue()
          return
        }

        actionRequests.push(requestBody)
        if (failNextSubmit) {
          failNextSubmit = false
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Temporary Form failure.' }),
          })
          return
        }
        await route.continue()
      }
      await page.route(actionRoute, handleAction)

      try {
        const eventsBefore = formSubmitEvents(
          await fetchSpaceEvents(page, stack!.origin),
          approvalSurface.id,
        ).length

        await body.fill('edited and retained')

        expect(actionRequests).toHaveLength(0)
        expect(
          formSubmitEvents(await fetchSpaceEvents(page, stack!.origin), approvalSurface.id),
        ).toHaveLength(eventsBefore)

        // Keyboard submit fails before reaching the daemon: the local draft and
        // explicit error remain available for a pointer-triggered retry.
        await body.press('Enter')
        await expect.poll(() => actionRequests.length).toBe(1)
        await expect(approval.getByRole('alert')).toHaveText('Temporary Form failure.')
        await expect(body).toHaveValue('edited and retained')
        expect(
          formSubmitEvents(await fetchSpaceEvents(page, stack!.origin), approvalSurface.id),
        ).toHaveLength(eventsBefore)

        await save.click()
        await expect.poll(() => actionRequests.length).toBe(2)
        await expect(approval.getByRole('alert')).toHaveCount(0)

        expect(actionRequests[0]?.['idempotencyKey']).toBe(actionRequests[1]?.['idempotencyKey'])
        expect(actionRequests[1]).toMatchObject({
          payload: { value: { 'field.body': 'edited and retained' } },
        })
        await expect
          .poll(async () => {
            const persisted = await fetchSurface(page, stack!.origin, approvalSurface.id)
            return persisted.state['field.body']
          })
          .toBe('edited and retained')

        const submitEvents = formSubmitEvents(
          await fetchSpaceEvents(page, stack!.origin),
          approvalSurface.id,
        )
        expect(submitEvents).toHaveLength(eventsBefore + 1)
        expect(submitEvents.at(-1)?.payload).toMatchObject({
          stateKeys: ['field.body'],
          values: { 'field.body': 'edited and retained' },
        })

        await page.reload()
        await expect(page.locator('.status-pill.online')).toHaveText('Live')
        const reloadedApproval = surfaceCard(page, approvalTitle)
        await expect(reloadedApproval.getByRole('textbox', { name: 'Body' })).toHaveValue(
          'edited and retained',
        )

        // Keep the rest of the serial journey free of an unrelated pending approval.
        await reloadedApproval.getByRole('button', { name: 'Reject', exact: true }).click()
        await expect(reloadedApproval).toHaveCount(0)
        await page.goto(`${stack!.origin}/app/space/health`)
        await expect(page.locator('.status-pill.online')).toHaveText('Live')
        await expect(page.getByRole('button', { name: 'Focus Groceries' })).toBeVisible()
      } finally {
        await page.unroute(actionRoute, handleAction)
      }
    })

    await test.step('restart persistence (AC3): stop, start a NEW runner on the same base dir/port', async () => {
      await stack!.stop()
      const restarted = await startLocalVpsStack({
        port: stack!.port,
        baseDir: stack!.baseDir,
        legacyHome: stack!.legacyHome,
      })
      stack = restarted
      await stack.waitForReadyLine()

      await page.reload()
      // Still authenticated: the token survived in localStorage and
      // `auth.json` survived under `<base>/data` -- no auth gate, straight to Home.
      await expect(page.getByRole('button', { name: 'Focus Meals' })).toBeVisible({
        timeout: 30_000,
      })
      await expectMealLogged(page, 2)
      expect((await fetchSurface(page, stack.origin, 'srf-meals')).validity).toMatchObject({
        kind: 'relative-time',
        source: { stateKey: 'mealRecords', occurredAtKey: 'occurredAt' },
      })
      await expect(
        surfaceCard(page, 'Groceries').getByRole('checkbox', { name: 'Milk' }),
      ).toBeChecked()

      // AC1, restated: still production auth after a full stop/restart on
      // the same base dir, not just right after registration.
      const response = await page.request.get(`${stack.origin}/api/auth/status`)
      expect((await response.json()).mode).toBe('production')

      // Event log persistence (ADR-0003, AC3 restated for the log itself,
      // not just the rendered Surface state): both events logged before the
      // restart must still be there after a full stop/start on the same
      // base dir.
      const events = await fetchSpaceEvents(page, stack.origin)
      expect(events.some(isMealPatchEvent)).toBe(true)
      expect(events.some(isGroceriesToggleEvent)).toBe(true)
    })

    await test.step('login leg: clear the token, log back in with the SAME virtual authenticator', async () => {
      await page.evaluate(() => localStorage.removeItem('veduta.authToken'))
      await page.reload()

      await expect(page.getByRole('button', { name: 'Sign in with passkey' })).toBeVisible()
      await page.getByRole('button', { name: 'Sign in with passkey' }).click()
      await expect(page.getByRole('button', { name: 'Focus Meals' })).toBeVisible({
        timeout: 15_000,
      })
      await expectMealLogged(page, 2)
    })
  } finally {
    await observerContext?.close()
    await stack?.stop()
    if (stack) await cleanupStackDirs(stack)
    await context.close()
  }
})

/** The `<article class="surface-card">` for a given Surface, scoped by its unique "Focus <title>" button. */
function surfaceCard(page: Page, title: string) {
  return page.locator('article.surface-card', {
    has: page.getByRole('button', { name: `Focus ${title}` }),
  })
}

/**
 * Asserts the mock chat->Surface demo's meal shows on the Meals Surface.
 * Exact match, first of possibly several (the "Last meal" Stat and the
 * meals Table both render the bare meal string once patched). The count and
 * local wall-clock label prove the summary and prepended row changed too.
 */
async function expectMealLogged(page: Page, expectedCount = 1): Promise<void> {
  const meals = surfaceCard(page, 'Meals')
  await expect(meals.getByText('fesa di tacchino', { exact: true }).first()).toBeVisible()
  await expect(meals.getByText(String(expectedCount), { exact: true })).toBeVisible()
  await expect(meals.getByText(/^\d{2}:\d{2}$/, { exact: true }).first()).toBeVisible()
}

/** One entry from `GET /api/spaces/:spaceId/events` (`SpaceEvent`, packages/daemon/src/spaces-engine.ts). */
interface SpaceEventEntry {
  type: string
  text: string
  payload?: {
    role?: string
    surfaceId?: string
    stateKeys?: string[]
    toolCalls?: Array<{ toolName?: string }>
    values?: Record<string, unknown>
  }
}

/**
 * Reads the Health Space's Event log (ADR-0003) the same way the PWA would:
 * a Bearer token from `localStorage` (the same key `pwa-storage.ts` uses),
 * since `/api/spaces/:spaceId/events` is auth-gated like every other `/api`
 * route once the daemon is running with production auth.
 */
async function fetchSpaceEvents(page: Page, origin: string): Promise<SpaceEventEntry[]> {
  const token = await page.evaluate(() => localStorage.getItem('veduta.authToken'))
  const response = await page.request.get(`${origin}/api/spaces/spc-health/events`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  expect(response.ok()).toBe(true)
  const body = (await response.json()) as { events: SpaceEventEntry[] }
  return body.events
}

interface SnapshotSurface {
  id: string
  title: string
  state: Record<string, unknown>
  validity?: {
    kind: string
    window: string
    startsAt: string
    expiresAt: string
    source: { stateKey: string; occurredAtKey: string }
    projectionStateKeys: string[]
  }
}

/** Reads a Surface through the same authenticated Home snapshot endpoint used by the PWA. */
async function fetchSurface(
  page: Page,
  origin: string,
  surfaceId: string,
): Promise<SnapshotSurface> {
  const surfaces = await fetchSurfaces(page, origin)
  const surface = surfaces.find(({ id }) => id === surfaceId)
  if (!surface) throw new Error(`snapshot did not contain Surface ${surfaceId}`)
  return surface
}

async function fetchSurfaceByTitle(
  page: Page,
  origin: string,
  title: string,
): Promise<SnapshotSurface> {
  const surfaces = await fetchSurfaces(page, origin)
  const surface = surfaces.find((candidate) => candidate.title === title)
  if (!surface) throw new Error(`snapshot did not contain Surface titled ${title}`)
  return surface
}

async function fetchSurfaces(page: Page, origin: string): Promise<SnapshotSurface[]> {
  const token = await page.evaluate(() => localStorage.getItem('veduta.authToken'))
  const response = await page.request.get(`${origin}/api/spaces`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  expect(response.ok()).toBe(true)
  const body = (await response.json()) as {
    spaces: Array<{ surfaces: SnapshotSurface[] }>
  }
  return body.spaces.flatMap((space) => space.surfaces)
}

function formSubmitEvents(events: SpaceEventEntry[], surfaceId: string): SpaceEventEntry[] {
  return events.filter(
    (event) =>
      event.type === 'fast_path' &&
      event.payload?.surfaceId === surfaceId &&
      Array.isArray(event.payload.stateKeys),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The Event log entry the mock chat->Surface demo's meal patch produces (`SurfaceEngine.patchState`). */
function isMealPatchEvent(event: SpaceEventEntry): boolean {
  return event.type === 'surface.patch_state' && event.text.includes('Meals')
}

/** The Event log entry the Groceries "Milk" checkbox's fast path produces (`SurfaceEngine.applyFastAction`). */
function isGroceriesToggleEvent(event: SpaceEventEntry): boolean {
  return event.type === 'fast_path' && event.text.includes('milk')
}
