import { createHash } from 'node:crypto'
import { z } from 'zod'
import { readGithubJson } from './github-api-read.ts'
import type { GithubMcpFile } from './mcp-stdio-client.ts'
import { ServiceConnectionError } from './service-connections.ts'

const Sha = z.string().regex(/^[a-f0-9]{40}$/)
const Tree = z.object({
  sha: Sha,
  truncated: z.boolean(),
  tree: z
    .array(
      z.object({
        path: z
          .string()
          .min(1)
          .max(1024)
          .refine((path) => !path.includes('/') && githubPath(path) === path),
        sha: Sha,
        mode: z.string(),
        type: z.enum(['tree', 'blob', 'commit']),
        size: z.number().int().nonnegative().optional(),
      }),
    )
    .max(2000),
})
export interface GithubRevision {
  commit: string
  tree: string
}
export function githubPath(path: string): string {
  const normalized = path.replace(/^\//, '').replace(/\/$/, '')
  if (
    normalized.length > 1024 ||
    [...normalized].some((character) => character.charCodeAt(0) < 32 || character === '\\') ||
    (normalized && normalized.split('/').some((part) => !part || part === '.' || part === '..')) ||
    normalized.split('/').length > 12
  )
    throw new ServiceConnectionError(
      400,
      'Choose a repository-relative path with at most 12 components',
    )
  return normalized
}

/** Metadata pins the exact commit and path before the reviewed MCP server may fetch a body. */
export async function readGithubPath(options: {
  token: string
  owner: string
  repo: string
  path: string
  ref?: string
  revision?: GithubRevision
  fetchFn: typeof fetch
  signal: AbortSignal
  readFile: (path: string, commit: string) => Promise<GithubMcpFile>
}) {
  const path = githubPath(options.path)
  const prefix = `/repos/${options.owner}/${options.repo}`
  const get = (suffix: string) =>
    readGithubJson(options.token, prefix + suffix, options.fetchFn, options.signal)
  let revision = options.revision
  if (!revision) {
    const commit = Sha.parse(
      (
        await readGithubJson(
          options.token,
          `${prefix}/commits/${encodeURIComponent(options.ref ?? 'HEAD')}`,
          options.fetchFn,
          options.signal,
          'commit-sha',
        )
      ).data,
    )
    const metadata = z
      .object({ sha: Sha, tree: z.object({ sha: Sha }) })
      .parse((await get(`/git/commits/${commit}`)).data)
    if (metadata.sha !== commit)
      throw new ServiceConnectionError(502, 'GitHub returned a different commit')
    revision = { commit, tree: metadata.tree.sha }
  }
  const pinned = revision
  const source = (kind: 'blob' | 'tree') =>
    `https://github.com/${options.owner}/${options.repo}/${kind}/${pinned.commit}${path ? '/' + path.split('/').map(encodeURIComponent).join('/') : ''}`
  let treeSha = pinned.tree
  let entry: z.infer<typeof Tree>['tree'][number] | undefined
  const components = path ? path.split('/') : []
  for (const [index, component] of components.entries()) {
    const parent = Tree.parse((await get(`/git/trees/${treeSha}`)).data)
    if (parent.sha !== treeSha)
      throw new ServiceConnectionError(502, 'GitHub returned a different tree')
    entry = parent.tree.find((candidate) => candidate.path === component)
    if (!entry)
      throw new ServiceConnectionError(
        404,
        parent.truncated
          ? 'This directory exceeds the metadata limit; the requested path could not be established.'
          : 'The requested path does not exist at this revision.',
      )
    if (entry.type === 'tree') treeSha = entry.sha
    else if (index < components.length - 1)
      throw new ServiceConnectionError(404, 'A path component is not a directory')
  }
  if (!entry || entry.type === 'tree') {
    const directory = Tree.parse((await get(`/git/trees/${treeSha}`)).data)
    if (directory.sha !== treeSha)
      throw new ServiceConnectionError(502, 'GitHub returned a different tree')
    return {
      kind: 'directory' as const,
      revision: pinned,
      path,
      url: source('tree'),
      entries: directory.tree.slice(0, 100).map((item) => ({
        path: path ? `${path}/${item.path}` : item.path,
        type:
          item.type === 'tree'
            ? 'directory'
            : item.mode === '120000' || item.type === 'commit'
              ? 'unsupported'
              : 'file',
        ...(item.size === undefined ? {} : { size: item.size }),
      })),
      truncated: directory.truncated || directory.tree.length > 100,
    }
  }
  const base = { revision: pinned, path, url: source('blob') }
  if (entry.mode === '120000' || entry.type === 'commit')
    return {
      ...base,
      kind: 'unsupported' as const,
      reason: 'Symlinks and submodules are not followed.',
    }
  if (entry.size === undefined)
    throw new ServiceConnectionError(502, 'GitHub did not provide the file size')
  if (entry.size > 32 * 1024)
    return {
      ...base,
      kind: 'too_large' as const,
      size: entry.size,
      reason: 'The file exceeds the 32 KiB text read limit.',
    }
  options.signal.throwIfAborted()
  const result = await options.readFile(path, pinned.commit)
  if (result.kind !== 'text')
    return {
      ...base,
      ...result,
      reason:
        result.kind === 'binary'
          ? 'Binary files cannot be summarized as text.'
          : 'The file exceeds the text read limit.',
    }
  const bytes = Buffer.from(result.text, 'utf8')
  if (
    bytes.length !== entry.size ||
    createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== entry.sha
  )
    throw new ServiceConnectionError(502, 'The file content did not match its pinned Git revision')
  if (result.text.includes('\0'))
    return {
      ...base,
      kind: 'binary' as const,
      reason: 'Binary files cannot be summarized as text.',
    }
  return { ...base, kind: 'text' as const, text: result.text }
}
