import { execFileSync } from 'node:child_process'
import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** Build once before any workers start; CI reuses the assets from its build job (#277). */
export default async function globalSetup(): Promise<void> {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
  if (process.env['VEDUTA_E2E_PREBUILT_PWA'] !== '1') {
    execFileSync('pnpm', ['--filter', '@veduta/pwa', 'build'], {
      cwd: repoRoot,
      stdio: 'inherit',
    })
  }
  try {
    await access(new URL('../pwa/dist/index.html', import.meta.url))
  } catch {
    throw new Error('E2E requires a PWA build; run: pnpm --filter @veduta/pwa build')
  }
}
