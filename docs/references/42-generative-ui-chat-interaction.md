# Research 42 — Conversation, persistent work, and direct interaction

> Conducted and sources accessed on 2026-10-10 for
> [Chat design #228](https://github.com/Ic3b3rg/veduta/issues/228) and
> [readable proposed changes #227](https://github.com/Ic3b3rg/veduta/issues/227).
> Research only: no approved design, architecture change, implementation, or deployment.
> **Observed** means exercised in a live product during this investigation; **Documented** means
> established by first-party documentation, source, or a paper; **Inference** means a proposal for
> Veduta that still needs owner evaluation.

## Question and current decision

How should a user move between asking, reading, inspecting a proposed change, and operating
persistent content without repeatedly managing Chat panels? The owner rejected both expandable
Chat prototypes on 2026-10-10: they felt confusing, required too much interaction, and did not work
well enough. Their rejection supersedes the open A-versus-B choice in the
[prototype handoff](https://github.com/Ic3b3rg/veduta/issues/228#issuecomment-6095304702). The earlier
preference for comfortable full-screen reading is a need to preserve, not approval of either
layout.

The owner subsequently asked for all six CopilotKit gallery examples, empirical UX/UI research,
ChatGPT, and shadcn/ui to inform the work. Their latest candidate is a persistent right-hand Chat
on desktop and a mobile drawer reached through a recognizable floating control. This is a direction
to investigate, not approval of a new implementation. Familiar interaction conventions and smooth,
predictable behavior take priority over inventing another shell.

**Inference:** the next design question is the connection between the work and the conversation.
Changing a launcher's location or a panel's height cannot alone establish that connection. The
evidence below supports keeping the current object identifiable, giving it useful direct controls,
and showing the actual effect of a request. It does not establish an optimal phone layout.

Veduta already specifies persistent Surfaces, a closed Atom catalog, evented fast-path mutations,
Gateway-owned Chat timelines, and explicit workflow-owned Pending decisions. These are reusable
foundations for this problem, not reasons to add another UI protocol or state owner.
([ADR-0001](../adr/0001-home-first.md), [ADR-0003](../adr/0003-declarative-atoms.md),
[ADR-0019](../adr/0019-channel-neutral-pending-decisions.md),
[ADR-0029](../adr/0029-gateway-owned-chat-timelines.md),
[ADR-0031](../adr/0031-pwa-live-state-runtime.md))

## Hashbrown invoicing: firsthand inspection

**Observed:** the [live demo](https://invoicing.hashbrown.dev/) was exercised in a desktop browser at
1280 × 800 and 1440 × 900, then resized to 390 × 844. The latter checks responsive layout, not an
Android browser, touch accuracy, or a software keyboard. Only fictional sample data was used.
The source was separately inspected at
[`8b9e274`](https://github.com/liveloveapp/hashbrown/tree/8b9e274189837ea75a6baa3c90788395de149029/examples/invoicing);
the deployed commit was not independently established.

| Exercised flow                          | Observed result                                                                                                                               | Interaction lesson, not a usability-study result                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Ask which clients pay late              | Prose and three structured customer cards appeared in the assistant                                                                           | Answers can use the application's own data views; this response was still verbose |
| Select Juniper in the client grid       | One selection changed the charts, the assistant's explicit client context, and the URL                                                        | The object being discussed need not be described again                            |
| Ask which invoices compose that balance | The follow-up resolved Juniper and rendered its four open invoices as a table                                                                 | Conversation and visible work can share a precise target                          |
| Select Cedar's unapplied payment        | A matching panel showed the invoice, its $5,000 balance, the proposed $2,000 allocation, and a checked total                                  | Direct controls prepare an inspectable operation                                  |
| Request review, then decline            | Review named client, payment, invoice, allocation, and remaining cash; declining retained the original balances and enabled composition again | Approval content explains the actual operation                                    |

These observations come from the [live application](https://invoicing.hashbrown.dev/). They cover
one read/follow-up/rejection sequence, not approval execution or exhaustive correctness.

**Documented:** the selection passed to the assistant uses record identities; rendered cards and
tables resolve those identities against application state. The proposal component likewise reads
the server-owned proposal supplied by the application, rather than trusting model-written amounts.
This explains the continuity between the dashboard and the answer.
([Application focus](https://github.com/liveloveapp/hashbrown/blob/8b9e274189837ea75a6baa3c90788395de149029/examples/invoicing/react/src/App.tsx),
[answer components](https://github.com/liveloveapp/hashbrown/blob/8b9e274189837ea75a6baa3c90788395de149029/examples/invoicing/react/src/assistant-kit.tsx),
[proposal component](https://github.com/liveloveapp/hashbrown/blob/8b9e274189837ea75a6baa3c90788395de149029/examples/invoicing/react/src/allocation-proposal.tsx))

### Useful limits of this reference

**Observed:** at 390 × 844, the assistant followed the entire dashboard. After the two questions,
its top was about 1,697 CSS pixels down the document and the composer about 3,896 pixels down.
The page had no horizontal overflow, but reaching the conversation required substantial scrolling.
On desktop, the completed proposal needed an additional thread scroll to reveal its controls below
the earlier answer. Resizing alone therefore does not prove a comfortable reading or review flow.
The inspected CSS corroborates the mobile stacking: below 800 px it gives the assistant and thread
automatic height and visible overflow.
([Responsive styles](https://github.com/liveloveapp/hashbrown/blob/8b9e274189837ea75a6baa3c90788395de149029/examples/invoicing/react/src/styles.css))

**Observed:** reloading after the declined review preserved the selected payment through the URL,
but the conversation disappeared and starter prompts returned. **Documented:** the README explicitly
excludes browser-refresh recovery and warns against refreshing during a pending review. It also
identifies the ledger and allocations as simulated, with no actual transfers or reminders.
([Demo scope and limitations](https://github.com/liveloveapp/hashbrown/blob/8b9e274189837ea75a6baa3c90788395de149029/examples/invoicing/README.md))

**Inference for Veduta:** borrow shared object context, useful data components, and concrete
consequences before confirmation. The mobile stack and refresh limitation would fail Veduta's
current needs. Its desktop rail is a composition to study, not an accepted replacement layout.
Hashbrown's October 8 v0.7 release adds AG-UI 1.0 support and a component-schema export for agents
outside its runtime; those are integration capabilities, not evidence that adopting the framework
solves this interaction problem.
([First-party release announcement](https://hashbrown.dev/blog/2026-10-08-hashbrown-v-0-7-0))

## CopilotKit: all six gallery examples

**Observed:** all six examples linked from the [official gallery](https://www.copilotkit.ai/examples)
were opened, inspected, and given a synthetic task. Each was checked at 1280 × 800 and then resized
to 390 × 844. These are desktop-browser responsive checks, not real-device keyboard or touch tests.
The gallery's detail pages recommend a larger screen for their embedded previews. Independent
source inspection used commit
[`04bc56a`](https://github.com/CopilotKit/CopilotKit/tree/04bc56aeff506d8d529fe3ebd4b1b442c49fdee5/examples);
the hosted demos' exact revisions were not established.

| Example and live demo                                                       | Documented interaction                                                                                 | Observed task result                                                                                                                                                                                                                                     | Small-viewport observation                                                                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [Chat with your data](https://chat-with-your-data.vercel.app/)              | Existing dashboard charts supply context; an application component can render search results           | A revenue/profit comparison produced a Markdown table and text bars. No new interactive chart was generated in this run                                                                                                                                  | Open Chat occupied the viewport over the dashboard                                                                                       |
| [Travel Planner](https://examples-coagents-ai-travel-app.vercel.app/)       | Map and trip state accompany conversation; proposed trips expose selectable places before confirmation | A request for three Rome landmarks produced concrete place cards with Cancel/Add. After selecting them and pressing Add, the response claimed completion, but the inspected map/trip still showed New York; application of the proposal was not verified | Closing the full-width Chat exposed the map and floating controls; long proposal cards still required substantial vertical scrolling     |
| [State Machine Copilot](https://state-machine-copilot.vercel.app/)          | Stage-specific forms progress through a simulated car order, ending in a concrete confirmation         | The stage visualizer opened. A fictional contact-information request displayed a reasoning-duration label without a completed next-step form during the observation window                                                                               | The stage view and Chat stayed side by side; the composer was only about 116 px wide                                                     |
| [Form Filling Copilot](https://form-filling-copilot.vercel.app/)            | Manual controls and agent tools address the same incident-report fields                                | The response claimed it had prepared the fictional report, but the inspected form fields were empty. No report was submitted                                                                                                                             | The open Chat covered the form; closing it is needed to inspect the underlying form                                                      |
| [Project Manager](https://mastra-pm-canvas.vercel.app/)                     | Project/team/task state is presented as a board alongside conversation                                 | The seeded project and task were visible; a read-only question produced no answer during the observation window                                                                                                                                          | Open Chat covered the workspace; source uses 350 px task columns                                                                         |
| [Research Canvas](https://examples-coagents-research-canvas-ui.vercel.app/) | Question, resources, and draft are editable outside Chat; resource removal has explicit confirmation   | The workspace opened, but the requested short outline did not populate the draft or return an answer during the observation window                                                                                                                       | Fixed side-by-side composition overflowed: document width about 501 px in a 390 px viewport; question/draft fields shrank to about 48 px |

The unfinished model responses were rechecked after more than two minutes. These observations do
not establish their cause, or that a framework is defective. A successful narration is also not
evidence that application state changed. None of these sample tasks booked travel, submitted a
report, or placed an order. Source support for each documented pattern:

- [Dashboard and agent context](https://github.com/CopilotKit/CopilotKit/blob/04bc56aeff506d8d529fe3ebd4b1b442c49fdee5/examples/v1/chat-with-your-data/components/Dashboard.tsx).
- [Travel proposal review](https://github.com/CopilotKit/CopilotKit/blob/04bc56aeff506d8d529fe3ebd4b1b442c49fdee5/examples/v1/travel/components/humanInTheLoop/EditTrips.tsx).
  Its comparison uses place identities; it is not a complete current/proposed comparison of every
  changed field, as required by Veduta #227.
- [Order confirmation stage](https://github.com/CopilotKit/CopilotKit/blob/04bc56aeff506d8d529fe3ebd4b1b442c49fdee5/examples/v1/state-machine/src/lib/stages/use-stage-confirm-order.tsx).
- [Incident report form](https://github.com/CopilotKit/CopilotKit/blob/04bc56aeff506d8d529fe3ebd4b1b442c49fdee5/examples/v1/form-filling/components/IncidentReportForm.tsx).
  Its sample submit handler logs, alerts, and resets; it is not a production reporting service.
- [Project board](https://github.com/CopilotKit/CopilotKit/blob/04bc56aeff506d8d529fe3ebd4b1b442c49fdee5/examples/canvas/mastra-pm/src/app/components/KanbanBoard.tsx)
  and [persistence limits](https://github.com/CopilotKit/CopilotKit/blob/04bc56aeff506d8d529fe3ebd4b1b442c49fdee5/examples/canvas/mastra-pm/README.md).
  The inspected board has no direct task-edit or drag handlers; its appearance alone does not prove them.
- [Research work area](https://github.com/CopilotKit/CopilotKit/blob/04bc56aeff506d8d529fe3ebd4b1b442c49fdee5/examples/v1/research-canvas/src/components/ResearchCanvas.tsx)
  and [500 px Chat layout](https://github.com/CopilotKit/CopilotKit/blob/04bc56aeff506d8d529fe3ebd4b1b442c49fdee5/examples/v1/research-canvas/src/app/Main.tsx).

**Inference:** Travel, Research Canvas, and Form Filling supply the strongest interaction references
for Veduta: identify the work, keep its result addressable, and support direct controls as well as
conversation. The gallery includes stateful applications with predefined UI, not six demonstrations
of arbitrarily generated layouts. Its mobile failures make copying an entire demo composition a
poor substitute for checking Veduta's actual reading and review tasks.

**Documented:** CopilotKit's React V2 `CopilotSidebar` already combines a side panel, titled header,
close control, floating toggle, controlled opening, and a composer at the bottom. Whether it pushes
or overlays the application depends on the layout CSS. **Inference:** this supports the owner's
proposed interaction vocabulary; it does not establish a particular drawer height, width, or
automatic-opening policy.
([Official component reference](https://docs.copilotkit.ai/reference/v2/components/CopilotSidebar))

## What A2UI actually contributes

**Documented, version-sensitive:** the official site currently labels **v0.9.1** the production
release, **v0.9** previous stable, **v1.0** candidate, and **v0.8** legacy. Older research should not
be used as a current version inventory. The site demonstrates purpose-specific forms, charts, and
maps rendered from a client-provided catalog; its landscape example derives a tailored form after a
photo upload. Those are first-party demonstrations, not published usability comparisons.
([A2UI overview and demos](https://a2ui.org/))

**Documented:** A2UI separates component declarations from their data. Its current protocol defines
creation, component updates, data updates, and removal of a rendered region. It defines local and
server actions, catalog compatibility, and validation. It leaves the communication transport open.
These mechanisms permit incremental UI updates; they do not choose how much room a conversation
gets, how a phone moves between reading and work, or what constitutes Veduta consent.
([v0.9.1 specification](https://a2ui.org/specification/v0.9.1-a2ui/))

**Documented:** the action guide distinguishes local input changes from an explicit submission:
typing updates the local form model, and a submit action gathers its current values. Client checks
improve feedback but do not replace server validation. This is a useful interaction boundary:
editing a prepared choice need not produce a model round-trip for every adjustment.
([A2UI action model](https://a2ui.org/concepts/actions/))

### A concrete example, with its evidence boundary

The official restaurant example moves from an intent to results, a reservation form, and a
confirmation. The published quickstart requires a Gemini API key; this investigation did not run
that model-backed flow. Its interaction is therefore **documented**, not reported as a successfully
completed live reservation.
([Quickstart](https://a2ui.org/quickstart/))

The source at `ce03d005c0575ff6708da583d9e7658a34df2d5d` supplies an example form with party size,
date/time, dietary requirements, and one submission carrying the bound values. Its visible
controls make several choices inspectable together. The sample is v0.9 even though the current
documentation identifies v0.9.1; a demo's protocol version and the current release are different
facts.
([Pinned booking-form source](https://github.com/a2ui-project/a2ui/blob/ce03d005c0575ff6708da583d9e7658a34df2d5d/samples/agent/adk/restaurant_finder/examples/0.9/booking_form.json))

**Recorded demonstration inspected:** in the official landscape video, the frame at 0:23 shows an
uploaded garden photo followed by a guest-count slider and radio choices; 0:48 shows a proposed
garden with estimated cost, duration, and a selection control; 1:02 shows an itemized cart. The
work advances through task-specific views. This is a recording, not a live transaction or a
usability test performed here.
([Landscape recording](https://a2ui.org/assets/landscape-architect-demo.mp4))

The official custom-component recording shows a different composition: at 0:14 an explanation
appears beside a large chart. **Inference:** these two examples demonstrate that generative UI need
not be limited to small cards embedded in message bubbles. They do not establish persistence,
mobile reading quality, or consent semantics.
([Custom-component recording](https://a2ui.org/assets/a2ui-custom-component.mp4))

**Observed:** the public [A2UI Composer](https://a2ui-project.github.io/composer/) opened, as did its
[component gallery](https://a2ui-project.github.io/composer/gallery). Its Gemini assistant requested
an API key, so generation was not tested. This is a visual authoring reference, not evidence for an
end-user Chat layout. The official ecosystem comparison separates A2UI's rendering description
from AG-UI's communication responsibilities. **Inference:** borrowing the interaction pattern
requires neither framework adoption nor replacing Veduta's authority. Prior
[research 18](18-ag-ui-a2ui-subscriptions.md) already examines those integration boundaries.
([Composer documentation](https://a2ui.org/composer/),
[A2UI ecosystem comparison](https://a2ui.org/introduction/agent-ui-ecosystem/))

## Familiar patterns: ChatGPT and shadcn/ui

### ChatGPT: distinguish the conversation from reusable work

**Observed:** the logged-out [ChatGPT interface](https://chatgpt.com/) was inspected at 1280 × 800.
It gives the composer a clear primary position, groups secondary input tools, and separates
navigation from the conversation. A synthetic request for a long reading-list answer returned
`Unable to connect` with Retry. Consequently, this investigation does not claim a completed
long-answer, streaming, or authenticated ChatGPT editing test.

**Documented:** current OpenAI help describes writing/code blocks inside answers, direct editing,
selected-text revision, supported full-screen editing, and saved changes available to follow-up
requests. Availability varies by block, account, and device. The original October 2024 Canvas launch
is a historical reference, not a reliable inventory of the current product.
([Current writing/code block documentation](https://help.openai.com/en/articles/20001246-working-with-writing-blocks-and-code-blocks-in-chatgpt),
[original Canvas announcement](https://openai.com/index/introducing-canvas/))

**Inference:** reuse the familiar hierarchy: readable answer, restrained message actions, stable
composer, and clearly identifiable work with its own controls. Preserve Veduta's Space/Surface
model while making conversation comfortable. The owner's positive experience is relevant
preference evidence; it does not establish that every current ChatGPT behavior fits Veduta.

### shadcn/ui: reusable behavior, not only visual styling

**Documented:** the June 2026 chat release separates transcript scrolling from messages, model
state, transport, and persistence. Message rows, bubbles, attachments, and status markers are
independent pieces. This is a particularly useful boundary for Veduta's existing Gateway-owned
timelines.
([First-party release and composition rationale](https://ui.shadcn.com/docs/changelog/2026-06-chat-components))

The Message Scroller guidance recommends preserving the reader's place, following output only
while the reader is at its live edge, pausing movement during reading interactions, and anchoring
a new turn so the reply can be read from its beginning. It also covers prepended history and
opening saved threads with meaningful context. Its API makes scroll controls inactive when there
is nothing in their direction. **Inference:** these behaviors directly address Veduta's unwanted
scrolling and redundant “go to bottom” control. Same-session reopen should restore the actual
reading position; an initial thread-opening default is a separate decision.
([Interaction guidance](https://ui.shadcn.com/docs/components/base/message-scroller),
[scroll-control API](https://ui.shadcn.com/docs/react/message-scroller))

**Observed:** the live drawer example opened with delivery choices and explicit Confirm/Cancel;
after resizing to 390 × 844 it used a bottom panel with the same task. The Message Scroller
anchoring example was also exercised. These are isolated component demonstrations, not a verified
mobile Chat workflow, touch-dismissal test, or keyboard test.
([Drawer demo](https://ui.shadcn.com/docs/components/base/drawer),
[Message Scroller demo](https://ui.shadcn.com/docs/components/base/message-scroller))

**Documented, version-sensitive:** current default Drawer documentation uses Base UI and provides
a Vaul migration guide; Sheet extends Dialog and can open from any edge. Veduta already owns
shadcn-derived Radix Sheet and Sidebar components with catalog tokens. A new Base UI dependency
or wholesale component replacement is not implied by studying the latest website.
([Drawer](https://ui.shadcn.com/docs/components/base/drawer),
[Sheet](https://ui.shadcn.com/docs/components/base/sheet),
[Veduta Sheet](../../packages/catalog/src/ui/sheet.tsx),
[Veduta Sidebar](../../packages/catalog/src/ui/sidebar.tsx),
[visual language](../VISUAL-LANGUAGE.md))

The Vaul author's engineering account is valuable for the otherwise invisible details: distinguishing
scrolling from dragging, avoiding accidental dismissal at the top of a fast scroll, and handling
the software keyboard. It is primary design/engineering rationale, not a controlled usability study
or the current Base UI implementation specification.
([Emil Kowalski: building a drawer](https://emilkowal.ski/ui/building-a-drawer-component))

**Inference:** “smooth” should mean stable reading position, predictable focus and dismissal,
appropriate keyboard resizing, and interruptible motion. A drawer for reading must not focus the
composer automatically. WAI-ARIA guidance supports initial focus on a static heading when a dialog
contains long structured content, focus containment, a visible close control, and focus return to
the invoker. Drawer closing should preserve the draft and leave unresolved decisions pending.
([WAI-ARIA modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/))

The inspected shadcn sources publish concrete interaction rationale and component behavior. They
do not supply a controlled study proving that a FAB/drawer is the best Chat layout. Keep that
evidence distinct from the empirical studies below.

## Primary UX evidence

### DirectGPT: keep the result addressable

**Documented:** DirectGPT keeps the current result visible, permits selection-scoped prompts,
offers reusable commands, highlights changes, and supports undo/redo. Its CHI 2024 within-subject
study involved 12 participants with programming and ChatGPT experience, editing text, code, and
vector images. The authors report roughly 50% faster completion, 50% fewer prompts, and 72% shorter
prompts than their ChatGPT replica, using the same model. Their limitations include the expert
sample, model dependence, and bounded editing tasks; selection is not always easier than describing
a set in words.
([Original paper, especially §§3–5](https://arxiv.org/html/2310.03691v2))

**Inference:** a request such as “change this deadline” should carry the selected Surface or item as
visible context, rather than requiring its title to be rewritten in Chat. The result should remain
easy to locate. These findings support evaluating precise object references, not claiming that a
particular sidebar or automatic panel transition is proven superior on phones.

### DynaVis: use language to obtain useful controls

**Documented:** DynaVis generates a persistent control after a chart-editing request, allowing
subsequent adjustments without another model call. Its CHI 2024 study had 24 participants and
compared dynamic controls with natural language plus basic static controls. Twenty-three
participants preferred DynaVis; natural-language requests dropped from an average 8.4 to 2.67 per
task. Completion-time and per-condition NASA-TLX differences were **not statistically significant**.
Five participants warned that accumulating controls could become overwhelming during longer use.
([Original paper, especially §§4–6](https://arxiv.org/html/2401.10880v1))

**Inference:** “fewer clicks” should distinguish navigating the shell from directly changing the
work. Removing an unnecessary open/expand step can help; replacing a clear checkbox or date control
with another prompt can increase effort. Keep recurring controls predictable and contextual, not a
growing stream of newly generated panels. This study does not demonstrate mobile usability or
long-term use.

### Data Formulator 2: make iteration context explicit

**Documented:** this system combines graphical chart specification with natural-language data
transformation. Its data threads retain previous results for reuse and branching. An eight-person
study examined how participants completed iterative analysis; it was not a controlled comparison
proving a universal speed advantage. The paper's screenshots, workflow, and code are available as
primary evidence.
([Original 2024 paper, especially §§3–4](https://arxiv.org/html/2408.16119v1),
[Microsoft source](https://github.com/microsoft/data-formulator))

**Inference:** returning to an earlier answer or Surface should expose which result a follow-up
will affect. Preserve useful work across navigation. This does not justify adding branching Chat
history to Veduta: scoped durable timelines and stable Surface identities already provide the
relevant starting point.

### Cocoa: make steering possible within the work

**Documented:** the CHI 2026 paper compared integrated document planning/execution with the same
editor beside a familiar Chat, using the same agent and tools. Its counterbalanced study involved
16 researchers, followed by a seven-day deployment with seven researchers. Perceived ability to
steer the agent improved (median 4 versus 3; p = .005); differences in ease of use and general
utility were not significant. The specialized sample and bundled interaction changes limit
generalization, and layout was not isolated experimentally.
([Latest paper, §§5–7 and limitations](https://arxiv.org/html/2412.10999v4))

**Inference:** a right-hand Chat becomes useful when requests, editable results, and correction
refer to the same work. Simply putting two panels beside each other does not establish that
relationship. This supports contextual controls and precise review, not a new planning hierarchy.

### Mobile reading: scrolling itself is not the demonstrated problem

**Documented:** a CHI 2025 extended-abstract study randomly assigned 100 smartphone participants
to scrolling or paging while reading roughly 1,500-word stories. It found no significant difference
in comprehension, reading duration, or subjective workload. Null results do not prove equivalence.
The task did not include Chat streaming, a keyboard, drawers, or approval controls.
([Joshi, Casiez, and Vogel: original paper](https://nikhitajoshi.ca/papers/scroll-vs-page.pdf))

**Inference:** retain familiar scrolling and fix the insufficient reading area, obstructing controls,
and lost position reported in Veduta. There is no evidence here for replacing long responses with
pagination or assuming that fewer scroll gestures alone improve reading.

### Interruption and resumption: retain cues for returning to work

**Documented:** Iqbal and Horvitz observed 27 information workers over two weeks and interviewed 14. More obscured task windows were associated with slower return after interruptions; participants
also used positions and highlights as resumption cues. This was observational desktop research,
not a causal test of Chat sidebars or mobile drawers.
([CHI 2007 primary paper](https://erichorvitz.com/chi_2007_iqbal_horvitz.pdf))

**Inference:** preserve the Surface selection, draft, and reading position, and identify the work
being resumed. On mobile, retaining these cues matters even when there is insufficient room to
keep both regions visible. No recovery-time prediction for Veduta follows from this study.

### Human–AI interaction guidelines: control and intelligible consequences

**Documented:** Amershi et al.'s CHI 2019 guidelines were refined through multiple evaluation stages,
including 49 design practitioners examining 20 AI-infused products. Relevant guidance concerns
context-appropriate timing, relevant information, easy invocation/dismissal/correction, cautious
adaptation, recent interaction context, and explaining the consequences of user actions. The study
evaluates guidelines' clarity and applicability; it does not experimentally compare Veduta-like
Chat layouts.
([Original paper, Table 1 and validation method](https://www.microsoft.com/en-us/research/wp-content/uploads/2019/01/Guidelines-for-Human-AI-Interaction-camera-ready.pdf))

**Inference:** completion should identify the affected result, and a proposed change should expose
its concrete effect before resolution. Automatically opening an answer after a user's request may
reduce friction, while automatically interrupting unrelated reading can create it. The conditions
for attention changes need to be designed and tested, not inferred from “AI” or “generative.”

## Transfer matrix

### Established heuristics as a review lens

Nielsen's heuristics explicitly emphasize familiar conventions, visible status, recognition over
recall, user control, restrained information, and intelligible recovery. These are general review
principles, not a study comparing the candidate layouts.
([Original heuristics and current explanation](https://www.nngroup.com/articles/ten-usability-heuristics/))

**Inference for this review:** a recognizable Chat control should open a usable conversation in
one step; a Space/Surface name should show the target; secondary model settings should not compete
with reading; and approval copy should describe the effect in the user's language. A terse success
notice and a decision still needing an answer have different lifetimes. These checks explain why
familiar controls matter without assuming that familiarity alone guarantees usability.

### Mapping evidence to Veduta

| Problem in Veduta                               | Evidence worth transferring                                              | Candidate behavior to evaluate                                                                       | What the evidence does not settle                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Describing which content to change              | DirectGPT's addressable output; explicit context in Data Formulator      | An obvious selected target carried into the composer and the reply                                   | Whether selecting individual Atoms is necessary or understandable                          |
| Repeating precise adjustments through Chat      | DynaVis's reusable controls; A2UI form submission                        | Use existing fast-path controls beside the content; reserve language for intent and judgment         | How many controls each Surface should expose                                               |
| Opening a panel just to read a requested result | Owner's rejection of both prototypes; context-sensitive HAI guidance     | Let the request lead into comfortable reading with an obvious route back to its result               | Whether automatic expansion, a continuous page, or another composition best fits the phone |
| Accepting an opaque change                      | #227's verified truncation/removal problem; HAI consequence guidance     | Target, current/proposed content, and consequences visible together; details retain complete content | Whether side-by-side, inline, or sequential comparison reads best on mobile                |
| Losing the thread when returning to work        | Data Formulator's explicit iteration context; Veduta's stable identities | Retain draft, reading position, selected target, and exact pending review through navigation         | Long-term preference storage and cross-device reading-position policy                      |
| Too many dynamic or permanent controls          | DynaVis's long-session concern; cautious adaptation guidance             | Stable navigation and predictable controls; contextual detail close to its task                      | Final placement of model selection and secondary management                                |

All candidate behaviors are **inferences for discussion**, not approved acceptance criteria.
The table concerns interaction, not a proposal to reproduce the external products' visual styling.

## Phone reading and review constraints

The inspected research gives no strong basis for claiming that an expandable Chat is the best
mobile solution. Its value must be checked using Veduta tasks, real long content, the software
keyboard, and transitions between work and reading. Framework support for mobile is a portability
claim, not this usability evidence.

W3C's reflow guidance requires ordinary content to remain usable at the equivalent of 320 CSS
pixels without two-dimensional page scrolling, with exceptions for content whose meaning requires
two dimensions. Its focus criterion prevents authored overlays from entirely obscuring a focused
control. These are accessibility constraints, not evidence that a zero-overflow screenshot is
comfortable to read.
([Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html),
[Focus Not Obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html))

**Inference:** the next prototype should have one clearly dominant reading or working region at a
time on the phone. It should not force long content into a small nested scroller or bury a decision
under a composer. Desktop can show more simultaneous context while preserving the same identities
and action meanings. The exact transition should be demonstrated, not prescribed by this report.

## Recommended direction for the next prototype

This is a **research recommendation**, incorporating the owner's latest candidate. It is not an
approved production layout or an implementation ticket. Start with one familiar composition and
evaluate complete tasks:

| Area               | Proposed behavior                                                                                                                                                              | Basis and remaining question                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Desktop            | Space content in the main region; Chat visibly docked on the right at a readable width, with its own transcript and composer                                                   | Owner preference and CopilotKit composition; determine the breakpoint from usable content widths rather than device names      |
| Mobile entry       | A stable floating control labelled Chat; opening it directly provides the full available reading area                                                                          | Familiar launcher/drawer vocabulary; verify reach, discoverability, and that it never covers a Surface action                  |
| Mobile reading     | One open drawer state with a visible return control, a generously sized transcript, and compact composer                                                                       | Owner's rejection of cramped reading; do not require another expansion action after opening                                    |
| Input and scroll   | Opening to read focuses a heading, not the text field; explicit text-field interaction opens the keyboard. Reading pauses follow-output; returning restores position and draft | WAI-ARIA, shadcn scrolling guidance, and existing owner requirements; physical Android keyboard and back behavior need testing |
| Work and context   | Space and relevant Surface are evident in Chat; structured results use existing components and direct controls                                                                 | Hashbrown, Travel, DirectGPT, and Cocoa; selecting content must not silently retarget an in-flight request or pending change   |
| Review             | The actual current/proposed change is readable, with explicit Accept/Decline. Pending review stays discoverable when Chat is closed                                            | #227, concrete demo proposals, and HAI guidance; the drawer closes independently of resolving a decision                       |
| Secondary controls | Model choices sit behind a familiar header control; one restrained generation status; completed feedback clears while durable history remains                                  | Owner candidate and consistency/minimalism heuristics; final model-control placement remains for review                        |

An unresolved review may justify a clearly labelled attention indicator on the Chat entry and the
existing decision entry point. It must not become a permanently scrolling success badge. A drawer
may be dismissed without cancelling work; reopening it must not create a new conversation. These
are proposed behaviors to verify against the existing state contracts, not new state owners.

Reuse Veduta's shadcn-derived controls and approved visual tokens first. Evaluate Message Scroller
as a replaceable presentation primitive if its behavior matches the selected design; it should
not take ownership of messages or Gateway persistence. If touch dragging is useful, evaluate a
maintained drawer implementation for that requirement rather than hand-writing gesture physics.
The current compact-bottom-shell description in the visual language would need an explicit update
after design approval. This research leaves that canonical production description unchanged.

## What the next discussion and prototype must answer

The next discussion should walk through the following jobs using the same realistic data in the
recommended composition. This is a proposed evaluation sequence, not an implementation plan.

1. **Ask and read:** from a populated Space, ask a substantive question and read a long reply. Count
   shell navigation/expansion actions separately from content actions and scrolling. Observe
   whether the user recognizes what is happening without explanations.
2. **Refer and adjust:** ask for a change to the currently relevant Surface, then adjust one
   deterministic field. Check whether the target and resulting change are obvious without
   retyping a title or navigating an unrelated page.
3. **Review and decide:** inspect a replacement and a removal deep inside long content; explain
   what acceptance and rejection do before using either control. A generic “change tree” title is
   not a successful review. Keep complete detail available, following
   [#227](https://github.com/Ic3b3rg/veduta/issues/227).
4. **Resume:** return to the work and then to the reply. Check draft, selection, reading position,
   exact decision, refresh, and reconnect. Durable domain state must still come from the existing
   Gateway contracts.
5. **Recover:** show a failed request and a stale proposal. Distinguish retrying a read from repeating
   a potentially effectful operation; never turn a generic error into success through visual
   polish.

**Proposed success measures:** the owner can identify the current target and primary next action;
read a long answer comfortably; explain a proposed change before accepting; find the affected
Surface; and resume without reconstructing context. Count avoidable navigation, lost position,
ambiguous target choices, correction effort, and time to understand the effect. Treat lower raw
click counts as supporting information, not the only definition of usability.

The established visual direction and accepted header remain available foundations. No source here
authorizes replacing Home with a response stream, model-generated markup, a second approval
mechanism, or browser-owned domain state. The next owner review should evaluate a complete
interaction with real work rather than another pair of differently sized Chat containers.
([Visual language](../VISUAL-LANGUAGE.md), [ADR-0001](../adr/0001-home-first.md),
[ADR-0003](../adr/0003-declarative-atoms.md),
[ADR-0019](../adr/0019-channel-neutral-pending-decisions.md),
[ADR-0031](../adr/0031-pwa-live-state-runtime.md))
