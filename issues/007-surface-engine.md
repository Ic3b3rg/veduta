# 007 — Surface engine (daemon side)

## Context
[ADR-0003](../docs/adr/0003-declarative-atoms.md): tree+state+bindings; deterministic fast path.

## Goal
The engine that owns Surface state and applies patches from the Agent and from the user.

## Tasks
- Surface store (SQLite): tree, typed state, version, freshness metadata (`updatedAt`, `updatedBy: agent|user|job`)
- Tools for the Agent: `create_surface`, `patch_state`, `patch_tree`, `archive_surface` — with `protocol` validation on every write
- **Fast path**: endpoint that receives a `fast` action from an Atom → mutates the state → `append_event` in the Space → broadcasts the patch to clients. Zero LLM in the path. Idempotency for double taps
- **Agent path**: `agent` actions enqueue a turn for the Agent with context (Surface, Atom, payload)
- Concurrency: user patches and Agent patches on the same Surface (last-writer-wins per state key + versioning for the tree; tree conflict → the Agent re-reads and re-patches)

## Acceptance criteria
- Tap on a checkbox: state mutated + event logged + patch received by the client, p95 < 100ms, zero LLM calls (assert on a counter)
- An `agent` action produces a turn with the correct reference to Surface/Atom
- 50 concurrent taps from 2 devices converge without losses (stress test)

## Dependencies
002, 004, 006
