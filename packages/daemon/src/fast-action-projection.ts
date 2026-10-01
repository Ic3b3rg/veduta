import type { CommittedFastActionOutcome } from '@veduta/protocol'

/** Whole-key mutations from one committed batch, deduplicated in declaration order. */
export function fastActionChangedKeys(outcome: CommittedFastActionOutcome): string[] {
  return [
    ...new Set(
      outcome.patch.operations.flatMap((operation) =>
        operation.target === 'state'
          ? [operation.path.slice(1).replace(/~1/g, '/').replace(/~0/g, '~')]
          : [],
      ),
    ),
  ]
}
