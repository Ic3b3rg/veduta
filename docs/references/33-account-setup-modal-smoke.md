# Account addition and recovery smoke

Related work: #181, #200 and the account-management amendment in
[ADR-0033](../adr/0033-chat-initiated-service-connections.md).

## UI acceptance journey

Use disposable service accounts and a test Space. Open Settings → Accounts & services.

1. Choose **Add account**. Gmail, GitHub and Other email are choices in one selector. GitHub
   shows its token/read-access explanation without an unrelated email-provider prompt. Other
   email opens its IMAP/SMTP form. Desktop uses a modal; mobile uses a full-screen Sheet.
2. Choose GitHub → **Review access**. This new connection does not require a repository name
   or refer to a previously removed account. Enter an invalid or revoked fine-grained token.
   The error appears inside the modal once. Reload: its safe failure remains visible there.
3. **Return to review** permits another authorization. **Cancel setup**, Close and Escape
   dismiss an unfinished management flow. Cancellation failures remain in the modal and Close
   retries them. The account list contains no Setup requests or abandoned failure cards.
4. Repeat with a valid disposable token. Verify the account identity and reviewed permissions,
   leave Space checkboxes unchecked, and **Save access**. The modal closes; one verified account
   appears without Space access. Reload and reconnect: that account remains available.
5. Open the account, choose **Remove**, then reload. The account stays removed and its historical
   attempts do not return as setup cards. **Add account** starts a fresh review.
6. Choose Gmail, complete the protected Google configuration if needed, and **Continue to Google**.
   Deny consent. The callback returns to the same modal with its error. Retry retains the same
   account; cancelling removes an unverified native account created by that attempt, while
   preserving an existing account and installation Google configuration.
7. A callback from an older authorization must not invalidate a newer retry. An expired current
   authorization must show a recoverable failure. No callback after cancellation may revive it.
   These timing cases also have deterministic Gateway-route coverage.
8. Check keyboard focus and Escape. Starting through **Connect your first account**, then saving,
   returns focus to **Add account** after the empty-state button disappears. On narrow screens,
   the body scrolls and footer actions remain reachable without horizontal overflow.

## Recorded evidence — 2026-10-05

The local browser proof used an isolated Gateway data root, actual Gateway HTTP routes and the
PWA. GitHub identity/discovery were provider fixtures; Google denial was a fixture callback through
the real route. No real tokens, messages or repository content were used by this UI proof.

- Historical failed attempts and a removed account were seeded before opening settings: the
  account list was empty, with no Setup requests section.
- GitHub new review accepted the broad read profile. Rejected-token feedback stayed in the modal;
  cancellation restored the clean list. A new successful flow saved one account without grants.
- The verified account survived browser refresh and Gateway restart. Removing it and refreshing
  left no account or setup card; another new GitHub review still succeeded.
- Gmail consent denial returned to the modal, retry retained the same native account, and another
  denial could be cancelled. The disposable native account list was empty afterward; Google
  configuration remained available.
- Layouts were inspected at 320, 768, 1024 and 1440 CSS pixels. The 320-pixel Sheet had a scrollable
  body, visible footer and no horizontal overflow. Close restored focus to Add account.
- Regression tests cover inline creation failures, cancellation cleanup retries, disappearing
  openers, removed-account history, same-account Gmail retry, temporary-account isolation, stale
  callbacks, current-nonce expiry, cancellation and preserved existing accounts.

The separate `Invalid connection setup request` report came from a running Gateway predating the
broader GitHub contract: its schema required an exact repository, while the rebuilt PWA submitted
only a service and submission id. The exact same payload was rejected by that earlier schema and
accepted by the current schema. Updating only static PWA assets does not update the running
Gateway; both must run the matching revision. This diagnosis does not establish the permissions
of a replacement PAT.

Final verification passed lint, formatting, typechecking, all 3,836 package tests and build with
`VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1 VITEST_MAX_FORKS=4 VITEST_MIN_FORKS=1 pnpm check`.
The final OAuth-expiry refinement was included in this run. Independent Standards and Spec reviews
had no remaining material findings. Disposable Gateway processes, data, credentials and scoped
browser storage were removed.

The configured local-VPS instance on port 8788 was then restarted with the verified checkout.
Its served asset contains the new provider selector and no Setup requests list. The production
auth-status endpoint responds; unauthenticated protected requests still return 401. Hashes of
account, Gmail and authentication metadata were unchanged across the restart. This is deployment
and preservation evidence, not a successful authorization test of the user's replacement PAT.
