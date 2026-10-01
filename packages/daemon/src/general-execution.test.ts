import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolContext } from './agent-runner.ts'
import { createGeneralExecutionTool, runCommand } from './general-execution.ts'
import { defaultRedactor } from './redaction.ts'
import { Store } from './store.ts'
import { TurnTaintAccumulator } from './taint.ts'

const dirs: string[] = []
afterEach(() => {
  delete process.env['VEDUTA_VAULT_KEY']
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'veduta-command-'))
  dirs.push(dir)
  return dir
}

describe('Veduta-owned general execution', () => {
  it('runs a harmless command with explicit cwd and a redacted, content-free audit', async () => {
    const cwd = fixture()
    const store = new Store({ rootDir: cwd })
    const space = store.spacesEngine.createSpace({ name: 'CLI fixture' })
    const tool = createGeneralExecutionTool(store)
    const context = fromPartial<ToolContext>({
      toolCallId: 'command-fixture',
      origin: 'trusted:user',
      origins: ['trusted:user'],
      taint: new TurnTaintAccumulator(['trusted:user']),
      spaceId: space.id,
      currentUserRequest: { text: 'Run the harmless fixture CLI', origin: 'trusted:user' },
      contextHash: 'fixture',
    })
    try {
      const result = await tool.handler(
        tool.schema.parse({ command: 'printf fixture-output', cwd, outputMode: 'ordinary' }),
        context,
      )
      expect(JSON.parse(result.content)).toMatchObject({
        command: 'printf fixture-output',
        cwd,
        exitCode: 0,
        cancelled: false,
        timedOut: false,
        outputLimited: false,
        stdout: 'fixture-output',
      })
      expect(JSON.parse(result.content).durationMs).toBeGreaterThanOrEqual(0)
      expect(store.eventLog(space.id).at(-1)).toMatchObject({
        type: 'tool.execution',
        payload: { command: 'printf fixture-output', cwd, exitCode: 0, outputMode: 'ordinary' },
      })
      expect(store.eventLog(space.id).at(-1)?.payload).not.toHaveProperty('stdout')
      expect(result.origins).toEqual(['untrusted:command'])
    } finally {
      store.close()
    }
  })

  it('bounds output, handles timeout and cancellation, and strips daemon secrets from child env', async () => {
    const cwd = fixture()
    process.env['VEDUTA_VAULT_KEY'] = 'private-fixture-vault-key'
    const environment = await runCommand({ command: 'env', cwd })
    expect(environment.stdout).not.toContain('private-fixture-vault-key')
    const limited = await runCommand({ command: 'head -c 40000 /dev/zero', cwd })
    expect(limited.outputLimited).toBe(true)
    expect(limited.stdout.length).toBeLessThanOrEqual(32 * 1024)
    const timedOut = await runCommand({ command: 'sleep 5', cwd, deadlineMs: 30 })
    expect(timedOut.timedOut).toBe(true)
    const controller = new AbortController()
    const running = runCommand({ command: 'sleep 5', cwd, signal: controller.signal })
    setTimeout(() => controller.abort(), 30)
    expect((await running).cancelled).toBe(true)
    defaultRedactor.register('fixture-private-secret')
    await expect(runCommand({ command: 'printf fixture-private-secret', cwd })).rejects.toThrow(
      'credential material',
    )
  })
})
