import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import { defineTool, type ToolDef } from './agent-runner.ts'

const FIRST_PARTY_ROOT = fileURLToPath(new URL('../skills/', import.meta.url))
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const TOP_LEVEL_FIELDS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
])
const SkillFrontmatterSchema = z
  .object({
    name: z.string().regex(NAME_RE).max(64),
    description: z.string().min(1).max(1024),
    license: z.string().optional(),
    compatibility: z.string().optional(),
    'allowed-tools': z.string().optional(),
    metadata: z.record(z.string()).optional(),
  })
  .strict()

export interface FirstPartySkill {
  id: string
  description: string
  version: string
  hash: string
  requiredTools: string[]
  intent: string
  provider: string | undefined
  markdown: string
  references: ReadonlyMap<string, string>
}

function linkedReferences(markdown: string): string[] {
  return [...markdown.matchAll(/\]\(([^)]+)\)/g)]
    .map((match) => match[1]!)
    .filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#'))
    .map((target) => target.split('#')[0]!)
}

export function loadFirstPartySkill(packageDir: string): FirstPartySkill {
  const id = packageDir.split(sep).at(-1)!
  if (!NAME_RE.test(id)) throw new Error(`Invalid Skill directory: ${id}`)
  const entries = readdirSync(packageDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'SKILL.md' && entry.isFile()) continue
    if (entry.name === 'references' && entry.isDirectory()) continue
    throw new Error(`Unsupported Skill package file: ${id}/${entry.name}`)
  }
  const source = readFileSync(join(packageDir, 'SKILL.md'), 'utf8')
  const lines = source.split('\n')
  if (lines.length > 500) throw new Error(`Skill ${id} exceeds 500 lines`)
  if (Math.ceil(source.length / 4) > 5000) throw new Error(`Skill ${id} exceeds 5,000 tokens`)
  if (lines[0] !== '---') throw new Error(`Skill ${id} lacks frontmatter`)
  const end = lines.indexOf('---', 1)
  if (end < 2) throw new Error(`Skill ${id} has invalid frontmatter`)
  const doc = parseDocument(lines.slice(1, end).join('\n'), { uniqueKeys: true })
  if (doc.errors.length > 0) throw new Error(`Skill ${id} has invalid YAML frontmatter`)
  const raw = doc.toJS() as unknown
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Error(`Skill ${id} has invalid frontmatter`)
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_FIELDS.has(key)) throw new Error(`Skill ${id} has unsupported field ${key}`)
  }
  const front = SkillFrontmatterSchema.parse(raw)
  if (front.name !== id) throw new Error(`Skill ${id} has mismatched name`)
  for (const key of Object.keys(front.metadata ?? {})) {
    if (!key.startsWith('veduta.')) throw new Error(`Skill ${id} has unsupported metadata ${key}`)
  }
  const references = new Map<string, string>()
  const referenceDir = join(packageDir, 'references')
  if (existsSync(referenceDir)) {
    for (const entry of readdirSync(referenceDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md'))
        throw new Error(`Unsupported Skill reference: ${id}/${entry.name}`)
      const path = join(referenceDir, entry.name)
      if (!realpathSync(path).startsWith(`${realpathSync(referenceDir)}${sep}`))
        throw new Error(`Skill reference escapes package: ${id}/${entry.name}`)
      references.set(`references/${entry.name}`, readFileSync(path, 'utf8'))
    }
  }
  const markdown = lines.slice(end + 1).join('\n')
  for (const target of linkedReferences(markdown)) {
    if (!references.has(target)) throw new Error(`Skill ${id} has broken reference ${target}`)
  }
  for (const [path, content] of references) {
    for (const target of linkedReferences(content)) {
      const resolved = resolve(packageDir, 'references', target)
      if (!resolved.startsWith(`${resolve(packageDir)}${sep}`) || !statSync(resolved).isFile())
        throw new Error(`Skill ${id} has broken reference ${path}: ${target}`)
    }
  }
  const requiredTools = (front.metadata?.['veduta.tools'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const version = front.metadata?.['veduta.version'] ?? '1'
  const intent = front.metadata?.['veduta.intent'] ?? ''
  return {
    id,
    description: front.description,
    version,
    hash: createHash('sha256').update(source).digest('hex'),
    requiredTools,
    intent,
    provider: front.metadata?.['veduta.provider'],
    markdown: source,
    references,
  }
}

export class FirstPartySkills {
  readonly skills: FirstPartySkill[]

  constructor(
    root = FIRST_PARTY_ROOT,
    private readonly providerForRequest?: (text: string) => string | undefined,
  ) {
    this.skills = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => loadFirstPartySkill(join(root, entry.name)))
  }

  applicable(text: string, toolNames: readonly string[]): FirstPartySkill[] {
    const available = new Set(toolNames)
    const provider = /\b(himalaya|imap|smtp)\b/i.test(text)
      ? 'himalaya'
      : /\bgmail\b/i.test(text)
        ? 'gmail'
        : this.providerForRequest?.(text)
    return this.skills.filter(
      (skill) =>
        skill.requiredTools.every((tool) => available.has(tool)) &&
        (skill.provider === undefined || skill.provider === provider) &&
        (skill.intent === '' || new RegExp(skill.intent, 'i').test(text)),
    )
  }

  metadata(text: string, toolNames: readonly string[]): string {
    const skills = this.applicable(text, toolNames)
    if (skills.length === 0) return ''
    return [
      '# Applicable first-party Skills',
      'Load relevant procedures with load_skill before using their tools. A Skill grants no capability.',
      ...skills.map(
        (skill) =>
          `- ${skill.id} v${skill.version} (${skill.hash.slice(0, 12)}): ${skill.description}`,
      ),
    ].join('\n')
  }

  tools(toolNames: readonly string[]): ToolDef[] {
    const loaded = new Set<string>()
    const referenced = new Set<string>()
    return [
      defineTool({
        name: 'load_skill',
        description: 'Load a relevant reviewed first-party Skill procedure by id.',
        schema: z.object({ skillId: z.string() }).strict(),
        level: 'L0',
        egressDomains: [],
        handler: ({ skillId }, context) => {
          const skill = this.applicable(context.currentUserRequest?.text ?? '', toolNames).find(
            (candidate) => candidate.id === skillId,
          )
          if (!skill) return { content: 'Skill is not applicable to this turn.' }
          loaded.add(skillId)
          return {
            content: skill.markdown,
            details: { skillId, version: skill.version, hash: skill.hash, compatible: true },
          }
        },
      }),
      defineTool({
        name: 'read_skill_reference',
        description: 'Load one explicitly linked Markdown reference for a loaded Skill.',
        schema: z.object({ skillId: z.string(), reference: z.string() }).strict(),
        level: 'L0',
        egressDomains: [],
        handler: ({ skillId, reference }) => {
          const skill = this.skills.find((candidate) => candidate.id === skillId)
          if (!skill || !loaded.has(skillId)) return { content: 'Load the Skill first.' }
          if (referenced.has(skillId)) return { content: 'One reference per Skill per turn.' }
          const content = skill.references.get(reference)
          if (!content || !linkedReferences(skill.markdown).includes(reference))
            return { content: 'Reference is not declared by the Skill.' }
          referenced.add(skillId)
          return { content, details: { skillId, reference, hash: skill.hash } }
        },
      }),
    ]
  }
}
