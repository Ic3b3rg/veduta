# Security and trust model

> Hardened by explicit request: external content is the primary attack vector of an event-driven personal agent. Core principle (Simon Willison's "lethal trifecta"): **never combine in the same context (1) private data, (2) untrusted content, (3) exfiltration capability**. The entire architecture below exists to ensure the trifecta never comes true.

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
- **L1 — approval-first**: every outbound action (email, messages to third parties, transactions) is born **blocked**. The agent prepares the action and presents an **approval card**: content already prepared, _editable_, with explicit approval. The user can loosen this per type/recipient (revocable allowlist, managed from a dedicated surface — the exec-approvals pattern from Hermes/OpenClaw).
- **L2 — never automatic**, not even with an allowlist: money above a configured threshold, mass deletions, credential management.

## 3. Defenses on external content (the hardened measures)

### 3.1 Quarantined reader (Dual-LLM / CaMeL-lite pattern)

Raw external text **never enters the main agent's context**. Every external event goes through a cheap LLM call, **with no tools at all**, that extracts schema-validated structured data (sender, subject, classified intent, entities, deadlines). Only the structured output — not the text — reaches the agent. An instruction injected into the email can at most corrupt data fields, not steer the agent that holds the tools.
References: CaMeL (DeepMind, arXiv:2503.18813); Willison, "The Dual LLM pattern" and "The lethal trifecta".

### 3.2 Taint tracking and gating

Every context item carries its origin (`trusted: user | system | untrusted: <source>`). Hard rule, enforced by the trust layer (code, not prompt): **a turn whose context contains untrusted content cannot execute L1+ actions without an approval card, even if the allowlist would permit it**. Allowlists apply only to actions born from direct user requests.

### 3.3 When the full text is needed

If the user explicitly asks "read me the email", the text enters a turn marked untrusted, with delimiters and a spotlighting instruction — and the gating from 3.2 stays active. Convenience never disables gating.

### 3.4 Egress allowlist (network, not prompt)

The daemon can contact **only declared hosts**: configured LLM providers, endpoints of active integrations, push service. Every tool declares the domains it uses; everything else is denied at the network level. A successful injection still has nowhere to exfiltrate to.

### 3.5 Hardened ingestion

HMAC-validated webhooks (Hermes pattern); automatic, monitored renewal of Gmail/Calendar watches; per-source rate limiting; event deduplication; events that fail schema validation are discarded and logged, never "interpreted".

## 4. Secrets

API keys and OAuth tokens live in an **encrypted secrets vault** (key derived at boot); the agent and its contexts see only opaque references (`secret://provider/anthropic`), resolved by the trust layer at call time. No secret ever appears in LLM context, logs, the Event log, or plaintext backups. Import from OpenClaw/Hermes: secrets migrated only with an explicit flag (discipline learned from studying the repos).

## 5. Audit and limits

- **Append-only audit log** of every L1+ action and every approval/allowlist change: who/what triggered it (including a hash of the context), what was sent, outcome. Visible as a surface.
- Daily **spend cap** per model tier and per worker (budget in the briefing); a circuit breaker that shuts off proactivity above the threshold and notifies.
- Cap on worker iterations (5-8), explicit termination, schema-validated output.

## 6. Daemon attack surface

- Automatic TLS (ACME); HSTS; no port other than 443 exposed.
- **Passkey/WebAuthn only** (no passwords), device pairing via QR with an expiring one-time code; scoped, per-device revocable session tokens; a "linked devices" surface with revocation.
- Per-message authenticated WebSocket, origin check for the PWA.
- Atomic, encrypted, restorable backups (Hermes pattern: SQLite safe-copy, pruning).
- Signed updates; the installer verifies checksums.

## 7. Continuous verification

- **Injection test suite in CI**: a corpus of malicious emails/webhooks (exfiltration, escalation, nested instructions) that must produce zero ungated L1+ actions. Every bypass found becomes a test.
- Mandatory adversarial review (separate context) on worker outputs before delivery.
- Threat model revisited on every new integration (every event source is a new perimeter).

## References

- Simon Willison — _The lethal trifecta for AI agents_ (2025), _The Dual LLM pattern_ (2023)
- CaMeL — _Defeating Prompt Injections by Design_ (arXiv:2503.18813)
- MAST — verification failures as 21% of multi-agent failures (arXiv:2503.13657)
- Hermes: HMAC webhooks, explicit-secrets migration; OpenClaw: pairing via codes, per-agent tool allowlists
