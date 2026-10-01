import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

const RELEASE = 'https://github.com/github/github-mcp-server/releases/download/v1.12.2/'
const MAX_ARCHIVE_BYTES = 12 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 64 * 1024 * 1024

export interface ReviewedArtifact {
  archive: string
  archiveSha256: string
  executableSha256: string
  files: Record<string, { size: number; sha256: string }>
}

const LICENSE = {
  size: 1063,
  sha256: '9e48ecfa18e2b15169746a3c97beda4d1d6c6796097038498ca434ca7e0ccd44',
}
const README = {
  size: 113197,
  sha256: '0686b41067fd437abbde4b473c394fe2365e5ad2ae81c21b9f988735359c9666',
}

export const REVIEWED_GITHUB_MCP_ARTIFACTS: Record<string, ReviewedArtifact> = {
  'linux-x64': {
    archive: 'github-mcp-server_Linux_x86_64.tar.gz',
    archiveSha256: '95843162759da2c31dde082dd145be35db82164594796c294414b69790c2290e',
    executableSha256: 'b7a96bf79c68c0d4d0cdb5713e9ff36a1730b87ee3ae710e2e6189f398d7c1aa',
    files: {
      LICENSE,
      'README.md': README,
      'github-mcp-server': {
        size: 25493688,
        sha256: 'b7a96bf79c68c0d4d0cdb5713e9ff36a1730b87ee3ae710e2e6189f398d7c1aa',
      },
    },
  },
  'darwin-arm64': {
    archive: 'github-mcp-server_Darwin_arm64.tar.gz',
    archiveSha256: '7e6c5aec43f26b82d3580e77a4ee26872bcd34b48c9a08d0eaef48b5d0563904',
    executableSha256: '8d7686ec4c5f2a9614c75b329163abaaa915a1cc92423253df4ee7ba2df88de0',
    files: {
      LICENSE,
      'README.md': README,
      'github-mcp-server': {
        size: 24733314,
        sha256: '8d7686ec4c5f2a9614c75b329163abaaa915a1cc92423253df4ee7ba2df88de0',
      },
    },
  },
}

export function reviewedGithubMcpArtifact(
  platform = process.platform,
  arch = process.arch,
): ReviewedArtifact {
  const artifact = REVIEWED_GITHUB_MCP_ARTIFACTS[`${platform}-${arch}`]
  if (!artifact) throw new Error('This execution host has no reviewed GitHub MCP executable')
  return artifact
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function octal(bytes: Buffer): number {
  const value = bytes.toString('ascii').replace(/\0.*$/, '').trim()
  if (!/^[0-7]+$/.test(value)) throw new Error('Invalid GitHub MCP archive header')
  return Number.parseInt(value, 8)
}

/** Rejects extra files, links, altered headers, changed contents, and escaping paths before writing anything. */
export function verifyGithubMcpArchive(bytes: Buffer, artifact: ReviewedArtifact): Buffer {
  if (bytes.length > MAX_ARCHIVE_BYTES || sha256(bytes) !== artifact.archiveSha256)
    throw new Error('GitHub MCP release archive digest does not match the reviewed artifact')
  const tar = gunzipSync(bytes, { maxOutputLength: MAX_EXTRACTED_BYTES })
  const found = new Map<string, Buffer>()
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      if (tar.subarray(offset).some((byte) => byte !== 0))
        throw new Error('GitHub MCP archive has data after its end marker')
      break
    }
    const expectedHeaderSum = octal(header.subarray(148, 156))
    const actualHeaderSum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    )
    if (expectedHeaderSum !== actualHeaderSum)
      throw new Error('GitHub MCP archive header checksum is invalid')
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const size = octal(header.subarray(124, 136))
    const type = header[156]
    const reviewed = artifact.files[name]
    if (!reviewed || found.has(name) || (type !== 0 && type !== 48) || size !== reviewed.size)
      throw new Error('GitHub MCP archive inventory differs from the reviewed release')
    const start = offset + 512
    const end = start + size
    if (end > tar.length) throw new Error('GitHub MCP archive is truncated')
    const body = tar.subarray(start, end)
    if (sha256(body) !== reviewed.sha256)
      throw new Error('GitHub MCP archive contains a changed file')
    found.set(name, body)
    offset = start + Math.ceil(size / 512) * 512
  }
  if (found.size !== Object.keys(artifact.files).length)
    throw new Error('GitHub MCP archive is missing reviewed files')
  const executable = found.get('github-mcp-server')!
  if (sha256(executable) !== artifact.executableSha256)
    throw new Error('GitHub MCP executable digest does not match the reviewed release')
  return executable
}

/** Downloads only the pinned official release archive and installs its verified executable. */
export async function installReviewedGithubMcp(
  rootDir: string,
  options: {
    artifact?: ReviewedArtifact
    fetchFn?: typeof fetch
    signal?: AbortSignal
  } = {},
): Promise<string> {
  const artifact = options.artifact ?? reviewedGithubMcpArtifact()
  const dir = join(rootDir, 'reviewed-mcp', 'github-v1.12.2')
  const executablePath = join(dir, 'github-mcp-server')
  if (existsSync(executablePath)) {
    if (sha256(readFileSync(executablePath)) !== artifact.executableSha256)
      throw new Error('Installed GitHub MCP executable digest changed')
    return executablePath
  }
  const response = await (options.fetchFn ?? fetch)(`${RELEASE}${artifact.archive}`, {
    redirect: 'follow',
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (!response.ok || !response.body) throw new Error('Reviewed GitHub MCP archive is unavailable')
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_ARCHIVE_BYTES) {
      await response.body.cancel()
      throw new Error('GitHub MCP release archive exceeds the reviewed size bound')
    }
    chunks.push(buffer)
  }
  const executable = verifyGithubMcpArchive(Buffer.concat(chunks), artifact)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temp = join(dir, `.github-mcp-server-${randomUUID()}`)
  try {
    writeFileSync(temp, executable, { mode: 0o700, flag: 'wx' })
    renameSync(temp, executablePath)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
  return executablePath
}
