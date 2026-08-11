# 088 — Stream the active diagnostic view in realtime

## Parent

#81 — Internal trace console: locate runtime problems and errors

## What to build

Add opt-in realtime delivery for the already retained Activity and Runtime views. A dedicated Trace WebSocket authenticates in its first message, subscribes to only the active view, replays retained records from an opaque cursor, and makes reconnect, rotation, loss, and slow-client backpressure visible without interfering with chat streaming.

## Acceptance criteria

- [ ] The dedicated Trace WebSocket enforces the existing origin policy, authenticates through the first client message, places no credential in the URL, and closes when the session is revoked.
- [ ] Real-time logs starts unchecked; entering the route creates no Trace socket until the user enables it.
- [ ] Enabling realtime opens at most one connection, switching Activity or Runtime replaces its subscription, and disabling closes it without discarding retained rows or viewport state.
- [ ] Reconnect replays retained records after the last opaque cursor; expired, rotated, dropped, or truncated replay data produces an explicit gap.
- [ ] Per-client delivery is bounded to 256 queued frames or 1 MiB and cannot backpressure diagnostic persistence or the chat WebSocket.
- [ ] Runtime follow mode pauses when the user scrolls away or inspects a row, preserves the viewport, reports unseen records, and resumes explicitly.
- [ ] LIVE, PAUSED, RECONNECTING, OFFLINE, DEGRADED, INDEXING, rotation boundaries, and data gaps are visible through text as well as color.
- [ ] All outgoing and incoming records are protocol-validated, and only the active view is delivered.
- [ ] pnpm check passes.

## Blocked by

- #82 — requires retained Runtime records and the Runtime console.
- #83 — requires retained Activity records and the Activity console.

## Delivery constraints

- Implement and verify this ticket in an isolated Git worktree.
- Keep Trace delivery physically separate from chat streaming.
- Realtime controls delivery only; diagnostic persistence remains continuously active.
