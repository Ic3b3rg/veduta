# Issues v1

Every issue has a clear input and a success criterion (the project's operating rule). Dependency order:

```
Foundations:   001 scaffold → 002 surface-protocol → 003 agent-runner → 004 gateway → 005 auth
Core:          006 spaces-memory → 007 surface-engine → 008 atom-catalog-renderer → 009 pwa-home-chat
Intelligence:  010 model-routing → 011 scheduler → 012 event-ingestion → 013 quarantined-reader
Trust:         014 trust-layer → 015 security-hardening
Proactivity:   016 heartbeat → 017 worker-review → 018 push-notifications
Adoption:      019 onboarding-wizard → 020 importer
Polish:        021 advanced-memory → 022 emergent-templates
```

Parallelizable: (006,007,008) after 002; (010,011) after 003; (019,020) after 009.

| # | Issue | Phase |
|---|---|---|
| 001 | [Monorepo scaffold](001-monorepo-scaffold.md) | Foundations |
| 002 | [Surface protocol](002-surface-protocol.md) | Foundations |
| 003 | [AgentRunner wrapper](003-agent-runner-wrapper.md) | Foundations |
| 004 | [Gateway](004-gateway.md) | Foundations |
| 005 | [Auth: TLS + passkey](005-auth-tls-passkey.md) | Foundations |
| 006 | [Spaces engine and memory](006-spaces-engine-memory.md) | Core |
| 007 | [Surface engine](007-surface-engine.md) | Core |
| 008 | [Atom catalog + renderer](008-atom-catalog-renderer.md) | Core |
| 009 | [PWA: Home + global chat](009-pwa-home-chat.md) | Core |
| 010 | [Model routing](010-model-routing.md) | Intelligence |
| 011 | [Scheduler](011-scheduler-timer-job.md) | Intelligence |
| 012 | [Event ingestion](012-event-ingestion.md) | Intelligence |
| 013 | [Quarantined reader](013-quarantined-reader.md) | Intelligence |
| 014 | [Trust layer](014-trust-layer.md) | Trust |
| 015 | [Security hardening](015-security-hardening.md) | Trust |
| 016 | [Safety-net Heartbeat](016-heartbeat.md) | Proactivity |
| 017 | [Worker + review](017-worker-review.md) | Proactivity |
| 018 | [Web push and notifications](018-push-notifications.md) | Proactivity |
| 019 | [Onboarding wizard](019-onboarding-wizard.md) | Adoption |
| 020 | [OpenClaw/Hermes importer](020-importer.md) | Adoption |
| 021 | [Advanced memory](021-advanced-memory.md) | Polish |
| 022 | [Emergent templates](022-emergent-templates.md) | Polish |
