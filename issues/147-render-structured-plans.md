# 147 — Render complete structured plans through strict content Atoms

## Parent

#140 — [Make every accepted Surface visibly operable](https://github.com/Ic3b3rg/veduta/issues/140)

Canonical specification: [issues/140-operable-surface-authoring.md](https://github.com/Ic3b3rg/veduta/blob/main/issues/140-operable-surface-authoring.md)

## What to build

Contract the content and data Atoms needed to render a complete structured plan instead of only a Surface title. Cover the accepted textual, list, status, metric, progress, and tabular forms with strict props and child rules, safe Markdown semantics, and visible empty states.

Use the reported three-day gym-plan request as the end-to-end tracer. The resulting Surface must visibly contain the three sessions, exercises, sets or repetitions, rest, progression, and safety guidance represented by supported Atoms. Keep plan generation generic and do not introduce a fitness-specific renderer or generated HTML.

## Acceptance criteria

- [ ] The shared contracts for `Title`, `Text`, `Caption`, `Label`, `Markdown`, `ListItem`, `Table`, `Stat`, `Progress`, `Badge`, and `Automation` define strict props, allowed children, and truthful empty-state behavior.
- [ ] Every accepted content or data Atom renders all semantically required information and never silently ignores a recognized prop or child.
- [ ] Markdown is rendered through the repository's safe structured-content boundary and cannot inject generated HTML or executable content.
- [ ] Tables, lists, metrics, progress, statuses, and automation summaries remain legible with missing optional content and fail validation when required content is absent.
- [ ] The Italian request `data la mia dieta fammi una scheda per la palestra 3 giorni a settimana` creates a Surface whose body visibly contains all three structured sessions and the guidance returned by the Agent.
- [ ] The gym-plan tracer cannot pass with only the title `Gym plan — 3 days` or an otherwise empty card.
- [ ] Chat describes only content that is present in the Surface committed by the Gateway.
- [ ] No fitness, diet, or other life-area parser or renderer is added.
- [ ] Protocol and catalog tests cover valid nesting, invalid props and children, safe Markdown, empty states, and complete structured content.
- [ ] A browser test proves the gym-plan request renders meaningful content immediately and after reload.
- [ ] `pnpm check` passes.

## Blocked by

- #142
