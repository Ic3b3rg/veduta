# 075 — Read and write Space memory through a ChatGPT subscription

## Parent

#70

## What to build

Give a ChatGPT-subscription turn the same gated Space-memory behavior as BYOK. Exercise durable
FACTS writes, Event log reads and searches, and Retrieval through the shared ToolDefs and the
existing AgentRunner execution boundary. Preserve each result's origins so later calls in the same
turn see the correct live taint, and preserve the write origin derived from that live taint.

Use one provider-parity scenario to compare offered definitions, handler results, normalized
events, session entries, and persistent Space outcomes. The adapter must remain unaware of FACTS,
Retrieval, provenance, and Event log storage.

## Acceptance criteria

- [ ] Codex/fake and BYOK/fake receive equivalent gated definitions for FACTS writes, Event log
      reads/searches, and Retrieval in the same focused Space.
- [ ] A deterministic subscription turn writes a durable FACT, reads it through the normal
      Space-memory path, and produces the same persisted record and session/tool chain as BYOK.
- [ ] Event log and Retrieval results retain their original origins, grow live taint identically,
      and never become provider-authored instructions.
- [ ] A later write after an Untrusted read receives the same derived origin through either Model
      connection method.
- [ ] Memory handlers execute only through `PiAgentRunner`, exactly once per accepted call id.

## Blocked by

- #73
