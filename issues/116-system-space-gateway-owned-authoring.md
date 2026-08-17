# 116 — Restrict System Space authoring to Gateway-owned paths

## Parent

#63

## What to build

Enforce the System Space's Gateway-only content ownership across Agent tools and System-scoped chat.

An Agent turn scoped to the System Space remains conversational, but its tool registry contains only safe status reads and explicit Gateway operations. It cannot create an ordinary Surface, patch Surface content generically, write FACTS or INSTRUCTIONS, author Automations, or otherwise use the System Space as a user life area. Requests for personal content must visibly direct the user to an appropriate life-area Space.

User interactions offered by daemon-owned Surfaces remain available through their declared actions and explicit product operations. Pinning and ordering are presentation preferences, not content authorship, and remain allowed through their existing validated and evented paths.

## Acceptance criteria

- [ ] Every Agent authoring inventory excludes all Surfaces in the canonical System Space, regardless of title or daemon-owner metadata.
- [ ] A System-scoped turn cannot invoke ordinary Surface creation or patching, FACTS or INSTRUCTIONS writes, or Automation authoring.
- [ ] A System-scoped turn can read safe system status and invoke only explicitly registered Gateway operations.
- [ ] Requests to store personal content receive a visible redirect toward a user life-area Space rather than silently writing or changing scope.
- [ ] Actions declared by daemon-owned System Surfaces continue through their normal validated fast or Agent path.
- [ ] Pinning and ordering System Surfaces remain allowed and evented.
- [ ] Focused tool-exposure, rejected-write, scoped-chat, and allowed-operation tests plus the full repository gate are green.

## Blocked by

- #113
