import type { ImportItem, ImportPlan, ImportResult, ImportSourceKind } from '@veduta/protocol'

/**
 * Pure presentation logic for the migration step's preview (issue 020,
 * `tasks/plan.md` T8): grouping and enablement rules extracted out of
 * `wizard-step-migration.tsx` so they are unit-testable without a component
 * rendering harness (the PWA package has none — see `onboarding-state.ts`'s
 * doc comment for the same convention). The component stays a thin renderer
 * over these functions.
 */

/** Per-source preview state the wizard shell owns (`tasks/plan.md` T8 §C):
 * `plan` is `undefined` while nothing has been previewed yet for the current
 * `(source, overwrite)` pair -- including the moment right after `overwrite`
 * is toggled, before the re-preview it triggers has returned (design
 * decision 7: a stale plan must never be what Apply offers to run).
 * `result` is set once `runLegacyImport` has completed for this preview. */
export interface MigrationPreviewState {
  source: ImportSourceKind
  overwrite: boolean
  plan: ImportPlan | undefined
  result: ImportResult | undefined
}

/** One labelled group per `ImportAction` (`tasks/plan.md` T8 AC: "three
 * labelled groups -- Import, Overwrite, Skip"). Every group is always
 * present, even when empty, so the component renders an explicit "none"
 * rather than a group disappearing. */
export interface GroupedImportItems {
  import: ImportItem[]
  overwrite: ImportItem[]
  skip: ImportItem[]
}

/** Splits `plan.items` by `action` into the three labelled groups. */
export function groupImportItems(items: readonly ImportItem[]): GroupedImportItems {
  const groups: GroupedImportItems = { import: [], overwrite: [], skip: [] }
  for (const item of items) {
    groups[item.action].push(item)
  }
  return groups
}

/**
 * Whether Apply may run for this plan and this exact `overwrite` selection
 * (`tasks/plan.md` design decision 7/8). `false` when there is no plan yet
 * (never previewed, or a stale one was just cleared by toggling
 * `overwrite`), when the plan is blocked (decision 8: refusals never clear
 * on their own), or when the plan on hand was built for a different
 * `overwrite` value than what is currently selected -- the defence-in-depth
 * case a race between two toggles could otherwise produce.
 */
export function isApplyOffered(plan: ImportPlan | undefined, overwrite: boolean): boolean {
  if (plan === undefined) return false
  if (plan.blocked.length > 0) return false
  return plan.options.overwrite === overwrite
}

/** The `Overwrite` checkbox only ever renders when the plan says at least
 * one item needs it (`tasks/plan.md` T8 AC: "off by default and shown only
 * when the plan requires it"). */
export function showsOverwriteToggle(plan: ImportPlan): boolean {
  return plan.requiresOverwrite
}

/**
 * The state to show the instant a preview is (re)started for `(source,
 * overwrite)` -- before the request that will populate `plan` has resolved
 * (`tasks/plan.md` design decision 7). Always returns `plan: undefined,
 * result: undefined` regardless of whatever was previously on screen: this is
 * what makes toggling `Overwrite` clear the stale plan rather than leaving
 * the old one visible (and, via `isApplyOffered`, applicable) until the fresh
 * one arrives. The wizard shell (`onboarding-wizard.tsx`'s
 * `runMigrationPreview`) sets this synchronously, then fetches and only
 * overwrites `plan` once the new one is schema-validated.
 */
export function startMigrationPreview(
  source: ImportSourceKind,
  overwrite: boolean,
): MigrationPreviewState {
  return { source, overwrite, plan: undefined, result: undefined }
}
