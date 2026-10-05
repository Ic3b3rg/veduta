import { createHash } from 'node:crypto'
import { canonicalJson } from '@veduta/protocol'
import { z } from 'zod'
import { PACKAGE_LIMITS, readPackageZip, safePackagePath } from './package-zip.ts'

const PART = '[a-z0-9][a-z0-9-]{0,63}'
const OWNER_SLUG = new RegExp(
  `^@?(${PART})/(${PART})(?:@([0-9]+\\.[0-9]+\\.[0-9]+(?:-[a-z0-9.-]+)?))?$`,
  'i',
)
const Version = z
  .string()
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/)
  .max(64)
const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const File = z.object({
  path: z.string().refine(safePackagePath),
  size: z.number().int().min(0).max(PACKAGE_LIMITS.fileBytes),
  sha256: Hash,
})
const Catalog = z.object({
  skill: z.object({
    slug: z.string(),
    displayName: z.string().max(200),
    updatedAt: z.number().optional(),
  }),
  owner: z.object({ handle: z.string(), userId: z.string().max(100).optional() }),
  latestVersion: z.object({ version: Version }).nullable(),
  moderation: z
    .object({ isMalwareBlocked: z.boolean().optional(), verdict: z.string().max(80).optional() })
    .nullable()
    .optional(),
})
const Security = z.object({
  status: z.string().max(80).optional(),
  hasWarnings: z.boolean().optional(),
  scanners: z
    .record(
      z.string().min(1).max(80),
      z.object({
        status: z.string().max(80).optional(),
        normalizedStatus: z.string().max(80).optional(),
      }),
    )
    .refine((scans) => Object.keys(scans).length <= 16)
    .optional(),
})
const Release = z.object({
  skill: z.object({ slug: z.string() }),
  version: z.object({
    version: Version,
    createdAt: z.number(),
    license: z.string().max(200).nullable().optional(),
    files: z
      .array(File)
      .min(1)
      .max(PACKAGE_LIMITS.files - 1),
    security: Security.nullable().optional(),
  }),
})

export interface ClawHubSource {
  owner: string
  slug: string
  version?: string
}
export interface CatalogInspectionOptions {
  fetchFn?: typeof fetch
  signal?: AbortSignal
  host?: string
}

