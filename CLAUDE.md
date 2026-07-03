@AGENTS.md

## Claude Code specifics

- After completing an issue, verify the acceptance criteria end-to-end (`pnpm dev` + real
  browser via Chrome DevTools MCP when the change has a UI surface), not just tests.
- For changes touching `packages/protocol` (the daemon↔client contract), use plan mode first.
