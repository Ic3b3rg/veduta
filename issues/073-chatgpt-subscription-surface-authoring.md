# 073 — Create and patch Surfaces through a ChatGPT subscription

## Parent

#70

## What to build

Make the hardened ChatGPT-subscription adapter eligible to power focused-Space Agent turns and
pass exactly the turn's existing Space- and origin-gated tool registry into Codex dynamic tools.
Keep global chat's no-Space behavior unchanged; issue #136 owns global multi-Space work.

Deliver the first user-visible parity path: in an existing Space, a subscription turn creates a
protocol-valid Surface, streams a short confirmation into the PWA, and a follow-up turn patches
typed state. Use the existing compatibility capability as a temporary expand-contract seam; the
final contract slice removes it after all AgentRunner categories migrate.

Session entries, normalized tool events, Surface provenance, and the Space Event log must match
equivalent BYOK behavior apart from provider metadata. Update the Local VPS manual smoke and
record a real no-provider-key ChatGPT run when an authorized account is available. Do not change
authorization, lifecycle, selectors, visible connection state, or the Test model.

## Acceptance criteria

- [ ] A deterministic Gateway/PWA scenario selects a ChatGPT subscription, calls
      `create_surface`, renders the protocol-valid Surface live, and streams assistant text.
- [ ] A follow-up turn calls `patch_state`; the PWA updates live and both Surface states validate
      against the protocol.
- [ ] Codex receives exactly the Space- and origin-gated `ToolDef`s for each focused turn, with no
      provider extras or global-chat expansion.
- [ ] Session entries, normalized tool events, Surface provenance, and Space Event log entries
      match the equivalent BYOK flow apart from provider metadata.
- [ ] The Local VPS smoke documentation covers the create-and-patch path and records a real run
      when credentials are available; authorization, lifecycle, selectors, visible connection
      state, and the Test model remain unchanged.

## Blocked by

- #72
