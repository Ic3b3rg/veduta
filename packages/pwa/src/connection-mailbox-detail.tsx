import { Button } from '@veduta/catalog/ui/button'
import type { GmailConnection, HimalayaConnection } from '@veduta/protocol'
import type { ConnectionsController } from './connections-controller.ts'
import { ConnectionDetailBody, ConnectionDetailFooter } from './connections-layout.tsx'
import { GmailConnectionCard } from './settings-gmail-connections.tsx'
import { HimalayaConnectionCard } from './settings-himalaya-connections.tsx'
import {
  removeGmailConnection,
  renameGmailConnection,
  verifyLegacyGmailConnection,
} from './gmail-connections-api.ts'
import {
  completeLegacyHimalayaConnection,
  installHimalaya,
  removeHimalayaConnection,
  renameHimalayaConnection,
  verifyHimalayaConnection,
} from './himalaya-connections-api.ts'

export function ConnectionMailboxDetail({
  gmail,
  himalaya,
  controller,
  token,
  onReview,
  onAuthorize,
  onRemoved,
}: {
  gmail?: GmailConnection
  himalaya?: HimalayaConnection
  controller: ConnectionsController
  token?: string
  onReview: () => void
  onAuthorize: () => void
  onRemoved: () => void
}) {
  return (
    <>
      <ConnectionDetailBody>
        {controller.error && (
          <p role="alert" className="connections-alert">
            {controller.error}
          </p>
        )}
        <ul className="gmail-connection-list">
          {gmail && (
            <GmailConnectionCard
              connection={gmail}
              busy={controller.busy}
              onAuthorize={onAuthorize}
              onVerifyLegacy={(id) =>
                void controller.run(() => verifyLegacyGmailConnection(id, token))
              }
              onRename={(id, name) =>
                void controller.run(() => renameGmailConnection(id, name, token))
              }
              onRemove={async (id) => {
                if (
                  window.confirm('Remove this Gmail account and its saved authorization?') &&
                  (await controller.run(() => removeGmailConnection(id, token)))
                )
                  onRemoved()
              }}
            />
          )}
          {himalaya && (
            <HimalayaConnectionCard
              connection={himalaya}
              busy={controller.busy}
              onVerify={(id) => void controller.run(() => verifyHimalayaConnection(id, token))}
              onCompleteLegacy={(id, input) =>
                void controller.run(() => completeLegacyHimalayaConnection(id, input, token))
              }
              onRename={(id, name) =>
                void controller.run(() => renameHimalayaConnection(id, name, token))
              }
              onRemove={async (id) => {
                if (
                  window.confirm('Remove this Mailbox connection and its saved credentials?') &&
                  (await controller.run(() => removeHimalayaConnection(id, token)))
                )
                  onRemoved()
              }}
            />
          )}
        </ul>
        {himalaya?.state === 'needs_setup' && (
          <Button
            variant="outline"
            disabled={controller.busy}
            onClick={() =>
              void controller.run(async () => {
                const result = await installHimalaya(token)
                if (result.state === 'failed')
                  throw new Error(result.reason ?? 'Himalaya installation failed')
              })
            }
          >
            Install Himalaya 2.1.0
          </Button>
        )}
      </ConnectionDetailBody>
      <ConnectionDetailFooter>
        {gmail?.state === 'ready' && (
          <Button disabled={controller.busy} onClick={onReview}>
            Review Space access
          </Button>
        )}
        <Button variant="outline" onClick={onRemoved}>
          Done
        </Button>
      </ConnectionDetailFooter>
    </>
  )
}
