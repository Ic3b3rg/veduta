import { chromium, expect, type Page } from '@playwright/test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  DEMO_SPACE_REQUEST,
  DEMO_CREATE_REQUEST,
  DEMO_EDIT_REQUEST,
  DEMO_SURFACE_ID,
  demoSeed,
} from '@veduta/demo-data'
import { Store } from '../../daemon/src/store.ts'
import { buildServer } from '../../daemon/src/server.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const output = join(root, 'docs/media')
const temporary = await mkdtemp(join(tmpdir(), 'veduta-recording-'))
const dataDir = join(temporary, 'data')
const serveOnly = process.argv.includes('--serve')
const screenshotsOnly = process.argv.includes('--screenshots-only')

// A capture must never inherit the operator's provider keys or Veduta configuration.
const allowedEnv = new Set(['PATH', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'NODE_EXTRA_CA_CERTS'])
for (const key of Object.keys(process.env)) if (!allowedEnv.has(key)) delete process.env[key]
if (
  !serveOnly &&
  !screenshotsOnly &&
  ['ffmpeg', 'ffprobe'].some(
    (binary) => spawnSync(binary, ['-version'], { stdio: 'ignore' }).status !== 0,
  )
)
  throw new Error('Install ffmpeg first (macOS: brew install ffmpeg), or use --screenshots-only.')

await mkdir(output, { recursive: true })
const seed = new Store({ rootDir: dataDir, seed: demoSeed() })
seed.close()
const options = {
  dataDir,
  pwaDistDir: join(root, 'packages/pwa/dist'),
  commandRun: async () => {
    throw new Error('System commands are disabled in the recording environment')
  },
}
let gateway = buildServer(options)
const address = await gateway.app.listen({ host: '127.0.0.1', port: serveOnly ? 8790 : 0 })
const origin = new URL(address).origin
const cues: Array<{ start: number; end: number; text: string }> = []
let started = 0
let lastCaption = ''

async function caption(page: Page, text: string) {
  const seconds = (performance.now() - started) / 1000
  if (lastCaption) cues.push({ start: cues.at(-1)?.end ?? 0, end: seconds, text: lastCaption })
  lastCaption = text
  await page.evaluate((copy) => {
    let annotation = document.getElementById('demo-recording-caption')
    if (!annotation) {
      annotation = document.createElement('div')
      annotation.id = 'demo-recording-caption'
      annotation.style.cssText =
        'position:fixed;bottom:18px;left:24px;max-width:850px;padding:14px 20px;z-index:9999;background:#0f1017;color:#f4f4f5;border:1px solid #30313d;border-radius:12px;font:16px/1.5 system-ui;pointer-events:none;'
      document.body.append(annotation)
    }
    annotation.textContent = copy
  }, text)
}

async function send(page: Page, text: string) {
  const input = page.getByRole('textbox', { name: /^Message Veduta/ })
  await input.pressSequentially(text, { delay: screenshotsOnly ? 0 : 28 })
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
}

const pause = (page: Page, ms: number) => page.waitForTimeout(screenshotsOnly ? 150 : ms)
const card = (page: Page) =>
  page
    .locator('.surface-card')
    .filter({ has: page.getByRole('heading', { name: 'This week, in focus', exact: true }) })
const timestamp = (seconds: number) =>
  new Date(Math.round(seconds * 1000)).toISOString().slice(11, 23)

