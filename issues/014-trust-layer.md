# 014 — Trust layer: L0/L1/L2 levels, approval cards, allowlists, audit

## Context

[ADR-0007](../docs/adr/0007-trust-levels.md), [SECURITY.md §2, §5](../docs/SECURITY.md).

## Goal

Every outbound action goes through a code layer (not a prompt layer) that decides: allowed, card, or denied.

## Tasks

- Action registry: every `ToolDef` declares its level (L0/L1/L2) and its egress domains; default L1 for everything that leaves the daemon
- **Approval card**: a Surface with the action already prepared (e.g. a drafted email), editable, approve/reject; expiry; the outcome returns to the Agent as an event
- Allowlists: per action type + recipient/parameters, creatable only from an explicit approval ("from now on approve them like this"), revocable from a dedicated Surface
- **Taint gating** (enforced in the layer, not in the prompt): a turn with untrusted context → L1+ always via card, allowlist ignored; L2 never automatic, ever
- Append-only audit log (SQLite): action, level, trigger (with origin), content sent, outcome, approval; a Surface for browsing it

## Acceptance criteria

- "Reply to my wife that I'm on my way" (direct request, active allowlist) → sent without a card; the same action triggered by an incoming email → mandatory card
- An L2 action (bank transfer above the threshold) stays behind a card even with an allowlist that would match
- Every executed L1+ action is in the audit log with the complete trigger chain

## Dependencies

007, 013
