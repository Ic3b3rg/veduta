# Event-driven proactivity: events + timers + pre-filters; heartbeat only as a safety net

The competitor baseline (heartbeat polling every 30 minutes with LLM triage) is beaten on cost **and accuracy**: replacing the LLM in the wake-up decision with classification over structured events improves F1 by +16.7 points and is 4-83x faster (arXiv:2605.30152); cascade patterns cut 90-98% of calls (FrugalGPT, ProAgent). We adopt the principle **"events and timers first, polling as a last resort"**: (1) push events (Gmail/Calendar watch, IMAP IDLE, webhooks); (2) one-shot timers armed on every learned deadline/habit; (3) non-LLM pre-filters; (4) a triage→reasoning cascade only on the residue, with the Heartbeat reduced to 1-2 sweeps/day for fuzzy conditions. Evidence: `docs/references/05-proactivity-architectures.md`.

Status: accepted

## Consequences

- Whenever the Agent learns a deadline it must arm a timer (`arm_timer` tool), not entrust it to the next sweep.
- Timers/jobs are **visible Automations** in the Space, switchable off by the user ("the plus of having a UI").
- Notification discipline: silent → badge → push, per-Space budget, freshness metadata on every Surface.