if (serveOnly) {
  console.log(`Isolated recording environment: ${origin} (mock provider, fictional data)`)
  console.log('Ctrl-C stops it and removes its temporary data. Do not publish this Gateway.')
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve)
    process.once('SIGTERM', resolve)
  })
  await gateway.app.close()
  await rm(temporary, { recursive: true, force: true })
} else {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await chromium.launch()
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      locale: 'en-US',
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
      ...(!screenshotsOnly
        ? { recordVideo: { dir: join(temporary, 'video'), size: { width: 1440, height: 900 } } }
        : {}),
    })
    const external: string[] = []
    await context.route('**/*', (route) => {
      if (new URL(route.request().url()).origin !== origin) {
        external.push(route.request().url())
        return route.abort()
      }
      return route.continue()
    })
    const page = await context.newPage()
    const video = page.video()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(origin)
    await expect(page.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
    await page.evaluate(() => document.fonts.ready)
    started = performance.now()
    await caption(page, 'Veduta · Alpha · fictional data · scripted mock provider')
    await pause(page, 5000)
    await caption(page, 'Create a Space for the part of life you want to keep in view.')
    await send(page, DEMO_SPACE_REQUEST)
    await page.getByRole('button', { name: 'Accept Create Space “Work”', exact: true }).waitFor()
    await pause(page, 4000)
    await page.getByRole('button', { name: 'Accept Create Space “Work”', exact: true }).click()
    const workCard = page
      .locator('.space-card')
      .filter({ has: page.getByRole('heading', { name: 'Work', exact: true }) })
    await workCard.waitFor()
    await workCard.click()
    await pause(page, 3000)
    await caption(page, 'Ask the Agent for a Surface. The Gateway saves the plan in Work.')
    await send(page, DEMO_CREATE_REQUEST)
    await expect(card(page)).toBeVisible()
    await expect(page.locator('.chat-entry.assistant').last()).toContainText('Weekly plan')
    await pause(page, 7000)
    const before = await card(page).screenshot({ animations: 'disabled' })
    await caption(page, 'Change the same Surface through Chat: testers first, on Tuesday.')
    await send(page, DEMO_EDIT_REQUEST)
    await expect(card(page).getByRole('cell', { name: 'Tuesday', exact: true })).toBeVisible()
    await expect(card(page).locator('[data-veduta-atom-id="weekly-priority"]')).toContainText(
      'Talk to testers',
    )
    await expect(page.locator('.chat-entry.assistant').last()).toContainText(
      'Top priority: Talk to testers',
    )
    await pause(page, 7000)
    const after = await card(page).screenshot({ animations: 'disabled' })
    const saved = gateway.store.getSurface(DEMO_SURFACE_ID)
    expect(saved?.state['topPriority']).toBe('Talk to testers')
    await caption(page, 'Refresh the page. Your edited Surface and Chat are still here.')
    await pause(page, 2000)
    await page.reload()
    await expect(card(page).getByRole('cell', { name: 'Tuesday', exact: true })).toBeVisible()
    await expect(page.locator('.chat-entry.assistant').last()).toContainText(
      'Top priority: Talk to testers',
    )
    expect(gateway.store.getSurface(DEMO_SURFACE_ID)).toEqual(saved)
    await caption(page, 'Still here after refresh: same Space, same plan, saved changes.')
    await pause(page, 7000)
    await page.goto(origin)
    await workCard.click()
    await expect(card(page).getByRole('cell', { name: 'Tuesday', exact: true })).toBeVisible()
    await caption(
      page,
      'Come back to Work and pick up where you left off. github.com/Ic3b3rg/veduta',
    )
    await pause(page, 6000)
    const duration = (performance.now() - started) / 1000
    cues.push({ start: cues.at(-1)?.end ?? 0, end: duration, text: lastCaption })
    await context.close()

    // The proof also covers a real Gateway restart, beyond the visible page refresh.
    await gateway.app.close()
    gateway = buildServer(options)
    await gateway.app.listen({ host: '127.0.0.1', port: Number(new URL(origin).port) })
    expect(gateway.store.getSurface(DEMO_SURFACE_ID)).toEqual(saved)
    const screenshots = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: 'dark',
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    })
    const home = await screenshots.newPage()
    await home.goto(origin)
    await expect(home.locator('.app-shell')).toHaveAttribute('data-gateway-online', 'true')
    await home.screenshot({ path: join(output, 'home-desktop.png'), animations: 'disabled' })
    await home.setViewportSize({ width: 390, height: 844 })
    await home.screenshot({ path: join(output, 'home-mobile.png'), animations: 'disabled' })
    await home.setViewportSize({ width: 1440, height: 720 })
    await home.setContent(
      `<html lang="en"><head><style>*{box-sizing:border-box}body{margin:0;padding:32px;background:#0f1017;color:#f4f4f5;font:18px/1.5 system-ui}h1{font-size:24px;font-weight:500;margin:0 0 24px}main{display:grid;grid-template-columns:1fr 1fr;gap:28px}figure{margin:0}figcaption{margin-bottom:16px;color:#c1b2ff}img{width:100%;border:1px solid #30313d;border-radius:12px}footer{margin-top:24px;color:#a4a4b0;font-size:14px}</style></head><body><h1>One Surface. A conversation changes what stays.</h1><main><figure><figcaption>Before · Prototype first. Testers on Thursday.</figcaption><img src="data:image/png;base64,${before.toString('base64')}" /></figure><figure><figcaption>After · Testers first, moved to Tuesday.</figcaption><img src="data:image/png;base64,${after.toString('base64')}" /></figure></main><footer>Actual Veduta Surface · fictional data · scripted mock provider · verified after refresh and Gateway restart</footer></body></html>`,
    )
    await home.screenshot({
      path: join(output, 'surface-before-after.png'),
      animations: 'disabled',
    })
    await screenshots.close()
    expect(errors).toEqual([])
    expect(external).toEqual([])
    if (!screenshotsOnly && video) {
      const source = await video.path()
      const probeDuration = (path: string) => {
        const result = spawnSync(
          'ffprobe',
          [
            '-v',
            'error',
            '-show_entries',
            'format=duration',
            '-of',
            'default=noprint_wrappers=1:nokey=1',
            path,
          ],
          { encoding: 'utf8' },
        )
        const seconds = Number(result.stdout.trim())
        if (result.status !== 0 || !Number.isFinite(seconds) || seconds <= 0)
          throw new Error('Could not verify recording duration')
        return seconds
      }
      // Playwright starts before navigation. Remove that preroll so the first frame shows Home.
      const preroll = Math.max(0, probeDuration(source) - duration)
      const input = ['-ss', preroll.toFixed(3), '-i', source]
      const convert = (args: string[]) => {
        const result = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], {
          stdio: 'inherit',
        })
        if (result.status !== 0) throw new Error('ffmpeg conversion failed')
      }
      convert([
        ...input,
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        'slow',
        '-crf',
        '22',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        join(output, 'veduta-demo.mp4'),
      ])
      convert([
        ...input,
        '-vf',
        'setpts=0.35*PTS,fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer',
        '-loop',
        '0',
        join(output, 'veduta-demo.gif'),
      ])
      const videoDuration = probeDuration(join(output, 'veduta-demo.mp4'))
      expect(videoDuration).toBeGreaterThanOrEqual(45)
      expect(videoDuration).toBeLessThanOrEqual(90)
      await writeFile(
        join(output, 'veduta-demo.vtt'),
        'WEBVTT\n\n' +
          cues
            .map(
              (cue, i) =>
                `${i + 1}\n${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${cue.text}\n`,
            )
            .join('\n'),
      )
    }
    await writeFile(
      join(output, 'capture.json'),
      JSON.stringify(
        {
          scenario: 'weekly-plan',
          provider: 'scripted mock',
          viewport: '1440x900',
          mobileViewport: '390x844',
          checks: [
            'real Space proposal and acceptance',
            'Surface creation and edit through Agent tools',
            'page refresh and Chat restoration',
            'Gateway restart with identical Surface',
            'no external browser requests',
            'no page errors',
          ],
          revision: spawnSync('git', ['rev-parse', 'HEAD'], {
            cwd: root,
            encoding: 'utf8',
          }).stdout.trim(),
          screenshotsOnly,
        },
        null,
        2,
      ) + '\n',
    )
    console.log(`Media saved to ${output}. Refresh and Gateway restart verified.`)
    // Read once so an empty recording cannot be mistaken for generated media.
    if (!screenshotsOnly)
      expect((await readFile(join(output, 'veduta-demo.mp4'))).length).toBeGreaterThan(1000)
  } finally {
    await browser?.close()
    await gateway.app.close()
    await rm(temporary, { recursive: true, force: true })
  }
}
