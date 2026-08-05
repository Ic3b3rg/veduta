import { SurfaceSchema, type AtomNode, type Surface } from '@veduta/protocol'
import { SYSTEM_SPACE_ID } from './system-space.ts'
import { untrustedOrigin, type Origin } from './taint.ts'

/**
 * The Update Surface (issue #43, `docs/adr/0013-signed-self-update.md`):
 * current version, the discovered offer (if any), and the outcome of the
 * last apply attempt, with one-tap "Apply update" and "Check now" actions.
 * Same builder shape as `heartbeat-surface.ts`/`automations-surface.ts`:
 * pure function in, `Surface` out, fixed-slot Boxes so a live manager's
 * refresh only ever replaces a stable set of tree paths. Lives in the
 * System Space, daemon-owned (`UpdateManager` is the sole writer, never the
 * Agent — an update is a code-level decision, not something to reason
 * about), which also makes it non-pinnable: `SurfaceEngine.createSurface`
 * derives `pinnable: !daemonOwned` unconditionally (surface-engine.ts), so
 * `daemonOwned: true` alone is what keeps this un-pinnable — there is
 * nothing else to pass.
 */
export const UPDATE_SURFACE_ID = 'srf-update'

/** The state key "Apply update"'s fast action mutates — always false at rest, per the allowlist/tree-proposal one-shot idiom (`allowlist-surface.ts`, `tree-proposal.ts`): a click is a trigger, not a persisted toggle. */
export const UPDATE_APPLY_STATE_KEY = 'apply.requested'

/** The state key "Check now"'s fast action mutates — same one-shot idiom as `UPDATE_APPLY_STATE_KEY`. */
export const UPDATE_CHECK_STATE_KEY = 'check.requested'

export type UpdateSurfaceStatus =
  'idle' | 'update-available' | 'updating' | 'applied' | 'rolled-back' | 'refused'

/** The verified offer's user-facing shape: `notes` is the feed's free-text release notes, untrusted content (see `updateSurfaceContentOrigin`). */
export interface UpdateSurfaceAvailable {
  version: string
  notes: string
  /** True when the offered release's `dataVersion` is ahead of what is installed — the Caption warning a backup is taken automatically only renders when this is true. */
  migratesData: boolean
}

export interface UpdateSurfaceView {
  currentVersion: string
  available?: UpdateSurfaceAvailable
  status: UpdateSurfaceStatus
  outcomeDetail?: string
  /**
   * When the manager last completed a check, ISO instant. Not rendered as
   * its own tree node — refreshing the Surface with an unchanged view (the
   * "no newer release" case, `update-manager.ts`'s `runCheck`) still stamps
   * `freshness.updatedAt` to `now()`, which already is the visible "last
   * checked" signal. Kept on the view so callers/tests can assert the
   * manager's own bookkeeping without inspecting the Surface's freshness
   * directly.
   */
  lastCheckedAt?: string
}

const CURRENT_STAT_NODE_ID = 'update-current-version'
const AVAILABLE_SLOT_NODE_ID = 'update-available-slot'
const OUTCOME_SLOT_NODE_ID = 'update-outcome-slot'
const BUTTONS_ROW_NODE_ID = 'update-buttons'

/**
 * The origin release-notes content carries once an offer is shown
 * (`issues/043-self-update.md` "Discovery + UI";
 * `docs/adr/0013-signed-self-update.md`): the feed is an external,
 * unverified-content source, so its free-text `notes` field is always
 * `untrusted:update-feed` while an offer is displayed — even though the
 * offer only ever reaches this Surface after `verifyReleaseChain` passed
 * (`update-manager.ts`). Verifying the signature proves the bytes are
 * authentic and unmodified; it says nothing about whether the human-written
 * notes inside them are safe to treat as anything but data (SECURITY.md
 * §3.2). With no offer shown, there is nothing untrusted on the Surface, so
 * the origin is the daemon's own `trusted:system`. Exported as a pure
 * function (not inlined in the manager) so origin discipline is testable
 * without a Store.
 */
export function updateSurfaceContentOrigin(available: UpdateSurfaceAvailable | undefined): Origin {
  return available ? untrustedOrigin('update-feed') : 'trusted:system'
}

/**
 * Exported alongside the builder itself (unlike `heartbeat-surface.ts`,
 * where the manager lives in the same file and can reach these directly):
 * `update-manager.ts`'s `refreshSurface` patches each fixed slot by calling
 * these individually, the same "one function per stable tree index" idiom,
 * rather than indexing into a freshly-built tree's `children` array (which
 * `noUncheckedIndexedAccess` would otherwise force back into an `| undefined`
 * type at every call site for no benefit — the shape is fixed by
 * construction here).
 */
