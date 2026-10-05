import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

function serviceDirective(unit: string, name: string): string | undefined {
  let inService = false
  let value: string | undefined
  for (const line of unit.split('\n').map((line) => line.trim())) {
    if (line.startsWith('[')) inService = line === '[Service]'
    else if (inService && line.startsWith(`${name}=`)) value = line.slice(name.length + 1)
  }
  return value
}

function generatedOverride(): string {
  const source = readFileSync(new URL('../../../deploy/install.sh', import.meta.url), 'utf8')
  const entryPoint = '\nmain "$@"'
  const position = source.lastIndexOf(entryPoint)
  if (position < 0) throw new Error('installer entry point not found')
  const result = spawnSync('bash', ['-s'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 5000,
    input: `${source.slice(0, position)}
run() { :; }
run_quiet() {
  if [ "$1" = tee ] && [ "$2" = /etc/systemd/system/veduta.service.d/override.conf ]; then
    cat
  else
    cat >/dev/null
  fi
}
head() { printf fixture-code; }
DOMAIN=example.invalid
EMAIL=operator@example.invalid
systemd_unit_stage
`,
  })
  if (result.status !== 0) throw new Error(`unit generation failed: ${result.stderr}`)
  return result.stdout
}

describe('VPS supervision contract (issue #36)', () => {
  it('restarts deliberate clean exits as well as failures on both documented install paths', () => {
    const manual = readFileSync(new URL('../../../deploy/veduta.service', import.meta.url), 'utf8')
    const generated = generatedOverride()

    // Restart=always covers onboarding's exit 0, failures, and the update request exit code.
    // An explicit systemctl stop still suppresses restart under systemd's service contract.
    expect(serviceDirective(manual, 'Restart')).toBe('always')
    expect(serviceDirective(generated, 'Restart')).toBe('always')
  })
})
