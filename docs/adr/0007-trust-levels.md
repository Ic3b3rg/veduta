# Three trust levels + dual context for external content

Agent actions are classified: **L0** free (inside the daemon), **L1** approval-first toward the outside (editable approval card; per-type/recipient allowlist that can be loosened and revoked), **L2** never automatic (money above threshold, destructive, credentials). External content enters only through a **quarantined reader** (a cheap LLM with no tools → schema-validated structured output; the raw text never reaches the Agent that holds the tools) and is marked untrusted: a turn with untrusted content **cannot** execute L1+ without a card, even with an allowlist — a rule enforced by code, not by the prompt.

Rationale: the event-driven architecture brings attacker-controlled content (email, webhooks) into the system; prompt injection cannot be blocked 100% via the prompt, so the defense is structural (Willison's lethal trifecta, CaMeL arXiv:2503.18813). Operational details: `docs/SECURITY.md`.

Status: accepted

## Consequences
- Allowlists apply only to actions born from direct user requests: automated flows over external content always carry one extra thread of friction. A deliberate choice.
- Every new integration is a new perimeter: the threat model must be revisited, and the injection test suite in CI extended.