export function currentStatNode(view: UpdateSurfaceView): AtomNode {
  return {
    id: CURRENT_STAT_NODE_ID,
    type: 'Stat',
    props: { label: 'Current version', value: view.currentVersion },
  }
}

export function availableSlotNode(view: UpdateSurfaceView): AtomNode {
  const { available } = view
  if (!available) return { id: AVAILABLE_SLOT_NODE_ID, type: 'Box', children: [] }
  const children: AtomNode[] = [
    {
      id: 'update-available-stat',
      type: 'Stat',
      props: { label: 'Available version', value: available.version },
    },
    { id: 'update-available-notes', type: 'Markdown', props: { text: available.notes } },
  ]
  if (available.migratesData) {
    children.push({
      id: 'update-migrates-caption',
      type: 'Caption',
      props: { text: 'Migrates your data — a backup is taken automatically' },
    })
  }
  return { id: AVAILABLE_SLOT_NODE_ID, type: 'Box', children }
}

/** `applied` -> success (green), `rolled-back`/`refused` -> danger (red); every other status has no outcome badge to show. */
function outcomeTone(status: UpdateSurfaceStatus): 'success' | 'danger' | undefined {
  if (status === 'applied') return 'success'
  if (status === 'rolled-back' || status === 'refused') return 'danger'
  return undefined
}

export function outcomeSlotNode(view: UpdateSurfaceView): AtomNode {
  if (view.status === 'updating') {
    return {
      id: OUTCOME_SLOT_NODE_ID,
      type: 'Box',
      children: [
        { id: 'update-outcome-caption', type: 'Caption', props: { text: 'Applying update…' } },
      ],
    }
  }
  const tone = outcomeTone(view.status)
  if (!tone || view.outcomeDetail === undefined) {
    return { id: OUTCOME_SLOT_NODE_ID, type: 'Box', children: [] }
  }
  return {
    id: OUTCOME_SLOT_NODE_ID,
    type: 'Box',
    children: [
      { id: 'update-outcome-badge', type: 'Badge', props: { text: view.outcomeDetail, tone } },
    ],
  }
}

export function buttonsRowNode(view: UpdateSurfaceView): AtomNode {
  const children: AtomNode[] = []
  if (view.status === 'update-available') {
    children.push({
      id: 'update-apply-button',
      type: 'Button',
      props: { label: 'Apply update' },
      actions: [
        { name: 'apply', path: 'fast', payload: { value: true }, stateKey: UPDATE_APPLY_STATE_KEY },
      ],
    })
  }
  children.push({
    id: 'update-check-button',
    type: 'Button',
    props: { label: 'Check now' },
    actions: [
      { name: 'check', path: 'fast', payload: { value: true }, stateKey: UPDATE_CHECK_STATE_KEY },
    ],
  })
  return { id: BUTTONS_ROW_NODE_ID, type: 'Row', children }
}

/**
 * Builds the Update Surface from `view`. Fixed tree shape — root Box ->
 * [Title, current-version Stat, available slot, outcome slot, buttons Row]
 * — so `UpdateManager`'s refresh (`update-manager.ts`) replaces exactly
 * these five child paths on every rebuild, the same fixed-slot idiom as
 * `heartbeat-surface.ts`. `state` always declares both one-shot keys
 * (`UPDATE_APPLY_STATE_KEY`/`UPDATE_CHECK_STATE_KEY`) regardless of whether
 * the Apply button is currently in the tree: `SurfaceSchema`'s binding
 * validation only checks state keys a *present* tree node actually
 * references (`validateNodeBindings`, protocol/src/surface.ts), and an
 * unreferenced state key is never flagged, so declaring both up front means
 * a later status change that adds the Apply button never needs a
 * `state`-shape migration.
 */
export function updateSurface(
  view: UpdateSurfaceView,
  freshness: { updatedAt: string; updatedBy: 'job' },
): Surface {
  return SurfaceSchema.parse({
    id: UPDATE_SURFACE_ID,
    spaceId: SYSTEM_SPACE_ID,
    title: 'Updates',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        { id: 'title', type: 'Title', props: { text: 'Updates' } },
        currentStatNode(view),
        availableSlotNode(view),
        outcomeSlotNode(view),
        buttonsRowNode(view),
      ],
    },
    state: {
      [UPDATE_APPLY_STATE_KEY]: false,
      [UPDATE_CHECK_STATE_KEY]: false,
    },
    freshness,
  })
}
