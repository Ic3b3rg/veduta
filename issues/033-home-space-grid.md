# 033 — Home: Space grid + per-Space drill-down

## Context

[CONTEXT.md](../CONTEXT.md) defines the **Home** as "the primary screen of the PWA: shows all Spaces with their Surfaces… what the user sees at first glance upon opening", and [ARCHITECTURE.md §1/§3.5](../ARCHITECTURE.md) makes that at-a-glance Home the product differentiator (an agent with a real home, not a chat), with the notification discipline "silent update → badge on the Space → push".

Today the PWA renders every Space as a `SpaceSection` **stacked on one scrolling page** (`packages/pwa/src/app.tsx` maps all `spaces` into `SpaceSection`s), so all Spaces **and all their Surfaces** are exploded onto the Home at once. The scaffolding for per-Space navigation already exists but does not filter the view: a `space-rail`, a `focusedSpaceId` (it only highlights the rail and scopes the chat), chat scoping, and a Surface deep link `/app/space/<slug>/surface/<id>`. There is **no Space-level route/view**.

Navigation is also split across several ad-hoc mechanisms rather than one client router: `App` conditionally renders auth, onboarding, settings, and Home from local state; `view` switches settings without changing the URL; and Surface deep links use a hand-written pathname regex plus `history.pushState`/`popstate`. There is no central route table, so direct navigation, browser history, service-worker navigation, and rendered view can disagree as the fixed PWA shell grows.

This is a **PWA-only presentation change**: all data (Spaces + Surfaces) is already available from `/api/spaces`; no `packages/protocol` or daemon change is required.

## Goal

Make the Home an at-a-glance **grid of all active Spaces** (user life-areas first, a secondary System group at the end). Surfaces are seen by **drilling into a Space**, not exploded on the Home. Preserve the home-first "glance" — at the Space level instead of the Surface level. Put the fixed, non-generated PWA screens behind one declarative client router so the URL, browser history, and rendered view share a single source of truth.

## Tasks

- **Home (`/`) = a grid of Space cards**, no Surfaces. Each card shows: name, Surface count, freshness ("fresh 1m ago"), an attention badge, and a **reserved slot for a future Space description** (empty for now). Deterministic order: user Spaces first, then a visually secondary **"System"** group containing the one canonical System Space at the end.
- **Declarative client routing**: introduce React Router (`react-router-dom`) and replace the routing responsibilities currently split between `view`, `focusedSpaceId`/`focusedSurfaceId`, `parseSurfaceDeepLink`, `history.pushState`, and the `popstate` listener. Define one route table for `/`, `/setup`, `/app/settings/models`, `/app/space/:spaceSlug`, and `/app/space/:spaceSlug/surface/:surfaceId`. Route params are the source of truth for the open Space/Surface; Agent-maintained Surface content never defines application routes.
- **Route guards and navigation sources**: preserve the existing passkey and onboarding gates around protected routes, navigate from setup to `/` when onboarding completes, and route clicks, Back controls, browser back/forward, direct loads, and service-worker notification messages through the router API. Keep the daemon's existing SPA shell behavior (`/`, `/setup`, and `/app/*` serve `index.html`); this remains a PWA-only change.
- **Routing decision record**: add a short ADR recording why the growing fixed PWA shell now uses React Router instead of extending the hand-written history/state machinery, including the URL-source-of-truth rule and the boundary between fixed routes and data-driven Surfaces.
- **Attention badge (client-side only)**: a pending-approvals **count** (from the live approval cards already received over the gateway) plus a **"new activity" dot** when the Space's freshest Surface `updatedAt` is newer than a per-Space "last seen" timestamp stored in `localStorage`; opening the Space clears the dot.
- **Per-Space view**: a new route `/app/space/<slug>` that renders **only that Space's Surfaces** (reuse the current Surface-card rendering, full width), with an explicit **"← Home"** / breadcrumb. Keep the `space-rail` for lateral switching between Spaces. The existing `/app/space/<slug>/surface/<id>` deep link opens this Space view positioned on that Surface.
- **Chat**: unchanged — the `ChatBar` stays global at the bottom and auto-scopes to the open Space (global on the Home).
- **Approval cards**: a compact **global strip at the top of the Home** ("N actions await approval", expandable) + a count badge on the owning Space's card; **inside a Space**, its cards render inline above the Surfaces.
- **Mobile / narrow viewport**: the rail collapses (hidden behind a toggle or moved to the top), the grid becomes a single column, the per-Space view is full width with a back control.
- **Empty / first run**: when only system Spaces exist, show a gentle "create your first Space from chat" invite above the System group — never a desolate empty grid. (The real onboarding is issue 019.)
- No `packages/protocol` or daemon change; consume `/api/spaces` as-is. Preserve the existing chat-scoping behavior while deriving the open Space/Surface from router params instead of parallel focus state.

## Acceptance criteria

- Opening the Home shows a **grid of Space cards** for all active Spaces (user + System), with **no Surfaces exploded**; user life-areas appear first and System is a secondary group at the end.
- Clicking a Space (card or rail) navigates to `/app/space/<slug>` and shows **only that Space's Surfaces**; "← Home" returns to the grid; the URL reflects the open Space and is deep-linkable/shareable.
- Directly loading or refreshing `/`, `/setup`, `/app/settings/models`, `/app/space/<slug>`, or `/app/space/<slug>/surface/<id>` renders the matching screen after the existing auth/onboarding guards resolve; no route silently falls back to an unrelated Home view.
- Browser back/forward works across Home, Model connections, Space, and Surface navigation. Clicks and service-worker notification messages use the same router navigation path; `App` no longer owns a parallel `view` switch or manual `history.pushState`/`popstate` routing.
- The route table is fixed application code. Spaces and Surfaces supply route parameters and rendered data, but Agent output cannot create or redefine PWA routes.
- A Space with a pending approval shows the approvals strip on the Home **and** a count badge on its card; opening that Space shows the card inline above its Surfaces.
- A Space updated since the last visit shows the "new activity" dot on its card; opening the Space clears it.
- On a mobile viewport the grid is a single column, the rail is collapsible, and the per-Space view is full width.
- On a fresh install (only system Spaces) the Home shows the create-first-Space invite instead of an empty grid.
- Full gate green (`pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build`) and verified end-to-end in a real browser (Home grid → drill into a Space → back).

## Non-goals / future

- A **Space `description`** field (touches `packages/protocol` `SpaceSchema` + daemon persistence + the Agent authoring it on Space creation) — its own issue and plan mode; the card only reserves the slot.
- **Folder-style mini-previews** of a Space's Surfaces on the card (Android/iOS folder feel) — a later layer, deliberately deferred to avoid re-exploding Surfaces on the Home.
- Server-side unread/notification state — the attention badge here is client-side only.
- The onboarding wizard (issue 019).
- Server-side rendering or server-side route ownership — Fastify continues to serve the same PWA shell for `/`, `/setup`, and `/app/*`.

## Implementation tickets

- #64 — declarative fixed-shell routing.
- #65 — routed Space and Surface drill-down.
- #66 — at-a-glance Home grid.
- #67 — Pending decisions in Home and the owning Space.
- #68 — new Surface activity on Space cards.
- #69 — complete narrow-viewport journey.

## Parent completion criteria

- [ ] Issues #64 through #69 are complete.
- [ ] The full Home-to-Space journey satisfies this specification on desktop and narrow viewports.
- [ ] The full repository gate and the owning browser E2E are green.

## Blocked by

None — builds on completed issue #9; implementation starts at #64.
