import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the ADR-0004 boundary and AGENTS.md's hard rule: "Never import
 * `pi-agent-core` outside the AgentRunner wrapper (ADR-0004). The daemon and
 * workers talk only to our own interfaces (`AgentRunner`, `ModelRef`,
 * `ToolDef`, `SessionStore`)." The same containment applies to
 * `@earendil-works/pi-ai`, the package pi-agent-core itself wraps and
 * re-exports pieces of (`streamSimple`/`compat`).
 *
 * `pi-agent-runner.ts` is the sole wrapper: everything else in the daemon —
 * routes, the trust layer, the scheduler, other runners — must depend only on
 * `AgentRunner`/`ModelRef`/`ToolDef`/`SessionStore` from `agent-runner.ts`.
 * `pi-provider-bridge.ts` (issue #37) is the model-routing counterpart and
 * gets the same allowance ahead of its own arrival. Each wrapper's test file
 * may import pi's *types* (to build fixtures against its real message shape,
 * see `pi-agent-runner.test.ts`'s `AgentMessage` import) but never its
 * runtime — constructing a live `Agent` needs a working provider, which is
 * exactly what these tests avoid.
 *
 * Scans source text for `import`/`import type` statements rather than
 * parsing, in the same spirit as `dead-references.test.ts`: dependency-light,
 * no TypeScript compiler API needed for a boundary this narrow.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')
const DAEMON_SRC = join(REPO_ROOT, 'packages', 'daemon', 'src')

const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git'])

/** This file explains the boundary, so it necessarily names the packages it guards. */
const SELF = 'import-boundary.test.ts'

const GUARDED_PACKAGE_RE = /^@earendil-works\/(pi-agent-core|pi-ai)(\/.*)?$/

/** Files allowed to import the guarded packages with no restriction. */
const UNRESTRICTED_FILES = new Set(['pi-agent-runner.ts', 'pi-provider-bridge.ts'])

/** Files allowed to import the guarded packages, but only `import type`. */
const TYPE_ONLY_FILES = new Set(['pi-agent-runner.test.ts', 'pi-provider-bridge.test.ts'])

export interface ImportStatement {
  line: number
  isTypeOnly: boolean
  source: string
}

/** `import 'pkg'`/`import "pkg"`: a side-effect import, never a `from` clause. */
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s+['"]([^'"]+)['"]/

/**
 * A re-export form (`export * from '...'`, `export * as ns from '...'`,
 * `export { a, b } from '...'`, `export type { a } from '...'`) as opposed to
 * a plain declaration (`export const`/`function`/`class`/`interface`/`type
 * Foo =`/`enum`/`default`) that happens to start with `export` but never
 * carries a `from` clause at all. Only lines matching this may feed the
 * multi-line `from`-clause scan below — otherwise a declaration with no
 * `from` clause on this line would make that scan walk forward hunting for
 * the next `from '...'` anywhere later in the file and wrongly attach it.
 */
const REEXPORT_START_RE = /^\s*export\s+(type\s+)?(\*|\{)/

/** `import(...)`/`require(...)` calls: an expression, not a whole-line declaration, so it can appear anywhere in a line. Neither has a type-only form. */
const DYNAMIC_IMPORT_RE = /\bimport\(\s*['"]([^'"]+)['"]/g
const REQUIRE_CALL_RE = /\brequire\(\s*['"]([^'"]+)['"]/g

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      out.push(full)
    }
  }
  return out
}

function scannedFiles(): string[] {
  try {
    return statSync(DAEMON_SRC).isDirectory() ? walk(DAEMON_SRC) : []
  } catch {
    return []
  }
}

/**
 * Extracts every module-importing statement's source: `import ... from`,
 * `export ... from` (re-exports), side-effect `import '...'`, dynamic
 * `import('...')`, and `require('...')` — tolerating `from`-bearing
 * statements that span multiple lines (several files in this package import
 * a long list of named bindings from `agent-runner.ts` or `pi-agent-core`
 * across many lines). Exported so this file's own test block can pin each
 * form directly against a crafted string, independent of what happens to be
 * on disk.
 */
export function extractImports(text: string): ImportStatement[] {
  const lines = text.split('\n')
  const imports: ImportStatement[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line === undefined) {
      index += 1
      continue
    }

    const sideEffect = SIDE_EFFECT_IMPORT_RE.exec(line)
    if (sideEffect?.[1] !== undefined) {
      imports.push({ line: index + 1, isTypeOnly: false, source: sideEffect[1] })
      index += 1
      continue
    }

    if (/^\s*import\s/.test(line) || REEXPORT_START_RE.test(line)) {
      const startLine = index
      let buffer = line
      let cursor = index
      let match = /from\s+['"]([^'"]+)['"]/.exec(buffer)
      while (!match && cursor < lines.length - 1) {
        cursor += 1
        buffer += `\n${lines[cursor]}`
        match = /from\s+['"]([^'"]+)['"]/.exec(buffer)
      }
      if (match?.[1] !== undefined) {
        imports.push({
          line: startLine + 1,
          isTypeOnly: /^\s*(import|export)\s+type\s/.test(buffer),
          source: match[1],
        })
        index = cursor + 1
        continue
      }
      // No `from` clause ever turned up (an `export const`/`function`/...
      // declaration that only looked like a re-export, or a genuinely
      // malformed import): fall through and advance one line, same as any
      // other non-matching line.
    }

    index += 1
  }

  // Dynamic `import('pkg')` and `require('pkg')` are expressions, not
  // whole-line declarations, so they are matched per line rather than
  // folded into the statement scan above.
  lines.forEach((lineText, lineIndex) => {
    for (const re of [DYNAMIC_IMPORT_RE, REQUIRE_CALL_RE]) {
      re.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = re.exec(lineText))) {
        if (match[1] !== undefined) {
          imports.push({ line: lineIndex + 1, isTypeOnly: false, source: match[1] })
        }
      }
    }
  })

  return imports
}

