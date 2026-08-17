# Website monitors are goal-directed, host-scoped quarantined Automations

A Website monitor is created through one editable Pending decision that names its owning Space,
approved HTTPS hosts, frequency, interpreted monitoring goal, and target Surface. Veduta may
propose a clearly suitable existing Surface or a dedicated new one, but the confirmed target must
belong to the same Space. Authorization belongs to that Automation rather than expanding a global
domain allowlist.

The Gateway performs conditional, manually redirected reads behind explicit request, response,
redirect, document, byte, duration, and per-Space rate ceilings. Every hop is revalidated against
the approved host set and public-network policy; a new host pauses the occurrence and creates a new
Pending decision. The first slice supports public HTML and RSS/Atom only. Credentials,
authenticated pages, paywalls, PDFs, media, attachments, and provider-native browsing or search
remain unavailable.

An unchanged HTTP validator result ends the occurrence without model work. When bytes change, a
tool-less quarantined reader applies the confirmed goal, extracts schema-valid candidate links,
and may request a bounded number of additional pages on approved hosts. Isolated full-text work
may interpret a selected page, but raw external content never enters the primary Agent's context
or gains tools. A semantic result digest prevents advertisements, navigation, timestamps, and
other irrelevant page churn from becoming user-visible outcomes.

Conditional-read state and the last structured result survive restart. One occurrence makes an
initial request and at most two bounded retries, respecting server backoff without extending the
overall deadline. Exhaustion retains the last valid Surface, records a safe failure, and follows
ADR-0021's coalesced In-app notification policy; recovery produces one recovery outcome.

The rejected alternatives are byte-for-byte page monitoring, raw-page access by the primary
Agent, provider-native web search, unrestricted link traversal, global host authorization,
credentialed browsing in the first slice, and treating every page change as a dashboard update.

Status: accepted
