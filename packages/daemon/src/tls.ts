import * as acme from 'acme-client'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface CertificateMaterial {
  key: string
  cert: string
}

export class AcmeChallengeStore {
  private challenges = new Map<string, string>()

  set(token: string, keyAuthorization: string): void {
    this.challenges.set(token, keyAuthorization)
  }

  get(token: string): string | undefined {
    return this.challenges.get(token)
  }

  delete(token: string): void {
    this.challenges.delete(token)
  }
}

export interface HttpRequestLike {
  url?: string | undefined
}

export interface HttpResponseLike {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string): void
}

export function createHttp01RequestHandler(options: {
  domain: string
  challenges: AcmeChallengeStore
}): (request: HttpRequestLike, response: HttpResponseLike) => void {
  return (request, response) => {
    const url = request.url ?? '/'
    const token = challengeToken(url)
    if (token) {
      const keyAuthorization = options.challenges.get(token)
      response.statusCode = keyAuthorization ? 200 : 404
      response.setHeader('content-type', 'text/plain; charset=utf-8')
      response.end(keyAuthorization ?? 'not found')
      return
    }

    response.statusCode = 308
    response.setHeader('location', `https://${options.domain}${url.startsWith('/') ? url : '/'}`)
    response.end()
  }
}

export interface AcmeClientLike {
  auto(options: acme.ClientAutoOptions): Promise<string>
}

export type AcmeClientFactory = (input: {
  directoryUrl: string
  accountKey: string
}) => Promise<AcmeClientLike>

export interface AcmeCertificateManagerOptions {
  domain: string
  email: string
  certDir: string
  challenges: AcmeChallengeStore
  directoryUrl?: string
  clientFactory?: AcmeClientFactory
  createPrivateKey?: () => Promise<string>
  createCsr?: (domain: string) => Promise<{ key: string; csr: string }>
}

export class AcmeCertificateManager {
  private directoryUrl: string
  private clientFactory: AcmeClientFactory
  private createPrivateKey: () => Promise<string>
  private createCsr: (domain: string) => Promise<{ key: string; csr: string }>

  constructor(private readonly options: AcmeCertificateManagerOptions) {
    this.directoryUrl = options.directoryUrl ?? acme.directory.letsencrypt.production
    this.clientFactory =
      options.clientFactory ??
      (async ({ directoryUrl, accountKey }) => new acme.Client({ directoryUrl, accountKey }))
    this.createPrivateKey =
      options.createPrivateKey ??
      (async () => (await acme.crypto.createPrivateEcdsaKey()).toString('utf8'))
    this.createCsr =
      options.createCsr ??
      (async (domain) => {
        const [key, csr] = await acme.crypto.createCsr({ commonName: domain, altNames: [domain] })
        return { key: key.toString('utf8'), csr: csr.toString('utf8') }
      })
  }

  async loadOrIssue(): Promise<CertificateMaterial> {
    const existing = await this.loadFreshCertificate()
    if (existing) return existing

    await mkdir(this.options.certDir, { recursive: true })
    const accountKey = await this.loadOrCreateAccountKey()
    const client = await this.clientFactory({ directoryUrl: this.directoryUrl, accountKey })
    const { key, csr } = await this.createCsr(this.options.domain)
    const cert = await client.auto({
      csr,
      email: this.options.email,
      termsOfServiceAgreed: true,
      challengePriority: ['http-01'],
      challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
        if (challenge.type === 'http-01')
          this.options.challenges.set(challenge.token, keyAuthorization)
      },
      challengeRemoveFn: async (_authz, challenge) => {
        if (challenge.type === 'http-01') this.options.challenges.delete(challenge.token)
      },
    })

    await writeFile(this.certKeyPath(), key, 'utf8')
    await writeFile(this.certPath(), cert, 'utf8')
    return { key, cert }
  }

  private async loadFreshCertificate(): Promise<CertificateMaterial | undefined> {
    try {
      const [key, cert] = await Promise.all([
        readFile(this.certKeyPath(), 'utf8'),
        readFile(this.certPath(), 'utf8'),
      ])
      const info = acme.crypto.readCertificateInfo(cert)
      const renewAfter = Date.now() + 30 * 86_400_000
      return info.notAfter.getTime() > renewAfter ? { key, cert } : undefined
    } catch {
      return undefined
    }
  }

  private async loadOrCreateAccountKey(): Promise<string> {
    try {
      return await readFile(this.accountKeyPath(), 'utf8')
    } catch {
      const key = await this.createPrivateKey()
      await mkdir(this.options.certDir, { recursive: true })
      await writeFile(this.accountKeyPath(), key, 'utf8')
      return key
    }
  }

  private accountKeyPath(): string {
    return join(this.options.certDir, `${this.options.domain}.account.key`)
  }

  private certKeyPath(): string {
    return join(this.options.certDir, `${this.options.domain}.key`)
  }

  private certPath(): string {
    return join(this.options.certDir, `${this.options.domain}.crt`)
  }
}

function challengeToken(url: string): string | undefined {
  const prefix = '/.well-known/acme-challenge/'
  const path = url.split('?')[0] ?? url
  if (!path.startsWith(prefix)) return undefined
  const token = path.slice(prefix.length)
  return token || undefined
}
