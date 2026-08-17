# 078 — Spawn Workers through a ChatGPT subscription

## Parent

#70

## What to build

Complete the Worker path through a selected ChatGPT Model connection. A focused-Space chat turn
calls `spawn_worker` through `PiAgentRunner` and returns immediately; the spawned Worker then runs
in its isolated session through the same subscription transport, using only its existing read-only
L0 registry and budget before delivering a protocol-valid report Surface.

Preserve Worker provenance, spend attribution, cancellation, retry boundaries, and asynchronous
delivery. High-risk adversarial review remains a fresh explicitly tool-less call selected by call
purpose, not by provider or authorization method. Compare the whole spawn-and-report outcome with
BYOK/fake.

## Acceptance criteria

- [ ] A deterministic ChatGPT-subscription chat turn invokes `spawn_worker` exactly once and
      receives the asynchronous Worker identity without blocking the chat response.
- [ ] The Worker runs through the selected subscription connection in an isolated session and can
      use only its existing read-only L0 ToolDefs.
- [ ] The delivered report is a protocol-valid Surface with the same `untrusted:worker`
      provenance, budget/spend records, and Space Event-log behavior as the BYOK scenario.
- [ ] A high-risk briefing uses a fresh tool-less review chosen by call purpose; no
      provider-specific tool filter or provider-native tool becomes available.
- [ ] Abort, budget exhaustion, and failure cannot replay Worker spawn or leak Worker state into
      the focused-Space chat session.
- [ ] `pnpm check` passes.

## Blocked by

- #39
- #73
