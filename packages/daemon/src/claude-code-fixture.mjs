#!/usr/bin/env node
// External CLI boundary fixture for issue #285. No network or real credentials.
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import process from 'node:process'
import { setInterval } from 'node:timers'

const args = process.argv.slice(2)
const dir = process.env.CLAUDE_CONFIG_DIR
const auth = join(dir, 'fixture-authorized')
const configFile = join(dir, 'fixture.json')
const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {}
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
if (args[0] === '--version') {
  process.stdout.write(`${config.version ?? '2.1.303'} (Claude Code)\n`)
} else if (args[0] === 'auth' && args[1] === 'login') {
  process.stdout.write('Sign in: https://claude.com/cai/oauth/authorize?state=fixture\n')
  createInterface({ input: process.stdin }).once('line', (code) => {
    if (code !== 'authorized') process.exit(1)
    writeFileSync(auth, 'yes')
    process.exit(0)
  })
} else if (args[0] === 'auth' && args[1] === 'status') {
  emit({
    loggedIn: existsSync(auth),
    authMethod: existsSync(auth) ? (config.authMethod ?? 'claude.ai') : 'none',
    email: 'fixture@example.test',
    subscriptionType: 'max',
  })
  process.exitCode = existsSync(auth) ? 0 : 1
} else if (args[0] === 'auth' && args[1] === 'logout') {
  if (existsSync(auth)) unlinkSync(auth)
} else if (args.includes('--input-format')) {
  createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line)
    emit({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: request.request_id,
        response: {
          models: [
            { value: 'default', resolvedModel: 'claude-test-model', displayName: 'Default' },
            { value: 'opus', resolvedModel: 'claude-test-model', displayName: 'Opus' },
            { value: 'sonnet', resolvedModel: 'claude-second-model', displayName: 'Sonnet' },
          ],
        },
      },
    })
  })
} else {
  writeFileSync(
    join(dir, 'fixture-launch.json'),
    JSON.stringify({
      args,
      ambientCredentials: [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
        'CLAUDECODE',
      ].some((name) => process.env[name] !== undefined),
      cwd: process.cwd(),
    }),
  )
  if (config.scenario === 'hang') setInterval(() => {}, 1000)
  else {
    let input = ''
    process.stdin.on('data', (chunk) => {
      input += chunk
    })
    process.stdin.on('end', () => {
      if (config.scenario === 'formatting-limit') {
        emit({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'The user mentioned 401 authentication.' }] },
        })
        emit({
          type: 'result',
          subtype: 'error_max_structured_output_retries',
          is_error: true,
          errors: ['Formatting retries exhausted'],
        })
        return
      }
      if (config.scenario === 'network') {
        emit({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['503 service unavailable'],
        })
        return
      }
      if (config.scenario === 'native-tool')
        emit({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'Bash', input: { command: 'forbidden' } }],
          },
        })
      if (config.scenario === 'oversized') {
        process.stdout.write('x'.repeat(17 * 1024 * 1024))
        return
      }
      if (config.scenario === 'rate-limit') {
        emit({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['429 rate_limit'],
        })
        return
      }
      if (config.scenario === 'expired') {
        emit({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['401 authentication failed'],
        })
        return
      }
      const prompt = JSON.parse(input)
      const hasResult = prompt.messages.some((message) => message.role === 'tool')
      const counterPath = join(dir, 'fixture-counter')
      const counter = existsSync(counterPath) ? Number(readFileSync(counterPath, 'utf8')) : 0
      writeFileSync(counterPath, String(counter + 1))
      const output =
        config.outputs?.[counter] ??
        config.output ??
        (prompt.tools.length > 0 && !hasResult
          ? {
              text: '',
              toolCall: {
                name: prompt.tools[0].name,
                inputJson: JSON.stringify({ title: 'Claude Surface' }),
              },
            }
          : { text: 'Claude completed the request.', toolCall: null })
      emit({ type: 'result', subtype: 'success', is_error: false, structured_output: output })
    })
  }
}
