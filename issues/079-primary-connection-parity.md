# 079 — Enforce Connection parity for every primary Model connection

## Parent

#70

## What to build

Contract the temporary compatibility seam now that every Agent capability category is proven
through the ChatGPT-subscription path. A primary Model connection is either able to complete
Veduta's structured AgentRunner tool contract or unavailable for primary routing; provider, model,
and authorization method never select a smaller tool registry. Explicitly tool-less calls remain
selected by call purpose.

Remove the provider-specific tool capability from protocol and adapter metadata, routing helpers,
AgentRunner filtering hook, and PWA copy for a connected-but-limited method. Update fakes, tests,
durable references, and superseded documentation so the old capability cliff no longer exists.
Keep authorization, refresh, catalog, verification, revocation, connection lifecycle, selectors,
visible state, and Test model unchanged.

Complete the provider-parity contract suite by driving the same multi-step AgentRunner scenarios
through BYOK/fake and Codex/fake. Allowed definitions, valid calls, handler execution, results,
final text, session entries, normalized events, and persistent effects must match apart from
provider metadata; the hardened transport's failure matrix remains part of the contract.

## Acceptance criteria

- [ ] `vedutaTools`, `isTextOnly`, `toolsEnabledForModel`, and the PWA subscription capability
      notice no longer exist in production contracts, routing, UI, fakes, tests, or active docs.
- [ ] Every primary-routable adapter supplies the structured AgentRunner tool contract; an adapter
      that cannot do so is unavailable rather than connected with fewer Agent capabilities.
- [ ] Provider-parity tests prove equivalent definitions and persistent outcomes for Surface
      authoring, Space memory, Templates, Automations, Worker spawn, and trust-wrapped actions.
- [ ] Sequential calls, handler errors, malformed arguments, unknown tools, duplicate ids, abort,
      timeout, capability/version drift, and unknown additive response fields remain covered.
- [ ] Explicitly tool-less calls are selected only by call purpose, while connection lifecycle,
      selectors, failover policy, Test model, and existing BYOK behavior remain unchanged.
- [ ] `pnpm check` passes.

## Blocked by

- #74
- #75
- #76
- #77
- #78
