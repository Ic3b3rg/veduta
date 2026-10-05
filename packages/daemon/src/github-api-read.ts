import { ServiceConnectionError } from './service-connections.ts'

export class GithubApiReadError extends ServiceConnectionError {
  constructor(
    readonly providerStatus: number,
    message: string,
  ) {
    super(providerStatus === 401 || providerStatus === 403 ? 403 : 502, message)
  }
}

/** Fixed GitHub API host, bounded metadata, no redirects or credential-bearing diagnostics. */
export async function readGithubJson(
  token: string,
  path: string,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
  format: 'json' | 'commit-sha' = 'json',
): Promise<{ data: unknown; hasMore: boolean }> {
  signal?.throwIfAborted()
  const response = await fetchFn(`https://api.github.com${path}`, {
    method: 'GET',
    redirect: 'error',
    headers: {
      authorization: `Bearer ${token}`,
      accept:
        format === 'commit-sha' ? 'application/vnd.github.sha' : 'application/vnd.github+json',
      'user-agent': 'veduta-github-mcp-v1.12.2',
      'X-GitHub-Api-Version': '2026-03-10',
    },
    signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
  })
  if (!response.ok) {
    const reason =
      response.status === 401
        ? 'GitHub authorization expired. Reconnect the account.'
        : response.status === 403
          ? 'GitHub denied this read. Check token permissions and rate limits.'
          : response.status === 404
            ? 'The GitHub repository, revision or path is missing or inaccessible.'
            : 'GitHub could not complete the read. Try again later.'
    throw new GithubApiReadError(response.status, reason)
  }
  if (!response.body) throw new ServiceConnectionError(502, 'GitHub returned an empty response')
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.byteLength
    if (bytes > 512 * 1024)
      throw new ServiceConnectionError(502, 'GitHub metadata exceeds the read limit')
    chunks.push(chunk)
  }
  return {
    data:
      format === 'commit-sha'
        ? Buffer.concat(chunks).toString('utf8').trim()
        : (JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown),
    hasMore: /rel="next"/.test(response.headers.get('link') ?? ''),
  }
}
