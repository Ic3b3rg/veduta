import { readFileSync } from 'node:fs'
import process from 'node:process'
import { URL } from 'node:url'

// Compare parsed endpoints, not spelling: URL normalizes hostname case, IPv4,
// IPv4-mapped IPv6, leading-zero ports, and omitted HTTP(S) ports.
const backendPort = Number(process.argv[2])
const config = JSON.parse(readFileSync(0, 'utf8')) ?? {}
if (typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid Serve status')
const configurations = [config, ...Object.values(config.Foreground ?? {})]
const publicEndpoints = new Set(
  configurations.flatMap((entry) =>
    Object.entries(entry.AllowFunnel ?? {})
      .filter(([, enabled]) => enabled === true)
      .map(([endpoint]) => endpoint),
  ),
)

function targetsGateway(target) {
  if (typeof target !== 'string') return false
  const value = target.replace(/^https\+insecure:\/\//i, 'https://')
  const url = new URL(value.includes('://') ? value : `http://${value}`)
  if (url.protocol === 'unix:') return false
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  return (
    port === backendPort &&
    ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::ffff:7f00:1]', '[::ffff:0:0]'].includes(host)
  )
}

const exposed = configurations.some((entry) =>
  [...publicEndpoints].some((endpoint) => {
    const port = endpoint.slice(endpoint.lastIndexOf(':') + 1)
    const proxies = Object.values(entry.Web?.[endpoint]?.Handlers ?? {}).map(
      (handler) => handler.Proxy,
    )
    return [...proxies, entry.TCP?.[port]?.TCPForward].some(targetsGateway)
  }),
)
process.stdout.write(String(exposed))
