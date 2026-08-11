# 083 — Follow a retained chat Trace through Activity

## Parent

#81 — Internal trace console: locate runtime problems and errors

## What to build

Add the Activity side of the hidden diagnostic console for one accepted chat turn. The Gateway generates and propagates a server-owned traceId, retains start and terminal lifecycle records, indexes searchable metadata, and exposes authenticated search and detail reads. The PWA lets the user find the chat Trace, understand whether it is RUNNING, COMPLETED, or ERROR, and inspect its observed lifecycle after a restart. Nested model, tool, Surface, and Event log steps are delivered by a later ticket.

## Acceptance criteria

- [ ] Every accepted chat turn receives server-generated Trace and step identifiers; client input cannot choose or override them.
- [ ] Root lifecycle recording preserves the observed result or error, never fails the chat path, bounds its queue, and exposes queue loss or sink failure as an explicit gap or DEGRADED state.
- [ ] Activity JSONL rotates at 5 MiB and retains at most 30 days or 200 MiB with 0700 directories, 0600 files, active-segment preservation, and visible partial-line gaps.
- [ ] A disposable SQLite index supports newest-first pagination, plain-text search, and time, Space, session, component, status, and traceId filters while validating every result against its retained JSONL source.
- [ ] Deleting, corrupting, truncating, or restoring the disposable index rebuilds or degrades safely and never returns a different retained record.
- [ ] Authenticated, no-store Activity and Trace-detail reads are bounded and reveal neither filesystem paths nor credentials.
- [ ] Activity renders dense rows, accessible RUNNING/COMPLETED/ERROR indicators, simple filters, a minimal selected-Trace inspector, visible unknown additive event families, and no invented optional values.
- [ ] The route remains hidden and read-only; realtime remains disabled and no Trace WebSocket is introduced by this ticket.
- [ ] A retained chat Trace remains searchable and readable after a normal Gateway restart.
- [ ] pnpm check passes.

## Blocked by

- #82 — reuses its sanitization, segmented persistence, authenticated console shell, and retained diagnostic read boundary.

## Delivery constraints

- Implement and verify this ticket in an isolated Git worktree.
- Preserve ADR-0017: Trace data is bounded, redacted, non-canonical, and fail open.
- Store references to session entries rather than duplicating complete transcripts, system prompts, or model context.
