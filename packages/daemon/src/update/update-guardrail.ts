import { statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { ReleaseMetadata } from '@veduta/protocol'
import type { Ports } from './update-ports.ts'

/**
 * The free-disk-space guardrail (`issues/043-self-update.md` AC8): refuses
 * the whole transaction before anything is downloaded or mutated when the
 * relevant filesystems do not have enough headroom. Split out of
 * `update-transaction.ts` so the guardrail's own arithmetic is testable and
 * readable independent of the journal/rollback state machine.
 */

/** The subset of the transaction context this module needs. */
export interface DiskGuardrailDeps {
  home: { root: string; tmpDir: string; backupsDir: string }
  dataRootDir: string
  ports: Pick<Ports, 'diskUsage' | 'statfs'>
}

interface DiskReservation {
  label: string
  fsPath: string
  bytes: number
}

/**
 * Sizes come from the signed release metadata (never a live measurement of
 * the untrusted download) plus a measured size of the live data root
 * (`issues/043-self-update.md` AC8). Reservations are grouped by filesystem
 * (`stat().dev`) before being checked against `statfs` free space, so two
 * reservations that happen to land on the same disk are not double-counted
 * as if they had independent headroom.
 */
export async function checkDiskGuardrail(
  deps: DiskGuardrailDeps,
  release: ReleaseMetadata,
  needsRuntime: boolean,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const dataRootBytes = await deps.ports.diskUsage(deps.dataRootDir)
  const reservations: DiskReservation[] = [
    {
      label: 'download + extraction' + (needsRuntime ? ' + node runtime' : ''),
      fsPath: deps.home.root,
      bytes:
        release.artifactSize +
        release.unpackedSize +
        (needsRuntime ? release.nodeTarSize + release.nodeUnpackedSize : 0),
    },
    { label: 'backup staging', fsPath: deps.home.tmpDir, bytes: dataRootBytes * 2 },
    { label: 'backup file', fsPath: deps.home.backupsDir, bytes: dataRootBytes },
    {
      label: 'restore headroom',
      fsPath: dirname(resolve(deps.dataRootDir)),
      bytes: dataRootBytes,
    },
  ]

  const groups = new Map<number, { fsPath: string; bytes: number; labels: string[] }>()
  for (const reservation of reservations) {
    const dev = statSync(reservation.fsPath).dev
    const existing = groups.get(dev) ?? { fsPath: reservation.fsPath, bytes: 0, labels: [] }
    existing.bytes += reservation.bytes
    existing.labels.push(reservation.label)
    groups.set(dev, existing)
  }

  const shortfalls: string[] = []
  for (const group of groups.values()) {
    const { bavail, bsize } = deps.ports.statfs(group.fsPath)
    const freeBytes = bavail * bsize
    const neededBytes = Math.ceil(group.bytes * 1.2)
    if (neededBytes > freeBytes) {
      shortfalls.push(
        `${group.fsPath}: needs ~${neededBytes} bytes (${group.labels.join(', ')}), only ${freeBytes} bytes free`,
      )
    }
  }

  if (shortfalls.length > 0) {
    return { ok: false, message: `insufficient disk space:\n${shortfalls.join('\n')}` }
  }
  return { ok: true }
}
