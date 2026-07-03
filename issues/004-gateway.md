# 004 — Gateway: WS/HTTP, ChannelAdapter, client sessions

## Context

[ADR-0008](../docs/adr/0008-vps-passkey-byok.md): PWA as the primary client, but the Gateway is born adapter-ready for future messenger Bridges.

## Goal

The daemon that serves the PWA and owns the client connections.

## Tasks

- HTTP server (PWA static assets + API) and typed WebSocket (schema in `protocol`): Surface sync (patch push), chat streaming, approval cards, presence
- `ChannelAdapter` interface (`connect/disconnect`, `sendShort`, `onMessage` → normalized event) with the PWA as the only v1 adapter; contract: non-PWA adapters reply briefly and link to the Home (deep link)
- Reconnection with replay (patches lost between disconnections are reapplied from a cursor)
- Multi-device handling: same Surfaces, broadcast patches

## Acceptance criteria

- Two connected browsers see the same Surface patch within 200ms of each other
- A client reconnecting after 10 minutes offline converges without a full reload
- A test `FakeChannelAdapter` passes the same contract suite as the PWA

## Dependencies

001, 002
