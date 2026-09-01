# Issues v1

Every issue has a clear input and a success criterion. Each implementation specification is
mirrored as a [GitHub issue](https://github.com/Ic3b3rg/veduta/issues) with the same number: GitHub
owns discussion and status, while the files here are the canonical durable specifications.

Dependency order:

```text
Foundations:   001 scaffold → 002 surface-protocol → 003 agent-runner → 004 gateway → 005 auth
Core:          006 spaces-memory → 007 surface-engine → 008 atom-catalog-renderer → 009 pwa-home-chat
Intelligence:  010 model-routing → 011 scheduler → 012 event-ingestion → 013 quarantined-reader
Trust:         014 trust-layer → 015 security-hardening
Proactivity:   016 heartbeat → 017 worker-review → 018 push-notifications
Adoption:      019 onboarding-wizard → 020 importer
Polish:        021 advanced-memory → 022 emergent-templates
Memory:        032 parent; 128 Unicode → (129 FACTS persistence, 131 superseded, 132 Event budget)
               (034,129) → 130 watermarks; (091,100,113,130) → 133 health
Access:        048 guided-vps-access-installer → 049 tailnet-access
Models:        047 model-connections → 070 codex-tool-parity parent
               071 round-trip → 072 hardening → 073 Surface authoring → 074 trust → 075 memory → 076 Templates
               (073,093) → 077 Automations; (039,073) → 078 Workers; (074,075,076,077,078) → 079 parity
               118 Codex thread retention cleanup; 119 Model connection docs discoverability
Operations:    081 trace-console parent → 082 retained-logs → 083 chat-activity → 084 complete-turn
               084 → 085 fast-path; 083 → (086,087); (082,083) → 088; 082 → 089; (084–089) → 090
Automations:   091 outcome-delivery → 092 external-monitoring; 093 focused-tools → 077 parity; 094 paused recurrence
Mailbox:       135 parent; 120 quiesce → 121 passive Gmail → 122 Gmail Skill/search → 123 Himalaya general execution → 124 open → 125 reply
               (123,077,084,086,091,097) → 126 Mailbox Automations; (121,123) → 127 remove Watch/IDLE
Surfaces:      042 focused-read-tools → 134 relative-time views → 095 visible-space-answers
Decisions:     096 contract → 097 outcomes → (067 Home, 098 chat)
Character:     099 parent; 100 policy → 101 migration; (101,098) → 102 identity → (103 Space → 105 undo, 104 onboarding)
Ordering:      106 parent → 108 canonical-order → (109 groups, 110 mutations, 111 reveal)
               (109,110,111,155) → 112 recovery
Visibility:    (037 agent-loop,042 focused-tools) → 107 chat-created-surface-focus
Chat:          136 global multi-Space → 137 focused Space proposal
System:        063 parent → 113 invariant → (114 usage,115 devices,116 authoring); (114,115) → 117 projections
Home:          033 parent → 064 router → 065 routes; (065,117) → 066 grid → (067 decisions,068 activity) → 069 narrow
Maintenance:   (045,139) → 155 PWA live-state runtime
Surfaces:      140 parent; 142 Form submit → (145 Charts,146 controls,147 plans,148 remaining Atoms)
               (155,156) → 161 typed Actions → 146 controls
               139 → 143 presentation; (143,145,146,147,148) → 150 honest authoring
Chat timeline: 141 parent; 155 → 144 focused persistence → 149 scopes → 151 pagination
               151 → (152 recovery,153 Pending updates) → 154 Gateway authority
Durability:    156 recoverable Surface commits → (040 Agent path,085 fast-path Trace)
Visual:        157 parent; 162 contract → (163 shell/Home/Space,165 Chat/Pending,166 setup)
               (109,110,111,162) → 164 Surface chrome; (163,164,165,166) → 167 contract
```

Parallelizable roots are described by the explicit `Blocked by` section in each specification.
A `ready-for-agent` label means the ticket is fully specified; work starts only when every listed
blocker is closed.

| #   | Issue                                                                                                | Phase        |
| --- | ---------------------------------------------------------------------------------------------------- | ------------ |
| 001 | [Monorepo scaffold](001-monorepo-scaffold.md)                                                        | Foundations  |
| 002 | [Surface protocol](002-surface-protocol.md)                                                          | Foundations  |
| 003 | [AgentRunner wrapper](003-agent-runner-wrapper.md)                                                   | Foundations  |
| 004 | [Gateway](004-gateway.md)                                                                            | Foundations  |
| 005 | [Auth: TLS + passkey](005-auth-tls-passkey.md)                                                       | Foundations  |
| 006 | [Spaces engine and memory](006-spaces-engine-memory.md)                                              | Core         |
| 007 | [Surface engine](007-surface-engine.md)                                                              | Core         |
| 008 | [Atom catalog + renderer](008-atom-catalog-renderer.md)                                              | Core         |
| 009 | [PWA: Home + global chat](009-pwa-home-chat.md)                                                      | Core         |
| 010 | [Model routing](010-model-routing.md)                                                                | Intelligence |
| 011 | [Scheduler](011-scheduler-timer-job.md)                                                              | Intelligence |
| 012 | [Event ingestion](012-event-ingestion.md)                                                            | Intelligence |
| 013 | [Quarantined reader](013-quarantined-reader.md)                                                      | Intelligence |
| 014 | [Trust layer](014-trust-layer.md)                                                                    | Trust        |
| 015 | [Security hardening](015-security-hardening.md)                                                      | Trust        |
| 016 | [Safety-net Heartbeat](016-heartbeat.md)                                                             | Proactivity  |
| 017 | [Worker + review](017-worker-review.md)                                                              | Proactivity  |
| 018 | [Web push and notifications](018-push-notifications.md)                                              | Proactivity  |
| 019 | [Onboarding wizard](019-onboarding-wizard.md)                                                        | Adoption     |
| 020 | [OpenClaw/Hermes importer](020-importer.md)                                                          | Adoption     |
| 021 | [Advanced memory](021-advanced-memory.md)                                                            | Polish       |
| 022 | [Emergent templates](022-emergent-templates.md)                                                      | Polish       |
| 023 | [Local VPS profile](023-local-vps-profile.md)                                                        | Core         |
| 024 | [Shell tokens from the catalog](024-shell-tokens-from-catalog.md)                                    | Polish       |
| 025 | [IMAP IDLE fallback](025-imap-idle-fallback.md)                                                      | Intelligence |
| 028 | [Surface motion](028-surface-motion.md)                                                              | Polish       |
| 029 | [Progressive Surface composition](029-progressive-surface-composition.md)                            | Polish       |
| 032 | [FACTS hygiene and context budget](032-facts-hygiene-context-budget.md)                              | Polish       |
| 033 | [Home Space grid](033-home-space-grid.md)                                                            | Core         |
| 034 | [Curator false supersede](034-curator-false-supersede.md)                                            | Polish       |
| 035 | [Store seed Space mismatch](035-store-seed-space-mismatch.md)                                        | Core         |
| 036 | [Systemd clean-exit restart](036-systemd-clean-exit-restart.md)                                      | Operations   |
| 037 | [Interactive Agent loop](037-agent-loop-chat.md)                                                     | Core         |
| 038 | [Proactive Agent completions](038-agent-loop-proactive.md)                                           | Proactivity  |
| 039 | [Worker and full-text Agent runs](039-agent-loop-workers.md)                                         | Proactivity  |
| 040 | [Agent-path consumer](040-agent-path-consumer.md)                                                    | Core         |
| 042 | [Focused-Space Surface reads and creation](042-surface-read-tools.md)                                | Core         |
| 043 | [Signed self-update](043-self-update.md)                                                             | Operations   |
| 044 | [Multi-architecture signed runtime metadata](044-multi-arch-signed-runtime-metadata.md)              | Operations   |
| 045 | [Repeat fast-action delivery](045-repeat-fast-action-delivery.md)                                    | Core         |
| 046 | [Signed artifact URL](046-signed-artifact-url.md)                                                    | Operations   |
| 047 | [Model connections](047-model-connections.md)                                                        | Adoption     |
| 048 | [Guided VPS access installer](048-guided-vps-access-installer.md)                                    | Adoption     |
| 049 | [Tailnet access](049-tailnet-access.md)                                                              | Adoption     |
| 062 | [Self-update E2E readiness budget](062-self-update-e2e-readiness-budget.md)                          | Operations   |
| 063 | [System Space GenUI namespace](063-system-space-genui-namespace.md)                                  | Core         |
| 064 | [Declarative client router](064-declarative-client-router.md)                                        | Core         |
| 065 | [Space and Surface routes as source of truth](065-space-surface-route-source-of-truth.md)            | Core         |
| 066 | [At-a-glance Space grid](066-at-a-glance-space-grid.md)                                              | Core         |
| 067 | [Pending decisions in Home](067-pending-decisions-home.md)                                           | Core         |
| 068 | [Space-card Surface activity](068-space-card-surface-activity.md)                                    | Core         |
| 069 | [Narrow Home and Space journey](069-narrow-home-space-journey.md)                                    | Core         |
| 070 | [ChatGPT subscription tool parity](070-codex-tool-parity.md)                                         | Models       |
| 071 | [Round-trip one Codex dynamic tool](071-codex-dynamic-tool-round-trip.md)                            | Models       |
| 072 | [Harden Codex tool turns](072-codex-tool-turn-hardening.md)                                          | Models       |
| 073 | [ChatGPT subscription Surface authoring](073-chatgpt-subscription-surface-authoring.md)              | Models       |
| 074 | [ChatGPT subscription trust parity](074-chatgpt-subscription-trust-parity.md)                        | Models       |
| 075 | [ChatGPT subscription Space memory](075-chatgpt-subscription-space-memory.md)                        | Models       |
| 076 | [ChatGPT subscription Template reuse](076-chatgpt-subscription-template-reuse.md)                    | Models       |
| 077 | [ChatGPT subscription Automations](077-chatgpt-subscription-automations.md)                          | Models       |
| 078 | [ChatGPT subscription Workers](078-chatgpt-subscription-workers.md)                                  | Models       |
| 079 | [Primary Connection parity](079-primary-connection-parity.md)                                        | Models       |
| 080 | [Repository simplification](080-repository-simplification.md)                                        | Maintenance  |
| 081 | [Internal trace console](081-internal-trace-console.md)                                              | Operations   |
| 082 | [Retained Runtime logs](082-inspect-retained-runtime-logs.md)                                        | Operations   |
| 083 | [Retained chat Trace Activity](083-retained-chat-trace-activity.md)                                  | Operations   |
| 084 | [Complete Agent turn Trace](084-complete-agent-turn-trace.md)                                        | Operations   |
| 085 | [Fast-path Surface Traces](085-fast-path-surface-traces.md)                                          | Operations   |
| 086 | [Automation, Worker, and external-event Traces](086-automation-worker-external-event-traces.md)      | Operations   |
| 087 | [Approval, notification, and update Traces](087-approval-notification-update-traces.md)              | Operations   |
| 088 | [Realtime diagnostic stream](088-realtime-diagnostic-stream.md)                                      | Operations   |
| 089 | [Structured Runtime logging](089-structured-runtime-logging.md)                                      | Operations   |
| 090 | [Diagnostic safety, restart, and recovery](090-diagnostic-safety-restart-recovery.md)                | Operations   |
| 091 | [Automation outcome delivery](091-automation-outcome-delivery.md)                                    | Proactivity  |
| 092 | [Recurring external monitoring](092-recurring-external-monitoring.md)                                | Proactivity  |
| 093 | [Focused-Space Automation tools](093-focused-automation-tools.md)                                    | Core         |
| 094 | [Paused recurring Automations](094-disabled-recurring-automations.md)                                | Intelligence |
| 095 | [Visible Space answers](095-visible-space-answers.md)                                                | Core         |
| 096 | [Pending-decision contract](096-pending-decision-contract.md)                                        | Core         |
| 097 | [Pending-decision outcomes](097-pending-decision-outcomes.md)                                        | Core         |
| 098 | [Pending decisions from chat](098-chat-pending-decisions.md)                                         | Core         |
| 099 | [Chat character configuration](099-chat-character-configuration.md)                                  | Core         |
| 100 | [Gateway-owned character policy](100-gateway-owned-character-policy.md)                              | Core         |
| 101 | [Safe character migration and import](101-character-migration-import.md)                             | Adoption     |
| 102 | [Global Agent identity from chat](102-global-agent-identity-chat.md)                                 | Core         |
| 103 | [Space character from any chat scope](103-space-character-chat-scope.md)                             | Core         |
| 104 | [Identity onboarding in global chat](104-identity-onboarding-chat.md)                                | Adoption     |
| 105 | [Confirmed Character-change undo](105-character-change-undo.md)                                      | Core         |
| 106 | [Gateway-owned pinned Surface order](106-gateway-owned-pinned-order.md)                              | Core         |
| 107 | [Chat-created Surface focus](107-chat-created-surface-focus.md)                                      | Core         |
| 108 | [Gateway-owned Surface order](108-gateway-owned-surface-order.md)                                    | Core         |
| 109 | [Accessible pinned Surface groups](109-accessible-pinned-surface-groups.md)                          | Core         |
| 110 | [Confirmed online Surface-order mutations](110-confirmed-online-surface-order-mutations.md)          | Core         |
| 111 | [Direct Pin Surface reveal](111-direct-pin-surface-reveal.md)                                        | Core         |
| 112 | [Surface-order convergence and recovery](112-surface-order-convergence-recovery.md)                  | Core         |
| 113 | [Canonical System Space invariant](113-canonical-system-space-invariant.md)                          | Core         |
| 114 | [Living Model usage System Surface](114-persist-model-usage-system-surface.md)                       | Core         |
| 115 | [Living Connected devices System Surface](115-persist-connected-devices-system-surface.md)           | Core         |
| 116 | [Gateway-owned System Space authoring](116-system-space-gateway-owned-authoring.md)                  | Core         |
| 117 | [Synthetic System Surface projection retirement](117-retire-synthetic-system-surface-projections.md) | Core         |
| 118 | [Codex thread retention cleanup](118-codex-thread-retention-cleanup.md)                              | Models       |
| 119 | [Model connection docs discoverability](119-model-connection-docs-discoverability.md)                | Models       |
| 120 | [Stop ambient personal-mail access](120-stop-ambient-personal-mail-access.md)                        | Proactivity  |
| 121 | [Passive Gmail Mailbox connection](121-passive-gmail-mailbox-connection.md)                          | Adoption     |
| 122 | [Gmail Mailbox Skill search and summary](122-gmail-mailbox-skill-search-summary.md)                  | Intelligence |
| 123 | [Himalaya Skill and general execution](123-himalaya-skill-general-execution.md)                      | Adoption     |
| 124 | [Transient mail open and mark read](124-transient-mail-open-mark-read.md)                            | Trust        |
| 125 | [Approved threaded mail reply](125-approved-threaded-mail-reply.md)                                  | Trust        |
| 126 | [Exact-scope Mailbox Automations](126-exact-scope-mailbox-automations.md)                            | Proactivity  |
| 127 | [Remove mail Watch ingestion](127-remove-mail-watch-ingestion.md)                                    | Core         |
| 128 | [Durable-memory Unicode sanitation](128-sanitize-forbidden-unicode.md)                               | Trust        |
| 129 | [Secret-safe atomic FACTS writes](129-secret-safe-atomic-facts-writes.md)                            | Trust        |
| 130 | [FACTS high and hard watermarks](130-facts-high-hard-watermarks.md)                                  | Polish       |
| 131 | [Bounded superseded FACTS tail](131-bounded-superseded-facts-tail.md)                                | Polish       |
| 132 | [Event context and tool-result budget](132-event-context-tool-result-budget.md)                      | Polish       |
| 133 | [System Space memory health](133-system-space-memory-health.md)                                      | Core         |
| 134 | [Relative-time Surface views](134-relative-time-surface-views.md)                                    | Core         |
| 135 | [Pull-based personal Mailbox roadmap](135-pull-based-personal-mailbox.md)                            | Proactivity  |
| 136 | [Global chat multi-Space work](136-global-chat-multi-space.md)                                       | Core         |
| 137 | [Focused chat Space proposal](137-focused-chat-space-proposal.md)                                    | Core         |
| 139 | [Gateway-owned PWA transport](139-gateway-owned-pwa-transport.md)                                    | Maintenance  |
| 140 | [Operable Surface authoring](140-operable-surface-authoring.md)                                      | Core         |
| 141 | [Durable scoped Chat timelines](141-durable-chat-timelines.md)                                       | Core         |
| 142 | [Atomic Form text submit](142-form-text-edits-submit-atomically.md)                                  | Core         |
| 143 | [Persisted Surface presentation](143-persist-surface-presentation.md)                                | Core         |
| 144 | [Durable focused-Space Chat turns](144-persist-focused-space-chat-turns.md)                          | Core         |
| 145 | [Truthful one-series Charts](145-render-one-series-charts.md)                                        | Core         |
| 146 | [Operable selection and action controls](146-operable-selection-and-action-controls.md)              | Core         |
| 147 | [Complete structured plans](147-render-structured-plans.md)                                          | Core         |
| 148 | [Contracted remaining Atoms](148-contract-remaining-atoms.md)                                        | Core         |
| 149 | [Separate Chat scopes](149-separate-chat-scopes.md)                                                  | Core         |
| 150 | [Honest Surface authoring contract](150-close-generic-atom-acceptance.md)                            | Core         |
| 151 | [Paginated Chat timelines](151-page-chat-timelines.md)                                               | Core         |
| 152 | [Recoverable Chat turns](152-recover-chat-turns.md)                                                  | Core         |
| 153 | [In-place Pending decisions](153-update-pending-decisions-in-place.md)                               | Core         |
| 154 | [Gateway-owned Chat authority](154-retire-browser-local-chat-authority.md)                           | Core         |
| 155 | [PWA live-state runtime](155-deepen-pwa-live-state-runtime.md)                                       | Maintenance  |
| 156 | [Recoverable Surface commits](156-recoverable-surface-commits.md)                                    | Core         |
| 157 | [Product-first Precision Tool UI](157-product-first-precision-tool-ui.md)                            | Polish       |
| 161 | [Typed deterministic Surface Actions](161-typed-deterministic-surface-actions.md)                    | Core         |
| 162 | [Precision Tool visual contract](162-precision-tool-visual-contract.md)                              | Polish       |
| 163 | [Precision Tool shell, Home, and Space](163-precision-tool-shell-home-space.md)                      | Polish       |
| 164 | [Precision Tool Surface chrome](164-precision-tool-surface-chrome.md)                                | Polish       |
| 165 | [Precision Tool Chat and Pending decisions](165-precision-tool-chat-pending.md)                      | Polish       |
| 166 | [Precision Tool onboarding and Model connections](166-precision-tool-onboarding-connections.md)      | Polish       |
| 167 | [Precision Tool visual-system contract](167-contract-precision-tool-visual-system.md)                | Polish       |
