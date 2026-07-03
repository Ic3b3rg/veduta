# 010 — Model routing: ModelRef, tiers, failover, BYOK

## Context

[ADR-0002](../docs/adr/0002-single-agent-spaces.md): per-call routing instead of "senior/junior" agents (RouteLLM evidence). BYOK from [ADR-0008](../docs/adr/0008-vps-passkey-byok.md).

## Goal

The router that decides which model serves each call, with failover and spending caps.

## Tasks

- `ModelRef` `{provider, modelId, tier}` with `triage` (cheap) and `reasoning` (strong) tiers; per-tier user configuration (sensible defaults for Anthropic/OpenAI/OpenRouter)
- Usage map: chat turns → reasoning; classifications/mechanical updates/quarantined reader/Heartbeat → triage; Workers → declared in the briefing
- Cross-provider failover: error/timeout → retry on an alternative `ModelRef` with backoff; event logged
- Spending counters per tier/day and per Worker; "usage" Surface (BYOK transparency)
- Provider secrets via the vault (issue 015), never in plaintext in config

## Acceptance criteria

- A chat turn and a triage round use different models (assert on the call log)
- With the primary provider down, the conversation continues on the fallback without intervention
- Once the daily spending threshold is exceeded, proactivity shuts off and the user is notified (the synchronous path stays active)

## Dependencies

003