interface Violation {
  file: string
  line: number
  source: string
  reason: string
}

function findViolations(): Violation[] {
  const violations: Violation[] = []
  for (const file of scannedFiles()) {
    const relPath = relative(REPO_ROOT, file)
    if (basename(file) === SELF) continue
    const name = basename(file)
    const guardedImports = extractImports(readFileSync(file, 'utf8')).filter((statement) =>
      GUARDED_PACKAGE_RE.test(statement.source),
    )
    if (guardedImports.length === 0) continue
    if (UNRESTRICTED_FILES.has(name)) continue
    for (const statement of guardedImports) {
      if (TYPE_ONLY_FILES.has(name) && statement.isTypeOnly) continue
      const reason = TYPE_ONLY_FILES.has(name)
        ? 'only a type-only `import type` of a guarded package is allowed here'
        : 'only pi-agent-runner.ts / pi-provider-bridge.ts may import this package (ADR-0004)'
      violations.push({ file: relPath, line: statement.line, source: statement.source, reason })
    }
  }
  return violations
}

describe('import boundary (ADR-0004: pi-agent-core stays behind the AgentRunner wrapper)', () => {
  it('finds real source files to scan', () => {
    // Without this, a broken path would make the guard below vacuously pass.
    expect(scannedFiles().length).toBeGreaterThan(20)
  })

  it('imports @earendil-works/pi-agent-core or pi-ai only where the wrapper permits', () => {
    const violations = findViolations()
    const report = violations
      .map(
        (violation) =>
          `${violation.file}:${violation.line} imports "${violation.source}" — ${violation.reason}`,
      )
      .join('\n')
    expect(report).toBe('')
  })

  describe('extractImports (the scanner findViolations relies on)', () => {
    it('matches a plain named import with a from clause', () => {
      const hits = extractImports(`import { foo } from '@earendil-works/pi-ai'\n`)
      expect(hits).toEqual([{ line: 1, isTypeOnly: false, source: '@earendil-works/pi-ai' }])
    })

    it('matches a type-only import', () => {
      const hits = extractImports(`import type { Foo } from '@earendil-works/pi-ai'\n`)
      expect(hits).toEqual([{ line: 1, isTypeOnly: true, source: '@earendil-works/pi-ai' }])
    })

    it('matches a side-effect import with no from clause', () => {
      const hits = extractImports(`import '@earendil-works/pi-ai'\n`)
      expect(hits).toEqual([{ line: 1, isTypeOnly: false, source: '@earendil-works/pi-ai' }])
    })

    it('matches a dynamic import(...) call', () => {
      const hits = extractImports(`const mod = await import('@earendil-works/pi-ai')\n`)
      expect(hits).toEqual([{ line: 1, isTypeOnly: false, source: '@earendil-works/pi-ai' }])
    })

    it('matches a require(...) call', () => {
      const hits = extractImports(`const mod = require('@earendil-works/pi-ai')\n`)
      expect(hits).toEqual([{ line: 1, isTypeOnly: false, source: '@earendil-works/pi-ai' }])
    })

    it('matches a re-export (export ... from) as non-type-only', () => {
      const hits = extractImports(`export { streamSimple } from '@earendil-works/pi-ai'\n`)
      expect(hits).toEqual([{ line: 1, isTypeOnly: false, source: '@earendil-works/pi-ai' }])
    })

    it('matches a `export * from` re-export', () => {
      const hits = extractImports(`export * from '@earendil-works/pi-ai'\n`)
      expect(hits).toEqual([{ line: 1, isTypeOnly: false, source: '@earendil-works/pi-ai' }])
    })

    it('matches a type-only re-export (export type ... from)', () => {
      const hits = extractImports(`export type { AssistantMessage } from '@earendil-works/pi-ai'\n`)
      expect(hits).toEqual([{ line: 1, isTypeOnly: true, source: '@earendil-works/pi-ai' }])
    })

    it('does not mistake a plain export declaration for a re-export (no from clause to attach)', () => {
      const hits = extractImports(
        [
          'export const PROVIDER_HOSTS = {',
          '  anthropic: "api.anthropic.com",',
          '}',
          "import { z } from '@earendil-works/pi-ai'",
        ].join('\n'),
      )
      expect(hits).toEqual([{ line: 4, isTypeOnly: false, source: '@earendil-works/pi-ai' }])
    })

    it('tolerates a named-import list spanning multiple lines', () => {
      const hits = extractImports(
        ['import {', '  streamSimple,', "} from '@earendil-works/pi-ai'"].join('\n'),
      )
      expect(hits).toEqual([{ line: 1, isTypeOnly: false, source: '@earendil-works/pi-ai' }])
    })
  })
})
