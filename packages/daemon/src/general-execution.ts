import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { defineTool, type ToolDef } from './agent-runner.ts'
import { defaultRedactor } from './redaction.ts'
import type { Store } from './store.ts'

const OUTPUT_LIMIT = 32 * 1024
const DEFAULT_DEADLINE_MS = 30_000

export interface CommandResult {
  command: string
  cwd: string
  durationMs: number
  exitCode: number | null
  cancelled: boolean
  timedOut: boolean
  outputLimited: boolean
  stdout: string
  stderr: string
}

export interface CommandRequest {
  command: string
  cwd: string
  deadlineMs?: number
  signal?: AbortSignal | undefined
}

function safeEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: process.env['HOME'] ?? '/',
    LANG: process.env['LANG'] ?? 'C.UTF-8',
  }
}

/** Process isolation is the configured host or container, not a semantic command sandbox. */
export async function runCommand(request: CommandRequest): Promise<CommandResult> {
  if (!isAbsolute(request.cwd) || !statSync(request.cwd).isDirectory()) {
    throw new Error('Command working directory must be an existing absolute directory')
  }
  if (!request.command.trim() || request.command.length > 8192) {
    throw new Error('Command must be between 1 and 8192 characters')
  }
  if (defaultRedactor.redactText(request.command) !== request.command) {
    throw new Error('Command contains credential material')
  }
  const deadlineMs = request.deadlineMs ?? DEFAULT_DEADLINE_MS
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 1_200_000) {
    throw new Error('Command deadline must be between 1 and 1200000 ms')
  }
  const started = performance.now()
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(request.command, {
      cwd: request.cwd,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: safeEnvironment(),
    })
    let stdout = ''
    let stderr = ''
    let cancelled = false
    let timedOut = false
    let outputLimited = false
    let settled = false
    const terminate = () => {
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      } else child.kill('SIGKILL')
    }
    const onAbort = () => {
      cancelled = true
      terminate()
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, deadlineMs)
    const collect = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      const text = chunk.toString('utf8')
      if (stream === 'stdout') stdout += text
      else stderr += text
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > OUTPUT_LIMIT) {
        outputLimited = true
        terminate()
      }
    }
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'))
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'))
    request.signal?.addEventListener('abort', onAbort, { once: true })
    if (request.signal?.aborted) onAbort()
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.once('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
      resolve({
        command: request.command,
        cwd: request.cwd,
        durationMs: Math.round(performance.now() - started),
        exitCode,
        cancelled,
        timedOut,
        outputLimited,
        stdout: stdout.slice(0, OUTPUT_LIMIT),
        stderr: stderr.slice(0, OUTPUT_LIMIT),
      })
    })
  })
}

export function createGeneralExecutionTool(
  store: Store,
  run: (request: CommandRequest) => Promise<CommandResult> = runCommand,
): ToolDef {
  return defineTool({
    name: 'execute_command',
    description:
      'Run a command through Veduta-owned execution with an explicit working directory, deadline, cancellation, bounded output, and redacted audit. The host is the process boundary. Set outputMode=transient for sensitive data; that output is discarded from Agent and durable state.',
    schema: z
      .object({
        command: z.string().min(1).max(8192),
        cwd: z.string().min(1),
        deadlineMs: z.number().int().min(1).max(1_200_000).optional(),
        outputMode: z.enum(['ordinary', 'transient']),
      })
      .strict(),
    level: 'general',
    egressDomains: [],
    async handler(input, context) {
      if (!context.currentUserRequest || !context.spaceId) {
        return { content: 'A current trusted user request in a Space is required.' }
      }
      const result = await run({
        command: input.command,
        cwd: input.cwd,
        ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      })
      const safeCommand = defaultRedactor.redactText(result.command)
      const safeStdout = defaultRedactor.redactText(result.stdout)
      const safeStderr = defaultRedactor.redactText(result.stderr)
      const outcome = {
        command: safeCommand,
        cwd: result.cwd,
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        cancelled: result.cancelled,
        timedOut: result.timedOut,
        outputLimited: result.outputLimited,
        outputMode: input.outputMode,
      }
      store.spacesEngine.appendEvent(context.spaceId, {
        type: 'tool.execution',
        text: `Command finished with exit status ${result.exitCode ?? 'signal'}`,
        origin: 'trusted:system',
        payload: outcome,
      })
      return {
        content: JSON.stringify({
          ...outcome,
          ...(input.outputMode === 'ordinary'
            ? { stdout: safeStdout, stderr: safeStderr }
            : { stdout: '[transient]', stderr: '[transient]' }),
        }),
        details: outcome,
        origins: ['untrusted:command'],
      }
    },
  })
}
