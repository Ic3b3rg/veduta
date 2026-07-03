import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AcmeCertificateManager,
  AcmeChallengeStore,
  createHttp01RequestHandler,
  type AcmeClientFactory,
} from './tls.ts'

describe('HTTP-01 redirect handler', () => {
  it('serves ACME challenges and redirects every other HTTP request to HTTPS', () => {
    const challenges = new AcmeChallengeStore()
    challenges.set('token-1', 'token-1.key-auth')
    const handler = createHttp01RequestHandler({
      domain: 'veduta.test',
      challenges,
    })

    const challenge = new FakeResponse()
    handler({ url: '/.well-known/acme-challenge/token-1' }, challenge)
    expect(challenge.statusCode).toBe(200)
    expect(challenge.body).toBe('token-1.key-auth')

    const redirect = new FakeResponse()
    handler({ url: '/api/spaces?x=1' }, redirect)
    expect(redirect.statusCode).toBe(308)
    expect(redirect.headers['location']).toBe('https://veduta.test/api/spaces?x=1')
  })
})

describe('AcmeCertificateManager', () => {
  it('issues and stores a certificate through the built-in ACME client', async () => {
    const certDir = await mkdtemp(join(tmpdir(), 'veduta-acme-'))
    const clientFactory: AcmeClientFactory = async () => new FakeAcmeClient()
    const manager = new AcmeCertificateManager({
      domain: 'veduta.test',
      email: 'owner@veduta.test',
      certDir,
      challenges: new AcmeChallengeStore(),
      clientFactory,
      createPrivateKey: async () => 'account-key',
      createCsr: async () => ({ key: 'cert-key', csr: 'csr' }),
    })

    const material = await manager.loadOrIssue()

    expect(material).toEqual({ key: 'cert-key', cert: 'issued-cert' })
    expect(await readFile(join(certDir, 'veduta.test.key'), 'utf8')).toBe('cert-key')
    expect(await readFile(join(certDir, 'veduta.test.crt'), 'utf8')).toBe('issued-cert')
  })
})

class FakeResponse {
  statusCode = 200
  headers: Record<string, string> = {}
  body = ''

  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value
  }

  end(body = ''): void {
    this.body = body
  }
}

class FakeAcmeClient {
  async auto(): Promise<string> {
    return 'issued-cert'
  }
}
