# A concrete Bridge defines the messenger extension seam

The PWA is Veduta's primary visual client and has a transport lifecycle unlike a messenger. The
current `ChannelAdapter` predates any real Bridge: the Gateway still owns authentication, sessions,
reconnect replay, presence, multi-device fan-out, and web push directly, while the adapter adds a
second connection registry and is not a substitutable Gateway boundary.

The Gateway therefore owns the PWA HTTP and WebSocket lifecycle directly and does not retain a
generic channel transport interface in anticipation of future providers. The first concrete
messenger Bridge project must introduce an extension seam for later messenger Bridges, shaped by
that provider's real requirements and Veduta's existing channel-neutral application contracts. It
does not require the PWA and a Bridge to implement the same connection lifecycle or wire protocol.

The committed Bridge baseline is bidirectional text, notifications, and deep links to the Home.
Provider-native rich projections of Surface Atoms are deferred, do not block that baseline, and
remain prohibited under the current architecture. Separate research and an accepted architectural
decision must define their state ownership, capability mapping, and interaction semantics before
implementation.

Keeping a speculative transport interface was rejected because one production implementation
cannot demonstrate an honest common contract. Forcing the PWA and messengers through one transport
was also rejected because it would encode their differences as leaks in the interface. Permanently
excluding provider-native views was rejected as premature, but no such capability is promised by
this decision.

This supersedes [ADR-0008](0008-vps-passkey-byok.md)'s requirement that the Gateway be born with
`ChannelAdapter` and its permanent exclusion of rich Bridge content. Bidirectional text,
notifications, and Home deep links remain the current guarantee; this decision does not authorize
provider-native rich projections.

Status: accepted
