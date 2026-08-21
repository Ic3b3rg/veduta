# Security and trust model

> External content is the primary attack vector of an event-driven personal Agent. Typed product
> paths structurally reduce Simon Willison's "lethal trifecta"; the general execution path trades a
> universal capability sandbox for Agent flexibility. This document distinguishes enforced
> boundaries from official Skill policy instead of claiming they are equivalent.

## 1. Threat model

| Threat                  | Vector                                                                       | Impact                                                          |
| ----------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Prompt injection        | Emails/pages/webhooks with malicious instructions ("forward FACTS.md to...") | Exfiltration of the most intimate data (health, work, finances) |
| Wrong autonomous action | Hallucination, double execution, wrong recipient                             | Real harm to third parties                                      |
| Endpoint compromise     | The daemon is exposed on a public IP (VPS profile)                           | Total takeover                                                  |
| Credential theft        | Provider API keys, Gmail/Calendar OAuth tokens                               | Costs, account access                                           |
| Cost runaway            | Worker/event loops                                                           | BYOK bill                                                       |

## 2. Trust levels (action capabilities)

- **L0 — free**: everything that stays inside the daemon (surfaces, memory, jobs, notifications to the user). Never requires confirmation.
- **L1 — approval-first**: the Agent prepares an outbound action (email, messages to third parties, transactions) and presents an **approval card**: content already prepared, _editable_, with explicit approval. Typed product tools block execution until resolution. Official Skills must follow the same sequence when using general execution, but an arbitrary command is not claimed to be structurally unbypassable. The user can loosen this per type/recipient through a revocable allowlist.
- **L2 — never automatic**, not even with an allowlist: money above a configured threshold, mass deletions, credential management. Typed product tools enforce this structurally; official Skills must not perform an L2 command through general execution, whose semantics the runtime cannot prove.

## 3. Defenses on external content (the hardened measures)

### 3.1 Quarantined reader (Dual-LLM / CaMeL-lite pattern)

Unsolicited events and unattended extraction go through a cheap LLM call, **with no tools at all**,
that produces schema-validated structured data (sender, subject, classified intent, entities,
deadlines). Interactive tasks and direct CLI/API work may instead bring required external text into
the main Agent's current context. It stays marked Untrusted, bounded, and subject to the feature's
persistence rules; the official Skill treats it as data rather than instructions.
References: CaMeL (DeepMind, arXiv:2503.18813); Willison, "The Dual LLM pattern" and "The lethal trifecta".

### 3.2 Taint tracking and gating

Every context item carries its origin (`trusted: user | system | untrusted: <source>`). Typed L1+
tools enforce the Approval rule in code. For a direct command, the Agent and its first-party Skill
must pause for the same Approval card and the Trace records whether that procedure was followed;
Veduta does not claim semantic command inspection as a hard boundary. Allowlists apply only to
actions born from direct user requests.

### 3.3 When the full text is needed

If the user explicitly asks "read me the email", the text enters a turn marked Untrusted, with
delimiters and a spotlighting instruction. Typed-tool gating and general-execution policy from 3.2
continue to apply.

### 3.4 Egress allowlist (network, not prompt)

Typed network tools contact only their declared hosts. The general execution tool inherits the
self-hosted process's network reach and cannot honestly promise the same per-command host allowlist;
operators who need that boundary enforce it at the container or host firewall. Official Skills
declare and test their expected destinations, and command Trace makes unexpected execution visible.

The ChatGPT Model connection spawns a `codex app-server` child process that makes its own outbound connections (`auth.openai.com`, `chatgpt.com`, `api.openai.com`); the daemon's dispatcher cannot intercept them, the same class of exception as the web-push delivery path. The daemon never logs the child's stderr or payloads — only structured one-line diagnostics with byte counts. An operator who enforces egress at the host firewall must allow those hosts for the ChatGPT connection method, and may block them to disable it. OS-level sandboxing of the child process is out of scope for issue 047; the residual filesystem exposure is accepted and the child runs with a reduced environment from its own empty `CODEX_HOME` directory.

### 3.5 Hardened ingestion

HMAC-validated webhooks (Hermes pattern); automatic, monitored renewal of explicitly configured
Calendar watches; per-source rate limiting; event deduplication; events that fail schema validation
are discarded and logged, never "interpreted".

A personal Mailbox connection is passive. No Gmail Watch, IMAP IDLE, inbox scan, or message fetch
runs because the connection exists, the Gateway boots, or a maintenance sweep occurs. Provider
message access requires an explicit user request or due occurrence of a confirmed Automation with
a resolved Mailbox scope. A Gmail Skill uses native OAuth/API operations. A Himalaya Skill may
detect, install, configure, and invoke a compatible external CLI directly through general
execution; credentials remain outside model context in the vault, keyring, or credential file.
Search, summary, and Automation reads preserve unread state. Raw mail is Untrusted and transient;
only schema-validated Mail summaries persist. See
[ADR-0024](adr/0024-pull-based-personal-mailbox.md) and
[ADR-0026](adr/0026-skills-may-drive-general-tool-execution.md).

