import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../../daemon/src/server.ts'
import { CURRENT_DATA_VERSION } from '../../daemon/src/update/data-version.ts'
import {
  buildManifest,
  generateFixtureKeys,
  signReleaseMetadata,
  signSigningKeyCert,
  startFeedServer,
  writePinningFile,
} from './update-fixture.ts'

/** Fresh loopback installation and a real signed local feed; no installation or external push. */
export async function startUpdateNoticeStack() {
  const baseDir = mkdtempSync(join(tmpdir(), 'veduta-update-notice-'))
  const feed = await startFeedServer()
  const keys = generateFixtureKeys()
  const envKeys = [
    'VEDUTA_UPDATE_HOME',
    'VEDUTA_UPDATE_PINNING',
    'VEDUTA_INSTALLED_VERSION',
  ] as const
  const previous = envKeys.map((key) => process.env[key])
  process.env['VEDUTA_UPDATE_HOME'] = join(baseDir, 'updates')
  process.env['VEDUTA_UPDATE_PINNING'] = join(baseDir, 'pinning.json')
  process.env['VEDUTA_INSTALLED_VERSION'] = '1.2.2'
  writePinningFile(join(baseDir, 'pinning.json'), {
    feedUrl: feed.feedUrl,
    rootPublicKey: keys.root.publicKeyText,
  })
  let clock = new Date('2026-10-22T06:29:00.000Z')
  const boot = () =>
    buildServer({
      dataDir: join(baseDir, 'data'),
      now: () => new Date(clock),
      pushTransport: { send: async () => 'ok' },
    })
  let runtime = await boot()
  await runtime.app.listen({ host: '127.0.0.1', port: 0 })
  const address = runtime.app.server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected loopback address')
  const port = address.port
  const offer = (version: string, valid = true) => {
    const { releaseBytes, releaseSig } = signReleaseMetadata(
      {
        version,
        artifactName: `veduta-v${version}-linux.tar.gz`,
        sha256: 'a'.repeat(64),
        artifactSize: 1,
        unpackedSize: 1,
        entryCount: 1,
        dataVersion: CURRENT_DATA_VERSION,
        nodeVersion: '24.11.1',
        nodeTarSize: 1,
        nodeUnpackedSize: 1,
        notes: `Release notes for Veduta ${version}: update notice verification.`,
      },
      keys.signing,
    )
    feed.setManifest(
      Buffer.from(
        JSON.stringify(
          buildManifest({
            releaseBytes: valid
              ? releaseBytes
              : Buffer.from(releaseBytes.toString().replace(version, '9.9.9')),
            releaseSig,
            signingKeyCert: signSigningKeyCert(keys),
            artifactUrl: `${feed.origin}/artifact.tar.gz`,
          }),
        ),
      ),
    )
  }
  offer('1.2.3')
  return {
    origin: `http://127.0.0.1:${port}`,
    offer,
    discoverAutomatically: async () => {
      clock = new Date('2026-10-22T06:31:00.000Z')
      await runtime.scheduler.runDue()
    },
    restart: async (installedVersion?: string) => {
      await runtime.app.close()
      if (installedVersion !== undefined) process.env['VEDUTA_INSTALLED_VERSION'] = installedVersion
      runtime = await boot()
      await runtime.app.listen({ host: '127.0.0.1', port })
    },
    stop: async () => {
      await runtime.app.close()
      await feed.close()
      envKeys.forEach((key, index) => {
        const value = previous[index]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
      rmSync(baseDir, { recursive: true, force: true })
    },
  }
}
