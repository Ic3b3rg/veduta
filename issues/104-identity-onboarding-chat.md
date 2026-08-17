# 104 — Offer lightweight Identity onboarding in the first global response

## Parent

- #99

## What to build

Offer a lightweight, optional Identity onboarding inside the ordinary global conversation. On the
first successful global-chat response for a pristine identity, the Agent asks how it should be
named and what kind of presence the user wants. It never starts an autonomous turn, opens a form,
edits `USER.md`, or bypasses the global Character-change decision flow from #102.

The invitation is installation-wide and one-time. It must not block a substantive first request,
nag after being offered, or appear when an imported or customized identity already exists.

## Acceptance criteria

- [ ] A fresh installation starts with Agent name Veduta and an Identity-onboarding state that has
      not yet been offered.
- [ ] The first successful Agent response in global chat offers Identity onboarding; opening Home
      alone never starts a model call or creates a chat message.
- [ ] When the first user message is substantive, the Agent answers it before a short invitation;
      when it is a greeting or exploratory message, the invitation may be the main response.
- [ ] The conversation asks at most two setup questions in sequence: the desired Agent name, then
      the desired presence, with role, personality, tone, and communication preferences optional.
- [ ] The onboarding never asks who the user is and never writes or proposes a change to `USER.md`.
- [ ] “Decide for me” lets the Agent draft an identity but still produces the complete `SOUL.md`
      diff and requires the ordinary Pending-decision confirmation before any write.
- [ ] Completing the questions creates exactly one ordinary global Character-change proposal under
      #102; declining or rejecting leaves the default identity unchanged.
- [ ] The one-time offered state is daemon-owned, durable across clients and restart, and is recorded
      only after a successful eligible response. A failed or interrupted first turn leaves the
      invitation eligible for retry.
- [ ] Once successfully offered, explicit skip, an unrelated next message, or simple non-response
      prevents all automatic re-prompting; the user can still request character configuration
      explicitly at any later time.
- [ ] A customized, manually changed, or imported `SOUL.md` bypasses the invitation even when no
      browser-local chat history exists.
- [ ] Focused-Space chat, proactive work, Workers, external events, and reconnect replay never emit
      the invitation.
- [ ] Fake-provider integration tests cover greeting, substantive work, model failure and retry,
      both answers, “decide for me,” skip, ignore, restart, another client, customized identity, and
      imported identity.
- [ ] No dedicated settings screen, onboarding form, personality preset, or temporary overlay is
      introduced.
- [ ] `pnpm check` passes.

## Blocked by

- #102
