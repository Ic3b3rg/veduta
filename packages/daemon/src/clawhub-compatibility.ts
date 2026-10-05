import { canonicalJson } from '@veduta/protocol'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import { packageSha256, type InspectedCatalogArtifact } from './clawhub-catalog.ts'

const Frontmatter = z.object({
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(1024),
  license: z.string().max(200).optional(),
  compatibility: z.string().max(500).optional(),
  homepage: z.string().max(500).optional(),
  metadata: z.record(z.unknown()).optional(),
  'allowed-tools': z.string().max(1000).optional(),
})
const HostMetadata = z.object({
  requires: z
    .object({
      bins: z.array(z.string().max(100)).max(32).optional(),
      env: z.array(z.string().max(100)).max(32).optional(),
      config: z.array(z.string().max(100)).max(32).optional(),
    })
    .optional(),
  os: z.array(z.string().max(100)).max(16).optional(),
  install: z
    .array(
      z.object({
        kind: z.string().max(80),
        formula: z.string().max(500).optional(),
        package: z.string().max(500).optional(),
        url: z.string().max(500).optional(),
        bins: z.array(z.string().max(100)).max(32).optional(),
      }),
    )
    .max(32)
    .optional(),
})

export interface ClawHubCompatibilityReport {
  publisher: string
  source: string
  version: string
  archiveSha256: string
  inventorySha256: string
  files: { path: string; bytes: number; sha256: string }[]
  status: 'adaptation_required' | 'unsupported' | 'unsafe'
  formatCompatible: boolean
  installationAllowed: false
  license: string
  executionHost: string
  provenanceGaps: string[]
  scans: string[]
  scanLimit: string
  requirements: string[]
  dependencies: string[]
  dataAccess: string[]
  permissions: string[]
  reasons: string[]
}

