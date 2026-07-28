import type { FirstSpaceRequest } from '@veduta/protocol'
import { loadOnboardingConfig, saveOnboardingConfig } from './onboarding-config.ts'
import { OnboardingStepError } from './onboarding-status.ts'
import { slugify, type SpacesEngine } from './spaces-engine.ts'

export interface FirstSpaceDeps {
  rootDir: string
  spacesEngine: SpacesEngine
}

export interface FirstSpaceResult {
  spaceId: string
  slug: string
  created: boolean
}

/**
 * `POST /api/onboarding/first-space` (§4):
 * slugifies `request.name` and reconciles by slug rather than blindly
 * creating — a re-applied request (crash-retried, or resumed after the
 * step's config write never landed) must never mint a second Space. Once
 * the step has completed once, `config.firstSpace.slug` is authoritative:
 * later re-applies (even with a different `name`) still resolve to that
 * recorded Space. Side effect (Space creation) happens before the step's
 * config is persisted, matching the side-effects-first/status-last
 * invariant. `slugify` is `spaces-engine.ts`'s own canonical rule (reused,
 * not re-implemented, so the two can never drift) — a name that slugifies
 * to `''` (no letter or digit anywhere) is rejected here with a clear user
 * error instead of reaching `SpaceSchema.parse` as an opaque ZodError.
 */
export function applyFirstSpace(
  deps: FirstSpaceDeps,
  request: FirstSpaceRequest,
): FirstSpaceResult {
  const config = loadOnboardingConfig(deps.rootDir)
  const candidateSlug = config.firstSpace?.slug ?? slugify(request.name)
  if (candidateSlug === '') {
    throw new OnboardingStepError('Space name must contain at least one letter or digit')
  }
  const existing = deps.spacesEngine.listSpaces().find((space) => space.slug === candidateSlug)

  let spaceId: string
  let slug: string
  let created: boolean
  if (existing) {
    spaceId = existing.id
    slug = existing.slug
    created = false
  } else {
    const space = deps.spacesEngine.createSpace({ name: request.name, slug: candidateSlug })
    spaceId = space.id
    slug = space.slug
    created = true
  }

  saveOnboardingConfig(deps.rootDir, {
    ...config,
    firstSpace: { name: request.name, slug, spaceId },
    steps: { ...config.steps, 'first-space': 'completed' },
  })

  return { spaceId, slug, created }
}
