import { readFileSync } from 'node:fs'
import { fromPartial } from '@total-typescript/shoehorn'
import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from './agent-runner.ts'
import { clawHubSourceInText } from './clawhub-catalog.ts'
import {
  createClawHubInspectionTool,
  inspectClawHubSkill,
  parseClawHubSource,
} from './clawhub-inspection.ts'

function fixture(name: string): Buffer {
  return readFileSync(new URL(`./fixtures/clawhub/${name}`, import.meta.url))
}

function catalogFetch(slug: string, version: string): typeof fetch {
  return vi.fn(async (input) => {
    const url = new URL(String(input))
    if (url.hostname !== 'clawhub.ai') throw new Error('Unexpected host')
    const name = url.pathname.endsWith(`/versions/${version}`)
      ? `${slug}-version.json`
      : url.pathname === '/api/v1/download'
        ? `${slug}-${version}.zip`
        : `${slug}-catalog.json`
    return new Response(fixture(name), {
      headers: { 'content-type': name.endsWith('.zip') ? 'application/zip' : 'application/json' },
    })
  })
}

describe('ClawHub package inspection', () => {
  it('finds an owner-qualified identifier in a package request without treating repository URLs as Skills', () => {
    expect(clawHubSourceInText('Inspect steipete/obsidian')).toBe('steipete/obsidian')
    expect(
      clawHubSourceInText('Please check Skill compatibility for steipete/obsidian@1.0.0'),
    ).toBe('steipete/obsidian@1.0.0')
    expect(clawHubSourceInText('Inspect https://github.com/Ic3b3rg/veduta')).toBeUndefined()
    expect(clawHubSourceInText('Inspect GitHub repository Ic3b3rg/veduta')).toBeUndefined()
    expect(
      clawHubSourceInText(
        'Install ClawHub Skill steipete/obsidian and inspect its GitHub repository provenance',
      ),
    ).toBe('steipete/obsidian')
    expect(clawHubSourceInText('Install steipete/obsidian@1.0.0+unpublished')).toBe(
      'steipete/obsidian@1.0.0+unpublished',
    )
    expect(clawHubSourceInText('Inspect src/components/Button.tsx')).toBeUndefined()
    expect(clawHubSourceInText('Install <https://clawhub.ai/steipete/obsidian>')).toBe(
      'https://clawhub.ai/steipete/obsidian',
    )
    expect(clawHubSourceInText('Install [Obsidian](https://clawhub.ai/steipete/obsidian)')).toBe(
      'https://clawhub.ai/steipete/obsidian',
    )
    expect(
      clawHubSourceInText(
        'Install https://clawhub.ai/steipete/obsidian?version=1.0.0(unpublished)',
      ),
    ).toBe('https://clawhub.ai/steipete/obsidian?version=1.0.0(unpublished)')
  })

  it('refuses a changed scanner digest instead of dropping it during metadata validation', async () => {
    const original = catalogFetch('obsidian', '1.0.0')
    let reads = 0
    const fetchFn: typeof fetch = async (input, init) => {
      if (String(input).includes('/versions/')) {
        const changed = JSON.parse(fixture('obsidian-version.json').toString())
        changed.version.security.sha256hash = reads++ === 0 ? 'a'.repeat(64) : 'b'.repeat(64)
        return Response.json(changed)
      }
      return original(input, init)
    }
    await expect(inspectClawHubSkill('@steipete/obsidian', { fetchFn })).rejects.toThrow('changed')
  })

  it('does not contact the catalog when the request was already cancelled', async () => {
    const fetchFn = catalogFetch('obsidian', '1.0.0')
    await expect(
      inspectClawHubSkill('@steipete/obsidian', { fetchFn, signal: AbortSignal.abort() }),
    ).rejects.toThrow('cancelled')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('refuses missing versions, wrong publishers, malformed metadata and oversized responses', async () => {
    const catalog = JSON.parse(fixture('obsidian-catalog.json').toString())
    const missing = structuredClone(catalog)
    missing.latestVersion = null
    const owner = structuredClone(catalog)
    owner.owner.handle = 'other-publisher'
    for (const body of [JSON.stringify(missing), JSON.stringify(owner), 'PRIVATE-BODY-NOT-JSON']) {
      await expect(
        inspectClawHubSkill('@steipete/obsidian', { fetchFn: async () => new Response(body) }),
      ).rejects.toThrow()
    }
    await expect(
      inspectClawHubSkill('@steipete/obsidian', {
        fetchFn: async () => new Response('x'.repeat(512 * 1024 + 1)),
      }),
    ).rejects.toThrow('inspection limits')
  })

  it('refuses changed file bytes even when catalog scanners say clean', async () => {
    const original = catalogFetch('obsidian', '1.0.0')
    const fetchFn: typeof fetch = async (input, init) => {
      if (String(input).includes('/versions/')) {
        const changed = JSON.parse(fixture('obsidian-version.json').toString())
        changed.version.files[0].sha256 = 'a'.repeat(64)
        return Response.json(changed)
      }
      return original(input, init)
    }
    await expect(inspectClawHubSkill('@steipete/obsidian', { fetchFn })).rejects.toThrow('changed')
  })

  it.each([
    ['@steipete/obsidian', 'steipete', 'obsidian'],
    ['steipete/obsidian', 'steipete', 'obsidian'],
    ['https://clawhub.ai/steipete/obsidian', 'steipete', 'obsidian'],
    ['https://clawhub.ai/steipete/skills/obsidian?version=1.0.0', 'steipete', 'obsidian'],
  ])(
    'resolves owner-qualified identity %s without using an input URL as a fetch target',
    (source, owner, slug) => {
      expect(parseClawHubSource(source)).toMatchObject({ owner, slug })
    },
  )

  it.each([
    'obsidian',
    'http://clawhub.ai/steipete/obsidian',
    'https://clawhub.ai.evil.test/steipete/obsidian',
    'https://steipete:secret@clawhub.ai/steipete/obsidian',
    'https://clawhub.ai/steipete/plugins/brave-plugin',
    'https://clawhub.ai/steipete/%2e%2e/obsidian',
    'https://clawhub.ai/steipete/obsidian?url=https://evil.test',
  ])('rejects ambiguous or invalid identity %s', (source) => {
    expect(() => parseClawHubSource(source)).toThrow()
  })

  it('pins and inventories the published Obsidian artifact and exposes its dependency drift', async () => {
    const report = await inspectClawHubSkill('@steipete/obsidian', {
      fetchFn: catalogFetch('obsidian', '1.0.0'),
    })
    expect(report.version).toBe('1.0.0')
    expect(report.archiveSha256).toBe(
      'ff964e127170088a5e5e280f9f437afcba3a6e3d579c05b947a37b7f4253bf1b',
    )
    expect(report.files).toHaveLength(3)
    expect(report.files.find((file) => file.path === 'SKILL.md')?.sha256).toBe(
      'dc45b522a0f08fa11762b330b5355ccaca789bd645b0c450fe75026f69d728b2',
    )
    expect(report.status).toBe('adaptation_required')
    expect(report.requirements.join('\n')).toContain('obsidian-cli')
    expect(report.reasons.join('\n')).toContain('notesmd-cli')
    expect(report.permissions.join('\n')).toContain('vault')
    expect(report.installationAllowed).toBe(false)
    expect(report.provenanceGaps.length).toBeGreaterThan(0)
    expect(report.scanLimit).toContain('not proof')
  })

  it('keeps published self-improving-agent unsupported despite clean scan signals', async () => {
    const report = await inspectClawHubSkill('@pskoett/self-improving-agent@4.0.2', {
      fetchFn: catalogFetch('self-improving-agent', '4.0.2'),
    })
    expect(report.archiveSha256).toBe(
      '89f2a239f9d675c4c5787cf61c17f709cd38cb9c7d395f9dc50f487a59a47291',
    )
    expect(report.status).toBe('unsupported')
    expect(report.requirements.join('\n')).toContain('agent:bootstrap')
    for (const tool of ['sessions_list', 'sessions_history', 'sessions_send', 'sessions_spawn'])
      expect(report.requirements.join('\n')).toContain(tool)
    expect(report.requirements.join('\n')).toContain('Node')
    expect(report.requirements.join('\n')).toContain('Bash')
    expect(report.dataAccess.join('\n')).toContain('cross-session')
    expect(report.reasons.join('\n')).toContain('transcript')
    expect(report.installationAllowed).toBe(false)
  })

  it('fails closed when owner or pinned metadata changes during inspection', async () => {
    const original = catalogFetch('obsidian', '1.0.0')
    let versionReads = 0
    const fetchFn: typeof fetch = async (input, init) => {
      const response = await original(input, init)
      if (String(input).includes('/versions/')) {
        versionReads += 1
        if (versionReads === 2) {
          const changed = JSON.parse(fixture('obsidian-version.json').toString())
          changed.version.files[0].sha256 = 'a'.repeat(64)
          return Response.json(changed)
        }
      }
      return response
    }
    await expect(inspectClawHubSkill('@steipete/obsidian', { fetchFn })).rejects.toThrow('changed')
  })

  it.each([302, 404, 429, 503])(
    'refuses catalog status %i without following redirects or reflecting its body',
    async (status) => {
      const fetchFn = vi.fn(
        async () =>
          new Response('PRIVATE-RESPONSE', {
            status,
            headers: { location: 'http://127.0.0.1:8788' },
          }),
      )
      await expect(inspectClawHubSkill('@steipete/obsidian', { fetchFn })).rejects.toThrow(
        'unavailable',
      )
      expect(fetchFn.mock.calls).toHaveLength(1)
    },
  )

  it('binds read access to the current user source and returns the complete report as Untrusted data', async () => {
    const fetchFn = catalogFetch('obsidian', '1.0.0')
    const tool = createClawHubInspectionTool({ fetchFn })
    const context = fromPartial<ToolContext>({
      currentUserRequest: {
        text: 'Inspect https://clawhub.ai/steipete/obsidian',
        origin: 'trusted:user',
      },
    })
    const result = await tool.handler({ source: '@steipete/obsidian' }, context)
    expect(result.origins).toEqual(['untrusted:clawhub'])
    expect(result.content).toContain('File inventory')
    expect(result.content).toContain('No package or dependency was installed')
    expect(result.content).toContain(
      'ff964e127170088a5e5e280f9f437afcba3a6e3d579c05b947a37b7f4253bf1b',
    )
    const denied = await tool.handler({ source: '@pskoett/self-improving-agent' }, context)
    expect(denied.content).toContain('must match the current user source')
    expect(denied.terminate).toBe(true)
  })
})
