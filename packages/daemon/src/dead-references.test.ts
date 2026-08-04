import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the AGENTS.md rule "a comment may only cite something a reader of this
 * repository can open".
 *
 * Every issue in this project is built from a working plan under `tasks/`, which is
 * scratch and is never committed. Comments used to be full of pointers into those
 * documents — `` `tasks/plan.md` §4 ``, `(decision 7)`, `(D10/A1)`, `it('B7: ...')` —
 * and every one of them was unresolvable for anyone reading the repository, including
 * the person who wrote it a month later. Worse, they read as if they were citations,
 * so they discouraged writing the reasoning down where it belongs.
 *
 * Durable rationale goes in an ADR, the `issues/NNN-*.md` spec, `docs/references/`, or
 * the comment itself. References to those ARE welcome and deliberately not matched
 * here: `issue #19`, `issues/020-importer.md`, `ADR-0007`, `docs/SECURITY.md §3.2`,
 * `AC1`, and the `L0`/`L1`/`L2` trust vocabulary all pass.
 *
 * This test scans source text rather than parsed comments on purpose: a pointer inside
 * a test name or a user-facing string is just as dead as one in a doc comment, and one
 * did in fact ship inside a CLI refusal message.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

const SCANNED_DIRS = ['packages', 'deploy']
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.css', '.sh']
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', 'tasks'])

/** This file explains the banned patterns, so it necessarily contains them. */
const SELF = 'packages/daemon/src/dead-references.test.ts'

interface DeadPattern {
  name: string
  pattern: RegExp
  fix: string
}

const DEAD_PATTERNS: DeadPattern[] = [
  {
    name: 'a path into the uncommitted tasks/ directory',
    pattern: /tasks\/(?:plan|todo)[\w.-]*\.md/g,
    fix: 'move the rationale into an ADR or the issue spec and cite that instead',
  },
  {
    name: 'a numbered decision from a planning document',
    pattern: /(?:^|[^\w])(?:design\s+)?decisions?\s+\d+/gi,
    fix: 'state the decision itself, or cite the ADR that records it',
  },
  {
    name: 'a planning-document version',
    pattern: /(?:^|[^\w])plan\s+v\d+/gi,
    fix: 'drop it — the plan is not part of the repository',
  },
  {
    name: 'a review-round or plan-section label',
    // `A3`, `B12`, `D10`, `T5`, `Fix 7`, `Fix C` as standalone words. `AC1`, `L1`,
    // `H2`, `P95` and hex-ish tokens do not match: the letter set is deliberately
    // narrow and the boundary requires a non-word character on both sides.
    // The `(?![:\d])` on the `T` form keeps ISO timestamps out — `2026-01-05T00:00:00Z`
    // contains a literal `T00`, and three real ones tripped this guard when written
    // without it.
    pattern:
      /(?:^|[^\w`/])(?:[ABD]\d{1,2}|T\d{1,2}(?![:\d])|Fix\s+(?:[A-Z]\b|\d{1,2}[a-z]?\b))(?=[^\w]|$)/g,
    fix: 'say what the change was, not which review round found it',
  },
  {
    name: 'a reference to a review conversation',
    pattern: /fix group|reconciliation item \d+/gi,
    fix: 'say what the fix was; the conversation is not readable from the repository',
  },
  {
    name: 'a lowercase review-round fix number (e.g. "fix 2")',
    // The capitalized `Fix\s+\d` form above only catches `Fix 7`; comments
    // have shipped citing the same kind of review-round label in lowercase
    // ("issue #37 fix 2"), which that pattern does not match. Case-insensitive
    // and scoped to a standalone `fix` (a non-word boundary on both sides, so
    // `prefix 2`/`suffix 2`/`postfix 2` do not match) followed directly by a
    // one-or-two-digit number.
    pattern: /(?:^|[^\w])fix\s+\d{1,2}[a-z]?\b/gi,
    fix: 'say what the fix was, not which numbered fix in a review round found it',
  },
  {
    name: 'a numbered task from a planning document',
    // `Task 5`, `task 12`: a pointer into the uncommitted working plan, not
    // anything a reader of this repository can open.
    pattern: /(?:^|[^\w])task\s+\d+/gi,
    fix: 'name the file or ADR that does the work instead of a task number',
  },
]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
    } else if (SCANNED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(full)
    }
  }
  return out
}

function scannedFiles(): string[] {
  return SCANNED_DIRS.flatMap((dir) => {
    const full = join(REPO_ROOT, dir)
    try {
      return statSync(full).isDirectory() ? walk(full) : []
    } catch {
      return []
    }
  })
}

interface Hit {
  file: string
  line: number
  text: string
  pattern: DeadPattern
}

function findDeadReferences(): Hit[] {
  const hits: Hit[] = []
  for (const file of scannedFiles()) {
    const relPath = relative(REPO_ROOT, file)
    if (relPath === SELF) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((text, index) => {
      for (const pattern of DEAD_PATTERNS) {
        pattern.pattern.lastIndex = 0
        if (pattern.pattern.test(text)) {
          hits.push({ file: relPath, line: index + 1, text: text.trim(), pattern })
        }
      }
    })
  }
  return hits
}

describe('dead references (AGENTS.md: cite only what a reader can open)', () => {
  it('finds real source files to scan', () => {
    // Without this, a broken path would make the guard below vacuously pass.
    expect(scannedFiles().length).toBeGreaterThan(100)
  })

  it('no comment, test name or string cites a planning document, decision number or review label', () => {
    const hits = findDeadReferences()
    const report = hits
      .map(
        (hit) =>
          `${hit.file}:${hit.line}\n  ${hit.text}\n  → ${hit.pattern.name}; ${hit.pattern.fix}`,
      )
      .join('\n\n')
    expect(report).toBe('')
  })
})
