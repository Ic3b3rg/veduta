import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { sep } from 'node:path'

export interface ReviewedMcpLaunch {
  command: string
  args: string[]
}

/** Denies the reviewed child access to the Gateway data root and user home. */
export function reviewedGithubMcpLaunch(
  executable: string,
  dataRoot: string,
  proxyPort: number,
): ReviewedMcpLaunch {
  if (process.platform !== 'darwin')
    throw new Error('This host has no verified GitHub MCP process boundary')
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535)
    throw new Error('GitHub MCP egress proxy port is invalid')
  const binary = realpathSync(executable)
  const root = realpathSync(dataRoot)
  const home = realpathSync(homedir())
  if (!binary.startsWith(`${root}${sep}reviewed-mcp${sep}`))
    throw new Error('GitHub MCP executable is outside the reviewed installation directory')
  const policy = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow file-read*)',
    `(allow network-outbound (remote ip "localhost:${proxyPort}"))`,
    `(deny file-read* (subpath ${JSON.stringify(home)}))`,
    `(deny file-read* (subpath ${JSON.stringify(root)}))`,
    `(allow file-read* (literal ${JSON.stringify(binary)}))`,
  ].join(' ')
  return { command: '/usr/bin/sandbox-exec', args: ['-p', policy, binary] }
}
