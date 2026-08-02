import { describe, expect, it } from 'vitest'
import { restartTimedOutGuidance } from './wizard-step-finish.tsx'

describe('restartTimedOutGuidance', () => {
  it('points at the Local VPS runner terminal, not systemd, on the local-vps profile', () => {
    expect(restartTimedOutGuidance('local-vps')).toEqual({
      message:
        'The daemon did not come back after restarting. Check the terminal running the Local VPS runner — it restarts the daemon automatically once it exits cleanly:',
      command: 'pnpm local-vps',
    })
  })

  it('points at journalctl on the vps profile', () => {
    expect(restartTimedOutGuidance('vps')).toEqual({
      message: 'The daemon did not come back after restarting. Check its logs:',
      command: 'sudo journalctl -u veduta -n 50',
    })
  })

  it('falls back to the journalctl guidance on the loopback profile, which never actually times out a restart', () => {
    expect(restartTimedOutGuidance('loopback')).toEqual({
      message: 'The daemon did not come back after restarting. Check its logs:',
      command: 'sudo journalctl -u veduta -n 50',
    })
  })
})
