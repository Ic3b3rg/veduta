# User-controlled character is separate from product-owned rules

Veduta keeps `SOUL.md` as the user's global Agent identity and each `INSTRUCTIONS.md` as the user's Space character. Safety, trust, tool-use, memory, Space-granularity, Automation, and other product rules are assembled by the Gateway outside those documents, so changing character never grants authority to change how Veduta operates.

The previous layout mixed identity with product rules inside `SOUL.md` and seeded a Space rule inside `INSTRUCTIONS.md`. That made safe user editing impossible: replacing either document could erase an invariant, while preserving every prior rule would accumulate duplicated or contradictory prompt text. OpenClaw and Hermes both keep personality distinct from operating or project instructions (`docs/references/01-sota-hermes-openclaw.md`, `docs/references/04-onboarding-migration.md`); Veduta applies that separation without adopting their multi-Agent or profile models.

Status: accepted

## Consequences

- This amends ADR-0006's placement of the abstention rule in `SOUL.md`: the rule remains, but the Gateway owns and injects it separately.
- This amends ADR-0010's imported-`SOUL.md` defense: imported personality remains redacted, sanitized, fully previewed, and subordinate to product rules, but those rules no longer live inside the imported document's write boundary.
- Existing installations need a conservative migration that removes only exact recognized Veduta-owned text from character files and preserves all unknown or customized prose verbatim.
- Every character mutation uses the user-controlled document boundary; no character tool or Surface can edit the Gateway-owned prompt policy.
- Each character mutation replaces exactly one document. A request spanning the global identity and one or more Space characters becomes independent proposals rather than a hidden multi-file transaction.
- A confirmed character mutation affects context assembled after the authoritative Pending decision resolution. A model call already in progress keeps the context with which it started; no restart or new chat is required.
