# Issues v1

Every issue has a clear input and a success criterion (the project's operating rule). Each file is mirrored as a [GitHub issue](https://github.com/Ic3b3rg/veduta/issues) with the same number (file `001` = issue `#1`): discussion and status live on GitHub, the files here are the canonical spec. Dependency order:

```
Foundations:   001 scaffold → 002 surface-protocol → 003 agent-runner → 004 gateway → 005 auth
Core:          006 spaces-memory → 007 surface-engine → 008 atom-catalog-renderer → 009 pwa-home-chat
Intelligence:  010 model-routing → 011 scheduler → 012 event-ingestion → 013 quarantined-reader
Trust:         014 trust-layer → 015 security-hardening
Proactivity:   016 heartbeat → 017 worker-review → 018 push-notifications
Adoption:      019 onboarding-wizard → 020 importer
Polish:        032 facts-hygiene → 021 advanced-memory → 022 emergent-templates
Models:        047 model-connections → 070 codex-tool-parity → 071 codex-tool-round-trip → 072 codex-tool-turn-hardening
Access:        048 guided-vps-access-installer → 049 tailnet-access
Operations:    081 internal-trace-console
Maintenance:   080 repository-simplification
```

Parallelizable: (006,007,008) after 002; (010,011) after 003; (019,020) after 009.

| #   | Issue                                                                                           | Phase        |
| --- | ----------------------------------------------------------------------------------------------- | ------------ |
| 001 | [Monorepo scaffold](001-monorepo-scaffold.md)                                                   | Foundations  |
| 002 | [Surface protocol](002-surface-protocol.md)                                                     | Foundations  |
| 003 | [AgentRunner wrapper](003-agent-runner-wrapper.md)                                              | Foundations  |
| 004 | [Gateway](004-gateway.md)                                                                       | Foundations  |
| 005 | [Auth: TLS + passkey](005-auth-tls-passkey.md)                                                  | Foundations  |
| 006 | [Spaces engine and memory](006-spaces-engine-memory.md)                                         | Core         |
| 007 | [Surface engine](007-surface-engine.md)                                                         | Core         |
| 008 | [Atom catalog + renderer](008-atom-catalog-renderer.md)                                         | Core         |
| 009 | [PWA: Home + global chat](009-pwa-home-chat.md)                                                 | Core         |
| 010 | [Model routing](010-model-routing.md)                                                           | Intelligence |
| 011 | [Scheduler](011-scheduler-timer-job.md)                                                         | Intelligence |
| 012 | [Event ingestion](012-event-ingestion.md)                                                       | Intelligence |
| 013 | [Quarantined reader](013-quarantined-reader.md)                                                 | Intelligence |
| 014 | [Trust layer](014-trust-layer.md)                                                               | Trust        |
| 015 | [Security hardening](015-security-hardening.md)                                                 | Trust        |
| 016 | [Safety-net Heartbeat](016-heartbeat.md)                                                        | Proactivity  |
| 017 | [Worker + review](017-worker-review.md)                                                         | Proactivity  |
| 018 | [Web push and notifications](018-push-notifications.md)                                         | Proactivity  |
| 019 | [Onboarding wizard](019-onboarding-wizard.md)                                                   | Adoption     |
| 020 | [OpenClaw/Hermes importer](020-importer.md)                                                     | Adoption     |
| 021 | [Advanced memory](021-advanced-memory.md)                                                       | Polish       |
| 022 | [Emergent templates](022-emergent-templates.md)                                                 | Polish       |
| 023 | [Local VPS profile](023-local-vps-profile.md)                                                   | Core         |
| 024 | [Shell tokens from the catalog](024-shell-tokens-from-catalog.md)                               | Polish       |
| 025 | [IMAP IDLE fallback](025-imap-idle-fallback.md)                                                 | Intelligence |
| 028 | [Surface motion](028-surface-motion.md)                                                         | Polish       |
| 029 | [Progressive Surface composition](029-progressive-surface-composition.md)                       | Polish       |
| 032 | [FACTS hygiene and context budget](032-facts-hygiene-context-budget.md)                         | Polish       |
| 033 | [Home Space grid](033-home-space-grid.md)                                                       | Core         |
| 034 | [Curator false supersede](034-curator-false-supersede.md)                                       | Polish       |
| 037 | [Interactive Agent loop](037-agent-loop-chat.md)                                                | Core         |
| 038 | [Proactive Agent completions](038-agent-loop-proactive.md)                                      | Proactivity  |
| 039 | [Worker and full-text Agent runs](039-agent-loop-workers.md)                                    | Proactivity  |
| 040 | [Agent-path consumer](040-agent-path-consumer.md)                                               | Core         |
| 043 | [Signed self-update](043-self-update.md)                                                        | Operations   |
| 046 | [Signed artifact URL](046-signed-artifact-url.md)                                               | Operations   |
| 047 | [Model connections](047-model-connections.md)                                                   | Adoption     |
| 048 | [Guided VPS access installer](048-guided-vps-access-installer.md)                               | Adoption     |
| 049 | [Tailnet access](049-tailnet-access.md)                                                         | Adoption     |
| 081 | [Internal trace console](081-internal-trace-console.md)                                         | Operations   |
| 082 | [Retained Runtime logs](082-inspect-retained-runtime-logs.md)                                   | Operations   |
| 083 | [Retained chat Trace Activity](083-retained-chat-trace-activity.md)                             | Operations   |
| 084 | [Complete Agent turn Trace](084-complete-agent-turn-trace.md)                                   | Operations   |
| 085 | [Fast-path Surface Traces](085-fast-path-surface-traces.md)                                     | Operations   |
| 086 | [Automation, Worker, and external-event Traces](086-automation-worker-external-event-traces.md) | Operations   |
| 087 | [Approval, notification, and update Traces](087-approval-notification-update-traces.md)         | Operations   |
| 088 | [Realtime diagnostic stream](088-realtime-diagnostic-stream.md)                                 | Operations   |
| 089 | [Structured Runtime logging](089-structured-runtime-logging.md)                                 | Operations   |
| 090 | [Diagnostic safety, restart, and recovery](090-diagnostic-safety-restart-recovery.md)           | Operations   |
| 070 | [ChatGPT subscription tool parity](070-codex-tool-parity.md)                                    | Models       |
| 071 | [Round-trip one Codex dynamic tool](071-codex-dynamic-tool-round-trip.md)                       | Models       |
| 072 | [Harden Codex tool turns](072-codex-tool-turn-hardening.md)                                     | Models       |
| 052 | [Global chat multi-Space work](052-global-chat-multi-space.md)                                  | Core         |
| 080 | [Repository simplification](080-repository-simplification.md)                                   | Maintenance  |
