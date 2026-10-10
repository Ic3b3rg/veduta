# Expandable Chat prototype

Throwaway source for #228 on branch `prototype/expandable-chat-228`. It asks how the
owner wants to move between Space content and a full-screen mobile conversation.
This is not a production Chat implementation or acceptance of the example decision design.

## Run

Use `pnpm install --frozen-lockfile`, then `pnpm prototype:chat`.
The command creates a disposable `/tmp/veduta-chat-prototype.*` data directory and starts
the mock Gateway on port 8787 and the PWA on port 5184. Stop another local dev Gateway first.

- [A: Preview and desktop rail](http://localhost:5184/app/space/health?prototype=chat&variant=A)
- [B: Space first](http://localhost:5184/app/space/health?prototype=chat&variant=B)

Both variants use the existing Space route, header, navigation, and seeded Space content.
The prototype is gated to development. The bottom switcher changes the `variant` query
parameter and shows local draft, reading offset, decision, and expansion state.

## Try

1. At phone width, compare the room left for the Space. A keeps an answer preview and composer;
   B keeps the Chat entry and pending-review access. On desktop, A adds a conversation rail;
   B keeps the same Space-first layout.
2. Expand Chat, scroll halfway through the reply, and write a multiline draft. Return to Health
   and reopen Chat. The reading position and draft remain. Space scroll is also retained.
3. Open Review change. Inspect the current and proposed schedule, then close or choose an
   outcome. Return to the same reading position. The example is not a complete #227 prototype.
4. Open Model in the header. Choose a connection and model, then return. This tests placement
   of the two controls in a modal; it does not validate or apply a real Model connection.
5. Scroll to the bottom. The Latest message control disappears.

Chat, review, and model-selection changes are in memory and reset on reload. No prototype Chat
message is sent to a provider; the review has no backend effect. The host uses disposable mock
Space data. The prototype switcher is separate from the proposed product UI.

The owner has selected expandable mobile Chat. Compact presentation, desktop composition,
and final model-selector placement remain open for owner review. Do not deploy this branch.
