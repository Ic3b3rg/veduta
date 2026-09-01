# 155 — Deepen the PWA live-state runtime

## Problem Statement

The PWA currently distributes one live-state machine across the top-level React component,
transport callbacks, refs, effects, caches, and feature-specific controllers. React therefore owns
Gateway connection lifecycle, replay cursors, snapshot refetches, out-of-order buffers, HTTP and
WebSocket reconciliation, outbound retry queues, and Chat streaming alongside navigation and
presentation. These behaviors work, but their authority is difficult to identify and each new live
feature expands an event-specific callback seam.

Issue #139 deliberately makes the PWA a concrete Gateway transport rather than a generic Bridge
adapter. The PWA still needs a deep client module behind that concrete transport: one place that
owns live projection and recovery while React remains the visual shell.

## What to build

Implement
[ADR-0031](https://github.com/Ic3b3rg/veduta/blob/main/docs/adr/0031-pwa-live-state-runtime.md)
by introducing one PWA live-state runtime that owns the complete lifecycle from Gateway frames and
HTTP results to a coherent client snapshot. It owns connection startup and shutdown, authenticated
hello/reconnect behavior, stable client identity, retry backoff, replay cursors, snapshot recovery,
buffering, cache persistence, existing outbound queues, and reconciliation of Surfaces, ordering,
attention, presence, Pending decisions, and the current Chat stream.

Expose a small React-independent interface: subscribe to an immutable application snapshot, read
the current snapshot, and invoke typed user commands. React owns routes, rendering, focus, motion,
local form drafts, and other purely presentational state. It must not keep a second authoritative
copy of runtime cursors, buffers, queues, or live domain projection.

This is a behavior-preserving architectural replacement. It does not introduce a generic transport
Adapter, a messenger Bridge, or the durable Chat timeline from issue #141. It creates the seam on
which those Chat implementation tickets can rely after the current PWA transport has been
simplified.

## Acceptance criteria

- [ ] Exactly one PWA live-state runtime owns Gateway WebSocket lifecycle, authentication hello,
      stable client identity, reconnect backoff, replay cursors, snapshot refetch, buffering, cache
      persistence, and existing outbound retry queues.
- [ ] The runtime owns the authoritative client projection for Spaces, Surfaces, Surface order,
      attention, presence, Pending decisions, and current Chat stream state, including HTTP and
      WebSocket delivery races.
- [ ] React consumes one immutable snapshot/subscription boundary and typed commands; the
      top-level application and route components do not implement live cursors, event buffers,
      reconnect algorithms, or parallel queue authority.
- [ ] Runtime startup and shutdown are explicit and idempotent. React development remounts, route
      changes, session revocation, and unmount cannot create duplicate sockets, timers, handlers,
      submissions, or Surface mutations.
- [ ] Every inbound and outbound boundary remains validated through `@veduta/protocol`. A malformed
      or unresolvable frame produces the existing visible error or deterministic snapshot recovery;
      it never crashes the PWA or disappears silently.
- [ ] HTTP responses, live frames, duplicate delivery, delayed delivery, unknown-Surface buffering,
      reconnect replay, and snapshot replacement converge under one freshness policy without
      regressing issue #45's consecutive one-shot actions.
- [ ] Existing offline behavior remains explicit: cached confirmed state may render, unsupported
      mutations remain refused, and retryable queued work is visible and identity-stable.
- [ ] Focused runtime tests drive connection, race, replay, cache, queue, and recovery behavior
      without rendering React. App-level tests prove React observes snapshots and dispatches typed
      commands without recreating those algorithms.
- [ ] A clean-data browser journey with two authenticated sessions proves live Surface convergence,
      a missed-event reconnect without full reload, session revocation, one queued Chat submission,
      and recovery from a malformed or unresolvable live update.
- [ ] The daemon-to-PWA wire contract and all current user-visible behavior remain unchanged; no
      generic provider or Bridge interface is added.
- [ ] `pnpm check` and the relevant browser E2E job pass.

## Out of scope

- Durable Chat timeline storage, lifecycle recovery, pagination, or legacy Chat-history handling
  owned by issue #141 and its implementation tickets.
- A messenger Bridge, provider-native rich projections, a shared PWA/Bridge transport abstraction,
  or a new daemon wire protocol.
- Surface-commit durability across SQLite and the Event log, new Atom behavior, visual redesign, or
  application-route changes.
- A performance claim or broad code cleanup unrelated to moving existing live-state authority.

## Blocked by

- #45
- #139
