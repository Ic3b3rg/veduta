# 009 — PWA: Home + global chat

## Context
[ADR-0001](../docs/adr/0001-home-first.md): the Home is the product. Chat is an omnipresent input, not the screen.

## Goal
The installable PWA: Home with all the Spaces, global chat that focuses, live Surfaces.

## Tasks
- Home: all the Spaces with their Surfaces (user-reorderable layout — personalization, one of the founding pain points); non-invasive badges; visible freshness ("updated 2h ago")
- Global chat: omnipresent bar; streaming; opening a Space focuses the chat there (pre-routed context); browsable history
- "Propose Space" flow (one-tap confirmation) and approval cards (issue 014) rendered in chat and in the Home
- PWA: manifest, service worker, guided installability (iOS: add-to-home instructions on first launch), offline-tolerant (Home cached, actions queued)
- Deep links `app/space/<slug>/surface/<id>` (Bridges and push will use them)

## Acceptance criteria
- On opening the app, the state of the Spaces is visible without any interaction (< 1s from cache + sync)
- "I ate a pizza" typed in chat → the right Surface updates in view without a reload
- Installed on iOS and Android as an app, with icon and splash screen

## Dependencies
004, 005, 007, 008