/** Package procedures are inspected as data and are never loaded as Agent instructions. */
export function classifyClawHubArtifact(
  artifact: InspectedCatalogArtifact,
  host: string,
): ClawHubCompatibilityReport {
  const files = [...artifact.files]
    .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: packageSha256(bytes) }))
    .sort((a, b) => a.path.localeCompare(b.path))
  const report: ClawHubCompatibilityReport = {
    publisher: artifact.source.owner,
    source: artifact.downloadUrl,
    version: artifact.version,
    archiveSha256: artifact.archiveSha256,
    inventorySha256: packageSha256(Buffer.from(canonicalJson(files))),
    files,
    status: 'adaptation_required',
    formatCompatible: false,
    installationAllowed: false,
    license: artifact.release.license ?? 'Not declared in version metadata',
    executionHost: `Gateway host (${host}); nothing was executed`,
    provenanceGaps: [
      'Registry ownership is catalog evidence, not a signed source or maintainer attestation.',
      'Executable dependencies have no reviewed source, version, contents or permission proof in this inspection.',
    ],
    scans: [],
    scanLimit:
      'Registry scan signals are not proof of safety, complete behavior, or Veduta compatibility. No local malware scan or live behavior verification was performed.',
    requirements: [],
    dependencies: [],
    dataAccess: [],
    permissions: [],
    reasons: [
      'Complete advertised behavior, exact dependencies, approved scope, restart and failure recovery still need Veduta runtime proof. Inspection cannot mark an artifact Verified.',
    ],
  }
  if (artifact.files.has('_meta.json'))
    report.provenanceGaps.push(
      'The generated _meta.json is hashed but not part of the version file manifest; its historical ownerId is not an attestation of the current publisher.',
    )
  const security = artifact.release.security
  report.scans.push(
    `Catalog version scan: ${security?.status ?? 'unavailable'}; warnings: ${security?.hasWarnings === undefined ? 'unknown' : String(security.hasWarnings)}`,
  )
  for (const [name, scanner] of Object.entries(security?.scanners ?? {}))
    report.scans.push(`${name}: ${scanner.normalizedStatus ?? scanner.status ?? 'unknown'}`)
  if (
    artifact.catalog.moderation?.isMalwareBlocked ||
    artifact.catalog.moderation?.verdict === 'malicious' ||
    security?.status === 'malicious' ||
    Object.values(security?.scanners ?? {}).some(
      (scan) => scan.status === 'malicious' || scan.normalizedStatus === 'malicious',
    )
  ) {
    report.status = 'unsafe'
    report.reasons.push(
      'The catalog reports a malicious or blocked artifact; activation is refused.',
    )
  }
  let skill: string
  try {
    skill = new TextDecoder('utf-8', { fatal: true }).decode(artifact.files.get('SKILL.md')!)
  } catch {
    report.status = 'unsafe'
    report.reasons.push('SKILL.md is not valid UTF-8 text.')
    return report
  }
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill)
  try {
    if (!front) throw new Error('Missing frontmatter')
    const document = parseDocument(front[1]!, { uniqueKeys: true })
    if (document.errors.length) throw new Error('Invalid YAML')
    const parsed = Frontmatter.parse(document.toJS({ maxAliasCount: 20 }))
    report.formatCompatible = parsed.name === artifact.source.slug
    if (!report.formatCompatible) throw new Error('Skill name differs from package identity')
    if (parsed.license) report.license = parsed.license
    if (parsed.homepage)
      report.provenanceGaps.push(
        `Declared homepage (unverified, never contacted): ${parsed.homepage}`,
      )
    if (parsed.compatibility)
      report.requirements.push(`Declared compatibility: ${parsed.compatibility}`)
    if (parsed['allowed-tools'])
      report.requirements.push(`Declared tools: ${parsed['allowed-tools']}`)
    for (const key of ['openclaw', 'clawdbot', 'clawdis']) {
      const raw = parsed.metadata?.[key]
      if (raw === undefined) continue
      const metadata = HostMetadata.parse(raw)
      for (const bin of metadata.requires?.bins ?? [])
        report.requirements.push(`Required CLI: ${bin}`)
      for (const env of metadata.requires?.env ?? [])
        report.permissions.push(`Required secret/environment slot: ${env}; no value was requested`)
      for (const config of metadata.requires?.config ?? [])
        report.requirements.push(`Required foreign host configuration: ${config}`)
      for (const os of metadata.os ?? [])
        report.requirements.push(`Declared execution platform: ${os}`)
      for (const install of metadata.install ?? [])
        report.dependencies.push(
          `${install.kind}: ${install.formula ?? install.package ?? install.url ?? 'source not declared'}; version/digest/maintainer contents not pinned by this recipe`,
        )
    }
  } catch {
    if (report.status !== 'unsafe') report.status = 'unsupported'
    report.reasons.push(
      'Missing, malformed, conflicting or unsupported Skill metadata prevents complete format/requirement validation.',
    )
  }
  const executableFiles = files.filter((file) =>
    /\.(?:js|ts|py|sh|wasm|so|dylib|exe)$/.test(file.path),
  )
  for (const file of executableFiles)
    report.dependencies.push(
      `Executable support file: ${file.path}; bytes/hash in inventory; not run or approved`,
    )
  if (files.some((file) => file.path.startsWith('hooks/'))) {
    report.requirements.push('Foreign lifecycle hooks; the original host ABI is not a Veduta API')
    if (report.status !== 'unsafe') report.status = 'unsupported'
    report.reasons.push(
      'Foreign hook code cannot be loaded by the Veduta-native process contract; a separately identified, reviewed port is required.',
    )
  }
  const sourceText = [...artifact.files]
    .filter(([path]) => /\.(?:md|js|ts|py|sh)$/.test(path))
    .map(([, body]) => body.toString('utf8'))
    .join('\n')
  if (files.some((file) => /\.[cm]?[jt]s$/.test(file.path)))
    report.requirements.push('JavaScript/TypeScript support files require a reviewed Node runtime')
  if (
    [...artifact.files.values()].some((body) =>
      /^#!\/bin\/bash(?:\r?\n|$)/.test(body.toString('utf8')),
    )
  )
    report.requirements.push(
      'Shipped script declares /bin/bash; a reviewed Bash runtime is required',
    )
  const sessionTools = [
    'sessions_list',
    'sessions_history',
    'sessions_send',
    'sessions_spawn',
  ].filter((tool) => new RegExp(`\\b${tool}\\b`).test(sourceText))
  for (const tool of sessionTools)
    report.requirements.push(`Declared foreign session tool: ${tool}; unavailable in Veduta`)
  if (sessionTools.length) {
    report.dataAccess.push(
      'Foreign active/recent session records and cross-session transcript access',
    )
    report.permissions.push('Cross-session reads, messages and sub-agent creation are not granted')
    if (report.status !== 'unsafe') report.status = 'unsupported'
    report.reasons.push(
      'Foreign cross-session APIs and sub-agent creation do not match Veduta’s single Agent contract.',
    )
  }
  if (/agent:bootstrap/.test(sourceText)) report.requirements.push('OpenClaw agent:bootstrap hook')
  if (/command:new|command:reset/.test(sourceText))
    report.requirements.push('OpenClaw command:new/reset hooks')
  if (/transcript/.test(sourceText) && files.some((file) => file.path.startsWith('hooks/'))) {
    report.dataAccess.push('Ended-session transcript files assumed by the foreign host')
    report.reasons.push('Veduta does not expose raw session transcript paths to extension hooks.')
  }
  if (/SOUL\.md|AGENTS\.md|\.learnings/.test(sourceText)) {
    report.dataAccess.push('Learning files and host character/instruction documents')
    report.permissions.push(
      'Persistent learning-file writes; promotion must use a reviewed Character-change Pending decision',
    )
  }
  if (/\bobsidian-cli\b/.test(sourceText)) {
    report.requirements.push(
      'Obsidian vault registry on the Gateway; Obsidian desktop URI handler for --open',
    )
    report.dataAccess.push(
      'Selected Markdown vault and ~/Library/Application Support/obsidian/obsidian.json',
    )
    report.permissions.push(
      'Read/search and create/edit the selected vault; moving and deleting notes need separate approved scopes',
    )
    report.reasons.push(
      'The published obsidian-cli/Homebrew recipe predates the maintained notesmd-cli rename. A dependency substitution needs its own exact pin and complete advertised behavior proof.',
    )
    report.reasons.push(
      'A Mac-local vault is unavailable on a VPS unless the user supplies an explicitly reachable mounted or synchronized path; the browser does not grant Gateway filesystem access.',
    )
  }
  if (report.requirements.length === 0)
    report.requirements.push(
      'No machine-readable host/tool requirements declared; prose and complete behavior still require human review',
    )
  if (report.dependencies.length === 0)
    report.dependencies.push(
      'No executable dependency declared; this is not proof that all prose requirements were inventoried',
    )
  if (report.dataAccess.length === 0)
    report.dataAccess.push(
      'Not fully declared; human review must inventory every advertised data path and network destination',
    )
  if (report.permissions.length === 0)
    report.permissions.push(
      'No access is granted. Exact tools, data paths, hosts and secret slots require separate review before setup.',
    )
  return report
}

