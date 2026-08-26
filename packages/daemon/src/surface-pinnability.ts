import { SYSTEM_SPACE_ID } from '@veduta/protocol'

export function isSurfacePinnable(daemonOwned: boolean, spaceId: string): boolean {
  return !daemonOwned || spaceId === SYSTEM_SPACE_ID
}
