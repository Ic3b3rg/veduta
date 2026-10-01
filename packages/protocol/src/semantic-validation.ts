import { z } from 'zod'

/** Shared diagnostic contract for protocol, Gateway, and Agent tool rejection. */
export const SemanticValidationIssueSchema = z
  .object({
    path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict()

export type SemanticValidationIssue = z.infer<typeof SemanticValidationIssueSchema>

/** Expand structural failures to precise fields without discarding semantic issue codes. */
export function semanticValidationIssues(error: z.ZodError): SemanticValidationIssue[] {
  const issues: SemanticValidationIssue[] = []
  const seen = new Set<string>()
  function add(issue: SemanticValidationIssue): void {
    const signature = JSON.stringify(issue)
    if (!seen.has(signature)) issues.push(issue)
    seen.add(signature)
  }
  function collect(problems: readonly z.ZodIssue[]): void {
    for (const issue of problems) {
      if (issue.code === 'invalid_union') {
        // Prefer branches whose direct discriminators matched. A malformed
        // tree replacement should explain its value, not state/remove shapes.
        const branches = issue.unionErrors.map((branch) => ({
          branch,
          mismatches: branch.issues.filter(
            (problem) =>
              problem.path.length === issue.path.length + 1 &&
              (problem.code === 'invalid_literal' || problem.code === 'invalid_enum_value'),
          ).length,
        }))
        const minimum = Math.min(...branches.map(({ mismatches }) => mismatches))
        branches
          .filter(({ mismatches }) => mismatches === minimum)
          .forEach(({ branch }) => collect(branch.issues))
      } else if (issue.code === 'unrecognized_keys') {
        issue.keys.forEach((key) =>
          add({
            path: [...issue.path, key],
            code: issue.code,
            message: `Unrecognized key "${key}"`,
          }),
        )
      } else {
        const code = issue.code === 'custom' ? issue.params?.['semanticCode'] : undefined
        add({
          path: issue.path,
          code: typeof code === 'string' && code.length > 0 ? code : issue.code,
          message: issue.message,
        })
      }
    }
  }
  collect(error.issues)
  return issues
}
