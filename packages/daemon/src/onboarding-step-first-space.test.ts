import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadOnboardingConfig } from './onboarding-config.ts'
import { OnboardingStepError } from './onboarding-status.ts'
import { applyFirstSpace } from './onboarding-step-first-space.ts'
import { SpacesEngine } from './spaces-engine.ts'

let rootDir: string | undefined

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
  rootDir = undefined
})

function freshRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-onboarding-first-space-'))
  return rootDir
}

describe('applyFirstSpace', () => {
  it('creates a new Space and records it in onboarding.json', () => {
    const dir = freshRoot()
    const spacesEngine = new SpacesEngine({ rootDir: join(dir, '.veduta') })

    const result = applyFirstSpace({ rootDir: dir, spacesEngine }, { name: 'Personal' })

    expect(result).toEqual({ spaceId: 'spc-personal', slug: 'personal', created: true })
    expect(spacesEngine.listSpaces().map((space) => space.slug)).toEqual(['personal'])
    const config = loadOnboardingConfig(dir)
    expect(config.firstSpace).toEqual({
      name: 'Personal',
      slug: 'personal',
      spaceId: 'spc-personal',
    })
    expect(config.steps['first-space']).toBe('completed')
  })

  it('reconciles by slug after a crash between Space creation and the config write: no duplicate Space', () => {
    const dir = freshRoot()
    const spacesEngine = new SpacesEngine({ rootDir: join(dir, '.veduta') })

    // Simulate the side effect having already happened (a crash before the
    // onboarding.json write landed): the Space exists, but onboarding.json
    // has no record of it yet.
    spacesEngine.createSpace({ name: 'Personal' })
    expect(loadOnboardingConfig(dir).firstSpace).toBeUndefined()

    const result = applyFirstSpace({ rootDir: dir, spacesEngine }, { name: 'Personal' })

    expect(result).toEqual({ spaceId: 'spc-personal', slug: 'personal', created: false })
    expect(spacesEngine.listSpaces()).toHaveLength(1)
  })

  it('re-applying after completion is idempotent: no duplicate Space, same result', () => {
    const dir = freshRoot()
    const spacesEngine = new SpacesEngine({ rootDir: join(dir, '.veduta') })

    const first = applyFirstSpace({ rootDir: dir, spacesEngine }, { name: 'Personal' })
    const second = applyFirstSpace({ rootDir: dir, spacesEngine }, { name: 'Personal' })

    expect(second).toEqual({ ...first, created: false })
    expect(spacesEngine.listSpaces()).toHaveLength(1)
  })

  it('reconciles to the recorded slug even when a different name is submitted after completion', () => {
    const dir = freshRoot()
    const spacesEngine = new SpacesEngine({ rootDir: join(dir, '.veduta') })

    applyFirstSpace({ rootDir: dir, spacesEngine }, { name: 'Personal' })
    const result = applyFirstSpace({ rootDir: dir, spacesEngine }, { name: 'Something Else' })

    expect(result).toEqual({ spaceId: 'spc-personal', slug: 'personal', created: false })
    expect(spacesEngine.listSpaces()).toHaveLength(1)
    // The name in the request is still recorded, only the Space is reconciled by slug.
    expect(loadOnboardingConfig(dir).firstSpace).toEqual({
      name: 'Something Else',
      slug: 'personal',
      spaceId: 'spc-personal',
    })
  })

  it('rejects a name that slugifies to empty with a clear user error, not a leaked ZodError', () => {
    const dir = freshRoot()
    const spacesEngine = new SpacesEngine({ rootDir: join(dir, '.veduta') })

    expect(() => applyFirstSpace({ rootDir: dir, spacesEngine }, { name: '!!!' })).toThrow(
      OnboardingStepError,
    )
    expect(() => applyFirstSpace({ rootDir: dir, spacesEngine }, { name: '!!!' })).toThrow(
      /Space name must contain at least one letter or digit/,
    )
    expect(spacesEngine.listSpaces()).toHaveLength(0)
    expect(loadOnboardingConfig(dir).firstSpace).toBeUndefined()
  })
})
