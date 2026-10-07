/** Production access is independent of the execution profile (ADR-0015). */
export interface VpsAccess {
  mode: 'public' | 'tunnel'
  host: '0.0.0.0' | '127.0.0.1'
  port: number
  origin: string
  rpID: string
}

export type VpsAccessStatus = Pick<VpsAccess, 'mode' | 'origin'> & { pending?: boolean }

export function resolveVpsAccess(env: NodeJS.ProcessEnv): VpsAccess {
  const mode = env['VEDUTA_ACCESS'] ?? 'public'
  if (mode !== 'public' && mode !== 'tunnel') {
    throw new Error(`unknown VEDUTA_ACCESS: ${mode} (expected tunnel or public)`)
  }
  if (mode === 'tunnel') {
    if (env['VEDUTA_PUBLIC_DOMAIN']) {
      throw new Error('Tunnel access is incompatible with VEDUTA_PUBLIC_DOMAIN')
    }
    const port = parsePort(env['PORT'] ?? '8788', 'PORT')
    return { mode, host: '127.0.0.1', port, origin: `http://localhost:${port}`, rpID: 'localhost' }
  }
  const domain = env['VEDUTA_PUBLIC_DOMAIN']
  if (!domain) throw new Error('VEDUTA_PROFILE=vps requires VEDUTA_PUBLIC_DOMAIN for Public access')
  if (
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
      domain,
    )
  ) {
    throw new Error('VEDUTA_PUBLIC_DOMAIN must be a DNS domain without a scheme, port, or path')
  }
  const port = parsePort(env['HTTPS_PORT'] ?? '443', 'HTTPS_PORT')
  const rpID = domain.toLowerCase()
  const origin = `https://${rpID}${port === 443 ? '' : `:${port}`}`
  return { mode, host: '0.0.0.0', port, origin, rpID }
}

function parsePort(value: string, name: string): number {
  const port = Number(value)
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`)
  }
  return port
}
