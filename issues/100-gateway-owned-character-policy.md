# 100 — Move Gateway policy outside user-controlled character

## Parent

- #99

## What to build

Make the prompt boundary truthful before character editing is exposed. New installations must store
only user-controlled identity in `SOUL.md` and only user-controlled Space character in
`INSTRUCTIONS.md`; Veduta-owned safety, trust, tool, memory, Space-granularity, Automation,
abstention, and timing rules must be assembled separately by the Gateway.

This is the expand step for existing installations: their files are not rewritten yet. The runtime
must recognize the exact legacy Veduta-owned blocks when assembling context so enabling the new
policy boundary does not duplicate those rules before the migration ticket lands.

## Acceptance criteria

- [ ] A fresh installation creates a `SOUL.md` containing a user-controlled default identity with
      Agent name Veduta and no Gateway-owned operating rules.
- [ ] A fresh Space creates an `INSTRUCTIONS.md` containing only user-controlled Space character
      and no Space-granularity or other product rule.
- [ ] Global and focused-Space contexts inject the applicable Gateway-owned policy outside the
      character documents, with each rule present exactly once.
- [ ] Replacing either character document with empty or contradictory text cannot remove or alter
      the Gateway-owned policy seen by the model.
- [ ] An existing exact legacy default assembles to the same effective behavior without duplicate
      policy while its file remains untouched by this ticket.
- [ ] Unknown or customized character prose remains visible to the model unchanged; compatibility
      recognition never guesses at near matches.
- [ ] Every Model connection receives the same separated prompt boundary through the shared Agent
      path.
- [ ] Context-assembly tests cover fresh defaults, exact legacy defaults, customized documents,
      empty documents, and global/focused-Space prompts.
- [ ] `pnpm check` passes.

## Blocked by

None — can start immediately.