function reportText(value: string): string {
  return Array.from(value, (char) =>
    char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char,
  ).join('')
}

export function renderClawHubReport(report: ClawHubCompatibilityReport): string {
  const list = (title: string, values: string[]) =>
    `${title}\n\n${values.map((value) => `- ${reportText(value)}`).join('\n')}`
  return [
    'ClawHub compatibility report',
    `Publisher: ${reportText(report.publisher)}. Version: ${reportText(report.version)}.`,
    `Status: ${report.status === 'adaptation_required' ? 'Adaptation required' : report.status === 'unsupported' ? 'Unsupported' : 'Unsafe'}. Format compatible: ${report.formatCompatible ? 'yes' : 'unconfirmed'}. Complete behavior: unverified.`,
    `Source: ${reportText(report.source)}`,
    `Archive SHA-256: ${report.archiveSha256}\n\nInventory SHA-256: ${report.inventorySha256}`,
    `Execution host: ${reportText(report.executionHost)}. License: ${reportText(report.license)}.`,
    list('Reasons and next steps', report.reasons),
    list('Source and provenance gaps', report.provenanceGaps),
    list('Catalog scans', report.scans),
    report.scanLimit,
    list('Declared dependencies and setup sources', report.dependencies),
    list('Required host hooks and tools', report.requirements),
    list('Data access', report.dataAccess),
    list('Requested permissions', report.permissions),
    list(
      'File inventory — path; bytes; SHA-256',
      report.files.map((file) => `${file.path}; ${file.bytes}; ${file.sha256}`),
    ),
    'Inspection only. No package or dependency was installed, no package instructions were loaded, and no permission was granted.',
  ].join('\n\n')
}
