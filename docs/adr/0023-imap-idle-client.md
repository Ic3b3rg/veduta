# IMAP IDLE uses a maintained protocol client behind a Veduta-owned adapter

Non-Google mailbox ingestion uses the pinned MIT-licensed `imapflow` client rather than a
Gateway-owned IMAP parser. IMAP servers are an untrusted protocol boundary with literals,
continuations, authentication negotiation, extension differences, and long-lived IDLE state. The
library already owns TLS, `LOGIN`/`AUTHENTICATE`, selected-mailbox events, bounded response parsing,
and automatic IDLE restart through `maxIdleTime`. Its current changelog also records active parser,
command-injection, STARTTLS, teardown, and IDLE hardening. Reimplementing that state machine inside
Veduta would create a security-sensitive second implementation with no product-specific benefit.

The accepted version is `imapflow` 1.6.5. Its API documentation defines direct TLS, the three
supported password authentication methods, `maxIdleTime`, selected-header fetches, `exists`, and
the explicit absence of automatic reconnect:

- <https://imapflow.com/docs/api/imapflow-client/>
- <https://github.com/postalsys/imapflow/blob/master/CHANGELOG.md>

Veduta still owns every product boundary. `ingestion.json` contains only the server address and
`secret://` references. Each connection attempt checks the configured host against the active
egress policy before resolving credentials; secrets are resolved at that moment, registered with
the shared redactor, and passed only to the transport constructor. Protocol logging and raw-byte
logging are disabled. The adapter requires TLS 1.2 or newer and the `IDLE` capability, restarts IDLE
after 25 minutes, bounds any response line or literal to 128 KiB, selects `INBOX`, and fetches only
the `From`, `Subject`, `List-Unsubscribe`, and `Precedence` header lines.

Veduta also owns the durable UIDVALIDITY/UID cursor, atomic queue checkpoint, pre-filter handoff,
per-source rate cap, exponential reconnect, and persistent three-strike health alert. Catch-up
fetches are bounded by the source's per-minute quota; a rate-limited batch leaves its cursor in
place and resumes after the rolling window. The client library intentionally does not reconnect on
close, so these behaviors remain visible and testable at Veduta's adapter seam. On its first
connection the adapter checkpoints the current `UIDNEXT` without replaying the existing inbox;
only messages arriving after the source is enabled enter the pipeline. Unit tests use an injected
fake client, while a scripted in-process loopback server drives ImapFlow through AUTHENTICATE,
SELECT, IDLE restart, and FETCH without any external service.

The cost is about 2 MB unpacked and eight transitive runtime dependencies. That cost is accepted in
exchange for a maintained parser at a hostile wire boundary. A hand-written TLS socket and partial
IMAP state machine, polling in place of IDLE, cleartext/optional TLS, and storing credentials or raw
message bodies in ingestion state are rejected.

Status: accepted
