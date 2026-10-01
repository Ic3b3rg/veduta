import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeJsonAtomicDurable } from './atomic-file.ts'

const EffectFile = z
  .object({
    version: z.literal(1),
    effectId: z.string().uuid(),
    requestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    state: z.enum(['started', 'confirmed']),
    issueNumber: z.number().int().positive().optional(),
  })
  .strict()

/** A started effect is deliberately never sent again after a crash: GitHub has no idempotency key for issue creation. */
export class GithubMcpEffects {
  constructor(private readonly rootDir: string) {}

  begin(input: {
    effectId: string
    spaceId: string
    owner: string
    repo: string
    title: string
    body: string
  }): number | undefined {
    const existing = this.status(input)
    if (existing !== undefined) return existing
    const path = this.path(input.effectId)
    writeJsonAtomicDurable(
      path,
      EffectFile.parse({
        version: 1,
        effectId: input.effectId,
        requestSha256: requestSha256(input),
        state: 'started',
      }),
    )
    return undefined
  }

  status(input: {
    effectId: string
    spaceId: string
    owner: string
    repo: string
    title: string
    body: string
  }): number | undefined {
    const path = this.path(input.effectId)
    if (!existsSync(path)) return undefined
    const file = EffectFile.parse(JSON.parse(readFileSync(path, 'utf8')))
    if (file.requestSha256 !== requestSha256(input))
      throw new Error('GitHub MCP effect identity was reused for another request')
    if (file.state === 'confirmed') return file.issueNumber
    throw new Error(
      'GitHub issue outcome is unknown after interruption. Inspect the repository before requesting another write.',
    )
  }

  confirm(effectId: string, issueNumber: number): void {
    const path = this.path(effectId)
    const file = EffectFile.parse(JSON.parse(readFileSync(path, 'utf8')))
    writeJsonAtomicDurable(path, EffectFile.parse({ ...file, state: 'confirmed', issueNumber }))
  }

  private path(effectId: string): string {
    const id = z.string().uuid().parse(effectId)
    return join(this.rootDir, 'github-mcp-effects', `${id}.json`)
  }
}

function requestSha256(input: {
  spaceId: string
  owner: string
  repo: string
  title: string
  body: string
}): string {
  return createHash('sha256')
    .update(JSON.stringify([input.spaceId, input.owner, input.repo, input.title, input.body]))
    .digest('hex')
}
