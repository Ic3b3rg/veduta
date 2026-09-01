# A PWA live-state runtime owns client authority outside React

The direct Gateway-to-PWA transport established by ADR-0028 has one client lifecycle, but its live
authority is currently distributed across the top-level React component, transport callbacks,
effects, refs, caches, and feature controllers. Reconnect replay, HTTP and WebSocket races, queued
work, and snapshot recovery therefore lack one owner, while rendering concerns can accidentally
become a second state machine.

One React-independent **PWA live-state runtime** therefore owns connection startup and shutdown,
authentication hello, stable client identity, retry backoff, replay cursors, validated inbound
frames, snapshot recovery, buffers, caches, outbound retry queues, and reconciliation of the live
client projection. It exposes immutable application snapshots through a subscription boundary and
accepts typed user commands. React owns routes, rendering, focus, motion, accessibility, and local
presentation drafts, but never parallel authority for runtime cursors, queues, buffers, or live
domain state.

The runtime preserves the existing daemon-to-PWA wire contract and user-visible behavior. It is a
deep module for the concrete PWA transport, not a generic provider Adapter, messenger Bridge, or
shared transport abstraction. Gateway-owned durable Chat timelines remain governed by ADR-0029;
the runtime may project and reconcile their live client state without becoming their durable
authority.

Keeping the live state distributed through React callbacks was rejected because every new feature
widens event-specific seams and makes lifecycle ownership harder to test. A parallel reducer or
cache beside existing React authority was rejected because two projections cannot deterministically
own recovery. A generic PWA/Bridge adapter was rejected because ADR-0028 deliberately postpones a
Bridge seam until a concrete messenger integration supplies real requirements.

Implementation is tracked by issue #155 and must preserve clean-data reconnect, multi-session,
queued-work, malformed-frame, and session-revocation behavior while moving authority.

Status: accepted
