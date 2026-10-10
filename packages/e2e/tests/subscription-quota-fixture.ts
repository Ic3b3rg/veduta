import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConnectionsConfig } from '../../daemon/src/connections-config.ts'

export const QUOTA_CONNECTION_ID = 'aaaaaaaa-0000-4000-8000-000000000231'
export const QUOTA_CONNECTION_LABEL = 'Quota recovery fixture'
export const QUOTA_MODEL_ID = 'gpt-5-codex'
export const QUOTA_RECOVERY_REPLY = 'Subscription recovery verified. This is a new successful turn.'

export type QuotaProviderPhase = 'limited' | 'recovered' | 'rate-limit' | 'unauthorized'

/** Real stdio transport and adapter, with a provider process that has no network or credentials. */
export function createQuotaRuntimeFixture() {
  const baseDir = mkdtempSync(join(tmpdir(), 'veduta-e2e-quota-'))
  const rootDir = join(baseDir, 'data')
  mkdirSync(rootDir, { recursive: true })
  const binary = join(baseDir, 'codex-fixture.mjs')
  const phaseFile = join(baseDir, 'phase')
  const callsFile = join(baseDir, 'provider-calls')
  writeFileSync(binary, `#!${process.execPath}\n${PROVIDER_SOURCE}`, { mode: 0o700 })
  writeFileSync(phaseFile, 'limited')
  const now = new Date().toISOString()
  saveConnectionsConfig(rootDir, {
    version: 1,
    mockEnabled: false,
    selection: { connectionId: QUOTA_CONNECTION_ID, modelId: QUOTA_MODEL_ID },
    connections: [
      {
        id: QUOTA_CONNECTION_ID,
        method: 'chatgpt-codex',
        provider: 'openai',
        label: QUOTA_CONNECTION_LABEL,
        state: 'connected',
        stateAt: now,
        createdAt: now,
        enabledForFallback: false,
        selectedModelId: QUOTA_MODEL_ID,
        catalog: [{ id: QUOTA_MODEL_ID, label: QUOTA_CONNECTION_LABEL, routable: true }],
      },
    ],
  })
  const calls = () =>
    existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n') : []
  return {
    baseDir,
    rootDir,
    binary,
    setPhase: (phase: QuotaProviderPhase) => writeFileSync(phaseFile, phase),
    turns: () => calls().filter((call) => call.startsWith('turn/start\t')).length,
    authorizationCalls: () => calls().filter((call) => call.startsWith('account/login')).length,
  }
}

const PROVIDER_SOURCE = String.raw`
import { createInterface } from 'node:readline'
import { readFileSync, appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\n')
const notify = (method, params) => send({ method, params })
createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line)
  if (!frame.method || frame.id === undefined) return
  const phase = readFileSync(join(root, 'phase'), 'utf8').trim()
  appendFileSync(join(root, 'provider-calls'), frame.method + '\t' + phase + '\n')
  const respond = (result) => send({ id: frame.id, result })
  switch (frame.method) {
    case 'initialize':
      respond({ userAgent: 'veduta/0.160.0 (deterministic fixture)', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'linux' })
      break
    case 'account/read':
      respond({ account: { type: 'chatgpt', planType: 'Fixture subscription' }, requiresOpenaiAuth: false })
      break
    case 'model/list':
      respond({ data: [{ id: 'gpt-5-codex', displayName: 'Quota recovery fixture', isDefault: true }], nextCursor: null })
      break
    case 'thread/start':
      respond({ thread: { id: randomUUID() } })
      break
    case 'turn/start': {
      const threadId = frame.params.threadId
      const turnId = randomUUID()
      respond({ turn: { id: turnId } })
      if (phase === 'recovered') {
        const prompt = frame.params.input.map((item) => item.text ?? '').join('\n')
        const delta = prompt.includes('Resolve the CURRENT user request for an external service.')
          ? JSON.stringify({ status: 'none' })
          : 'Subscription recovery verified. This is a new successful turn.'
        notify('item/agentMessage/delta', { threadId, turnId, itemId: 'reply', delta })
        notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', error: null } })
      } else {
        const codexErrorInfo = phase === 'rate-limit' ? 'rateLimitExceeded' : phase === 'unauthorized' ? 'unauthorized' : 'usageLimitExceeded'
        if (phase === 'limited') notify('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 100, resetsAt: 1791630000 }, secondary: null } })
        const error = { message: 'Deterministic fixture failure.', codexErrorInfo }
        notify('error', { threadId, turnId, error, willRetry: false })
        notify('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error } })
      }
      break
    }
    case 'turn/interrupt':
      respond({})
      break
    default:
      send({ id: frame.id, error: { code: -32601, message: 'Unsupported fixture call' } })
  }
})
`
