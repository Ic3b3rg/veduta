# Research 05 — Alternatives to heartbeat polling for proactivity

> Conducted on 2026-07-03 on request ("is polling the only way?"). Validates [ADR-0005](../adr/0005-event-driven-proactivity.md).

## Verdict

The polling Heartbeat + LLM triage is a legitimate baseline but **not optimal**: LLM polling is right only for conditions that events cannot express. For everything else there is a better architecture on both cost AND latency: **push events + one-shot timers + deterministic pre-filters, with the Heartbeat reduced to 1-2x/day**. The key paper ([arXiv:2605.30152](https://arxiv.org/pdf/2605.30152), "Do Proactive Agents Really Need an LLM to Decide When to Wake?") shows that a small model on structured events, in place of the LLM in the wake decision, delivers **+16.7 F1** and is **4-83x faster** (~11-14 ms, 220 MiB, runs on the VPS). LLM triage every 30 minutes is not just more expensive: it is _less accurate_.

## 4-level hybrid design (adopted)

**L0 — Push events (cost ~0, latency 1-10 s).** Gmail `users.watch` via Pub/Sub (renewal ≤7 days, daily recommended; 1 event/sec/user), Calendar `events.watch`, IMAP IDLE, generic webhooks → local queue (SQLite/Redis).

**L1 — One-shot timers instead of periodic checking.** When the agent learns a deadline/habit, it arms a timer that checks the condition at the deadline (`weight logged? no → escalation`). The Chronos (Nous) pattern: one-shots that re-arm at the next real fire. On an always-on VPS scale-to-zero is irrelevant: the timers replace the _periodic LLM reasoning_, not the process.

**L2 — Non-LLM pre-filter (ms, cost ~0).** Trigger-action rules (sender whitelist, discard newsletters), embedding similarity (~100-1000x cheaper than a generative call), optional SLM/classifier. Evidence: FrugalGPT (cascade with confidence gating, up to **−98% cost**, arXiv:2305.05176); ProAgent (layered perception + similarity-based dedup: **0.25x tokens**, +33% proactive accuracy, arXiv:2512.06721).

**L3 — LLM cascade on the residue** (cheap → strong triage) + a residual Heartbeat 1-2x/day with a checklist for the fuzzy conditions. Interruption timing: poorly timed notifications get dismissed (CHI 2025, doi:10.1145/3706598.3713357) → queue the non-urgent ones for break moments.

## Numbers

Baseline: 48 wakes/day × ~5-10k tokens ≈ $0.3-1/day ($10-30/month), almost all spent on "nothing to report". With events+pre-filters: −90-98% LLM calls, reaction time from a 15-minute average to **seconds**.

## What Hermes/OpenClaw already do

Both have the event-driven building blocks: OpenClaw has webhooks on the gateway + lifecycle hooks + one-shot crons (the Heartbeat is recommended only for batch monitoring); Hermes has a webhook adapter with HMAC, Event Hooks, Chronos; a declared direction toward event-driven (issue #491). Their Heartbeat is the safety net, not the engine — we adopt that as a principle from day one.

## Sources

- https://arxiv.org/pdf/2605.30152 · https://arxiv.org/html/2512.06721v1 (ProAgent) · https://arxiv.org/abs/2305.05176 (FrugalGPT)
- https://arxiv.org/pdf/2606.03236 (Perceive Before Reasoning) · https://arxiv.org/pdf/2605.24900 (ProActor, ACL 2026) · https://arxiv.org/pdf/2605.25971 (Anticipate and Learn)
- https://developers.google.com/workspace/gmail/api/guides/push · https://docs.openclaw.ai/automation · https://hermes-agent.nousresearch.com/docs/user-guide/messaging/webhooks · https://dl.acm.org/doi/10.1145/3706598.3713357
- LangChain ambient agents: https://snowplow.io/blog/what-are-ambient-agents
