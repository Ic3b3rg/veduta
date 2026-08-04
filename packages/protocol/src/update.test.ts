import { describe, expect, it } from 'vitest'
import {
  ReleaseMetadataSchema,
  SigningKeyCertSchema,
  UpdateManifestSchema,
  UpdateMarkerSchema,
  UpdatePinningSchema,
  UpdateProgressSchema,
  UpdateResultSchema,
} from './update.ts'

const validRelease = {
  version: '1.2.3',
  artifactName: 'veduta-v1.2.3-linux.tar.gz',
  sha256: 'a'.repeat(64),
  artifactSize: 1024,
  unpackedSize: 4096,
  entryCount: 12,
  dataVersion: 1,
  nodeVersion: 'v24.11.1',
  nodeTarSize: 2048,
  nodeUnpackedSize: 8192,
}

const validSigningKey = {
  pub: 'untrusted comment: minisign public key\nRWQ...',
  rootSig: 'untrusted comment: signature from minisign secret key\nRWQ...',
  keyId: 'signing-2026',
}

describe('ReleaseMetadataSchema', () => {
  it('accepts a valid release, defaulting notes to an empty string', () => {
    const parsed = ReleaseMetadataSchema.parse(validRelease)
    expect(parsed.notes).toBe('')
  })

  it('accepts an explicit notes string', () => {
    const parsed = ReleaseMetadataSchema.parse({ ...validRelease, notes: 'Fixes the widget.' })
    expect(parsed.notes).toBe('Fixes the widget.')
  })

  it.each([
    ['non-semver version', { ...validRelease, version: 'v1.2.3' }],
    ['too-short sha256', { ...validRelease, sha256: 'a'.repeat(63) }],
    ['uppercase sha256', { ...validRelease, sha256: 'A'.repeat(64) }],
    ['zero artifactSize', { ...validRelease, artifactSize: 0 }],
    ['negative unpackedSize', { ...validRelease, unpackedSize: -1 }],
    ['fractional entryCount', { ...validRelease, entryCount: 1.5 }],
    ['dataVersion below 1', { ...validRelease, dataVersion: 0 }],
    ['missing nodeVersion', { ...validRelease, nodeVersion: '' }],
  ])('rejects %s', (_label, input) => {
    expect(ReleaseMetadataSchema.safeParse(input).success).toBe(false)
  })
})

describe('SigningKeyCertSchema', () => {
  it('accepts a valid cert', () => {
    expect(SigningKeyCertSchema.safeParse(validSigningKey).success).toBe(true)
  })

  it('rejects an empty keyId', () => {
    expect(SigningKeyCertSchema.safeParse({ ...validSigningKey, keyId: '' }).success).toBe(false)
  })
})

describe('UpdateManifestSchema', () => {
  const validManifest = {
    schemaVersion: 1 as const,
    release: Buffer.from(JSON.stringify(validRelease)).toString('base64'),
    releaseSig: 'untrusted comment: signature\nRWQ...',
    signingKey: validSigningKey,
    artifactUrl: 'https://updates.veduta.example/releases/v1.2.3/veduta-v1.2.3-linux.tar.gz',
  }

  it('accepts a valid manifest', () => {
    expect(UpdateManifestSchema.safeParse(validManifest).success).toBe(true)
  })

  it('rejects a schemaVersion other than 1', () => {
    expect(UpdateManifestSchema.safeParse({ ...validManifest, schemaVersion: 2 }).success).toBe(
      false,
    )
  })

  it('rejects a non-base64 release field', () => {
    expect(
      UpdateManifestSchema.safeParse({ ...validManifest, release: 'not base64 !!' }).success,
    ).toBe(false)
  })

  it('rejects a non-URL artifactUrl', () => {
    expect(
      UpdateManifestSchema.safeParse({ ...validManifest, artifactUrl: 'not-a-url' }).success,
    ).toBe(false)
  })
})

describe('UpdatePinningSchema', () => {
  it('accepts a valid pinning file', () => {
    expect(
      UpdatePinningSchema.safeParse({
        feedUrl: 'https://updates.veduta.example/stable.json',
        rootPublicKey: 'RWQ...',
      }).success,
    ).toBe(true)
  })

  it('rejects a non-URL feedUrl', () => {
    expect(
      UpdatePinningSchema.safeParse({ feedUrl: 'updates.veduta.example', rootPublicKey: 'RWQ' })
        .success,
    ).toBe(false)
  })

  it('rejects an empty rootPublicKey', () => {
    expect(
      UpdatePinningSchema.safeParse({
        feedUrl: 'https://updates.veduta.example/stable.json',
        rootPublicKey: '',
      }).success,
    ).toBe(false)
  })
})

describe('UpdateMarkerSchema', () => {
  const validMarker = {
    requestedAt: '2026-08-04T10:00:00.000Z',
    release: Buffer.from(JSON.stringify(validRelease)).toString('base64'),
    releaseSig: 'untrusted comment: signature\nRWQ...',
    signingKey: validSigningKey,
    artifactUrl: 'https://updates.veduta.example/releases/v1.2.3/veduta-v1.2.3-linux.tar.gz',
  }

  it('accepts a valid marker', () => {
    expect(UpdateMarkerSchema.safeParse(validMarker).success).toBe(true)
  })

  it('rejects a non-ISO requestedAt', () => {
    expect(
      UpdateMarkerSchema.safeParse({ ...validMarker, requestedAt: '2026-08-04' }).success,
    ).toBe(false)
  })
})

describe('UpdateResultSchema', () => {
  const validResult = {
    id: 'upd-1',
    outcome: 'success' as const,
    fromVersion: '1.2.2',
    toVersion: '1.2.3',
    finishedAt: '2026-08-04T10:05:00.000Z',
  }

  it('accepts a valid success result, defaulting reason to an empty string', () => {
    const parsed = UpdateResultSchema.parse(validResult)
    expect(parsed.reason).toBe('')
    expect(parsed.failedStage).toBeUndefined()
  })

  it('accepts a rolled-back result with a reason and a failedStage', () => {
    expect(
      UpdateResultSchema.safeParse({
        ...validResult,
        outcome: 'rolled-back',
        reason: 'serving check timed out',
        failedStage: 'serving-check',
      }).success,
    ).toBe(true)
  })

  it('rejects an unknown outcome', () => {
    expect(UpdateResultSchema.safeParse({ ...validResult, outcome: 'partial' }).success).toBe(false)
  })

  it('rejects a non-ISO finishedAt', () => {
    expect(UpdateResultSchema.safeParse({ ...validResult, finishedAt: 'yesterday' }).success).toBe(
      false,
    )
  })
})

describe('UpdateProgressSchema', () => {
  const validProgress = {
    protocol_version: 1 as const,
    stages: [
      { id: 'download', title: 'Downloading', status: 'done' as const },
      { id: 'verify', title: 'Verifying signature', status: 'running' as const },
    ],
  }

  it('accepts a valid progress document', () => {
    expect(UpdateProgressSchema.safeParse(validProgress).success).toBe(true)
  })

  it('rejects an empty stages array', () => {
    expect(UpdateProgressSchema.safeParse({ ...validProgress, stages: [] }).success).toBe(false)
  })

  it('rejects an unknown stage status', () => {
    expect(
      UpdateProgressSchema.safeParse({
        ...validProgress,
        stages: [{ id: 'download', title: 'Downloading', status: 'queued' }],
      }).success,
    ).toBe(false)
  })

  it('rejects a protocol_version other than 1', () => {
    expect(UpdateProgressSchema.safeParse({ ...validProgress, protocol_version: 2 }).success).toBe(
      false,
    )
  })
})