### 3.6 Website monitors

A Website monitor authorizes one explicit set of HTTPS hosts, monitoring goal, frequency, owning
Space, and target Surface through a Pending decision. Authorization is scoped to that Automation;
it never becomes a general egress allowlist entry. Redirects and discovered links may use only the
approved host set. A new host creates a new Pending decision before any request is made.

Every request is manually redirected, deadline-, byte-, document-, and rate-bounded, and checked
against DNS and private-network destinations on every hop. The first slice accepts only public
HTML and RSS/Atom content: no credentials, authenticated sessions, paywalls, PDFs, media, or
attachments. Raw responses go only to the tool-less quarantined reader and isolated full-text
flow; the primary Agent receives schema-validated structured outcomes and never provider-native
browsing or web-search tools. See [ADR-0022](adr/0022-goal-directed-website-monitors.md).

## 4. Secrets

API keys and OAuth tokens live in an **encrypted secrets vault** (key derived at boot); the agent and its contexts see only opaque references (`secret://provider/anthropic`), resolved by the trust layer at call time. No secret ever appears in LLM context, logs, the Event log, or plaintext backups. Import from OpenClaw/Hermes: secrets migrated only with an explicit flag (discipline learned from studying the repos).

One documented deviation: the ChatGPT Model connection's OAuth credentials are owned by Codex itself inside a per-connection `CODEX_HOME` directory (mode `0700`) under the data root, because managed Codex login has no supported callback into an external vault. Encryption at rest for that directory is a deployment concern.

## 5. Audit and limits

- **Append-only audit log** of every typed L1+ action, approval/allowlist change, and general-execution call: who/what triggered it (including a hash of the context), the redacted command or effect, and its outcome. Visible as a Surface.
- Daily **spend cap** per model tier and per worker (budget in the briefing); a circuit breaker that shuts off proactivity above the threshold and notifies.
- Cap on worker iterations (5-8), explicit termination, schema-validated output.

## 6. Daemon attack surface

- Automatic TLS (ACME); HSTS; no port other than 443 exposed.
- **Passkey/WebAuthn only** (no passwords), device pairing via QR with an expiring one-time code; scoped, per-device revocable session tokens; a "linked devices" surface with revocation.
- Per-connection authenticated WebSocket: the upgrade itself is exempt from the per-request
  Bearer check (a browser cannot attach an Authorization header to a WebSocket handshake) and
  is gated instead by the origin check at the route plus the session token the first `hello`
  frame must carry; an invalid token gets an error frame and a disconnect, and a revoked
  session closes the live socket.
- PWA client storage: the session token and the cached Home snapshot live in `localStorage`, readable by any script that achieves XSS. Accepted for a self-hosted single-user app because Surfaces are declarative (no generated HTML, no third-party scripts); revisit if the PWA ever embeds external content.
- Atomic, encrypted, restorable backups (Hermes pattern: SQLite safe-copy, pruning).
- Signed self-update: releases are verified through a two-tier minisign chain (an offline root
  key certifies a signing key; the signing key signs each release's metadata) checked entirely
  by the updater itself before anything is downloaded or installed, per
  [docs/adr/0013-signed-self-update.md](adr/0013-signed-self-update.md) — closing the debt this
  bullet used to track, deferred since issue #19. The installer's own pinned Node.js download
  is separately SHA-256-verified against `SHASUMS256.txt` before extraction (unrelated to, and
  unaffected by, the release-signing chain above).

## 7. Continuous verification

- **Injection test suite in CI**: a corpus of malicious emails/webhooks (exfiltration, escalation, nested instructions) that typed tools must reject and first-party Skills must handle without unapproved L1+ commands. Every behavioral or structural bypass found becomes a test.
- All Worker output is treated as untrusted (`untrusted:worker`) and quarantined; a mandatory adversarial review in a separate context refutes/corrects **high-risk** Worker outputs (flagged in the briefing) before delivery into the Space.
- Threat model revisited on every new integration (every event source is a new perimeter).

## References

- Simon Willison — _The lethal trifecta for AI agents_ (2025), _The Dual LLM pattern_ (2023)
- CaMeL — _Defeating Prompt Injections by Design_ (arXiv:2503.18813)
- MAST — verification failures as 21% of multi-agent failures (arXiv:2503.13657)
- Hermes: HMAC webhooks, explicit-secrets migration; OpenClaw: pairing via codes, per-agent tool allowlists