export function parseClawHubSource(source: string): ClawHubSource {
  const identifier = OWNER_SLUG.exec(source.trim())
  if (identifier)
    return {
      owner: identifier[1]!.toLowerCase(),
      slug: identifier[2]!.toLowerCase(),
      ...(identifier[3] ? { version: Version.parse(identifier[3]) } : {}),
    }
  let url: URL
  try {
    url = new URL(source)
  } catch {
    throw new Error('Use an owner-qualified ClawHub Skill link or identifier')
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'clawhub.ai' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error('Invalid ClawHub Skill link')
  const match = new RegExp(`^/(${PART})/(?:skills/)?(${PART})/?$`, 'i').exec(url.pathname)
  if (
    !match ||
    [...url.searchParams.keys()].some((key) => key !== 'version') ||
    url.searchParams.getAll('version').length > 1
  )
    throw new Error('Invalid ClawHub Skill link')
  const version = url.searchParams.get('version')
  return {
    owner: match[1]!.toLowerCase(),
    slug: match[2]!.toLowerCase(),
    ...(version === null ? {} : { version: Version.parse(version) }),
  }
}

export function clawHubSourceInText(text: string): string | undefined {
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    let link = match[0]
    if (!/clawhub\./i.test(link)) continue
    const before = text[(match.index ?? 0) - 1]
    if (before === '(' && link.endsWith(')')) link = link.slice(0, -1)
    if (before === '[' && link.endsWith(']')) link = link.slice(0, -1)
    return link
  }
  const clean = (token: string) => token.replace(/^[([{`"']+|[)\]},.;!?`"']+$/g, '')
  const looksQualified = (token: string) =>
    /^@?[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*(?:@[^/\s]+)?$/i.test(token)
  const tokens = text.split(/\s+/).map(clean)
  const explicit = tokens.find((token) => token.startsWith('@') && looksQualified(token))
  if (explicit) return explicit
  const single = clean(text.trim())
  if (looksQualified(single)) return single
  const packageContext = /\b(?:clawhub|skill|compatibility)\b/i.test(text)
  if (
    !packageContext &&
    (!/\b(?:inspect|install)\b/i.test(text) || /\b(?:github|repository|repo)\b/i.test(text))
  )
    return undefined
  return tokens.find(looksQualified)
}

export function packageSha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function boundedRead(
  url: URL,
  options: CatalogInspectionOptions,
  limit: number,
): Promise<Buffer> {
  const deadline = AbortSignal.timeout(15_000)
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
  try {
    signal.throwIfAborted()
    const response = await (options.fetchFn ?? fetch)(url, {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      signal,
    })
    if (!response.ok || response.status >= 300 || !response.body)
      throw new Error('Catalog endpoint unavailable')
    const length = response.headers.get('content-length')
    if (length && (!/^\d+$/.test(length) || Number(length) > limit)) {
      await response.body.cancel()
      throw new Error('Catalog response exceeds inspection limits')
    }
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    try {
      while (true) {
        signal.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        total += value.length
        if (total > limit) throw new Error('Catalog response exceeds inspection limits')
        chunks.push(Buffer.from(value))
      }
      return Buffer.concat(chunks)
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  } catch (error) {
    if (options.signal?.aborted) throw new Error('Package inspection cancelled')
    if (error instanceof Error && error.message.includes('inspection limits')) throw error
    throw new Error('Catalog endpoint unavailable; no package or dependency was installed')
  }
}

export async function inspectCatalogArtifact(
  source: ClawHubSource,
  options: CatalogInspectionOptions,
) {
  const url = (path: string) => {
    const target = new URL(path, 'https://clawhub.ai')
    target.searchParams.set('ownerHandle', source.owner)
    return target
  }
  const catalogUrl = url(`/api/v1/skills/${source.slug}`)
  const readCatalog = async () => {
    const raw: unknown = JSON.parse(
      (await boundedRead(catalogUrl, options, 512 * 1024)).toString('utf8'),
    )
    return { value: Catalog.parse(raw), metadata: canonicalJson(raw) }
  }
  const catalogSnapshot = await readCatalog()
  const catalog = catalogSnapshot.value
  if (catalog.owner.handle.toLowerCase() !== source.owner || catalog.skill.slug !== source.slug)
    throw new Error('Catalog publisher or package identity changed')
  const version = source.version ?? catalog.latestVersion?.version
  if (!version) throw new Error('Package has no exact published version')
  const releaseUrl = url(`/api/v1/skills/${source.slug}/versions/${version}`)
  const readRelease = async () => {
    const raw: unknown = JSON.parse(
      (await boundedRead(releaseUrl, options, 512 * 1024)).toString('utf8'),
    )
    return { value: Release.parse(raw), metadata: canonicalJson(raw) }
  }
  const releaseSnapshot = await readRelease()
  const release = releaseSnapshot.value
  if (release.skill.slug !== source.slug || release.version.version !== version)
    throw new Error('Catalog version identity changed')
  const downloadUrl = url('/api/v1/download')
  downloadUrl.searchParams.set('slug', source.slug)
  downloadUrl.searchParams.set('version', version)
  const archive = await boundedRead(downloadUrl, options, PACKAGE_LIMITS.archiveBytes)
  const files = readPackageZip(archive)
  const paths = new Set<string>()
  for (const file of release.version.files) {
    const body = files.get(file.path)
    if (
      !body ||
      paths.has(file.path) ||
      body.length !== file.size ||
      packageSha256(body) !== file.sha256
    )
      throw new Error('Package files changed from the versioned catalog inventory')
    paths.add(file.path)
  }
  const meta = files.get('_meta.json')
  if (meta && !paths.has('_meta.json')) {
    z.object({
      slug: z.literal(source.slug),
      version: z.literal(version),
      ownerId: z.string().max(100),
      publishedAt: z.literal(release.version.createdAt),
    })
      .strict()
      .parse(JSON.parse(meta.toString('utf8')))
    paths.add('_meta.json')
  }
  if (paths.size !== files.size || !files.has('SKILL.md'))
    throw new Error('Package archive contains unlisted or missing files')
  const [currentCatalog, currentRelease] = await Promise.all([readCatalog(), readRelease()])
  if (
    currentCatalog.metadata !== catalogSnapshot.metadata ||
    currentRelease.metadata !== releaseSnapshot.metadata
  )
    throw new Error('Catalog metadata changed during inspection; retry the exact version')
  return {
    source,
    version,
    catalog,
    release: release.version,
    files,
    archiveSha256: packageSha256(archive),
    downloadUrl: downloadUrl.href,
  }
}

export type InspectedCatalogArtifact = Awaited<ReturnType<typeof inspectCatalogArtifact>>
