# Research 02 — Does a "home-first" personal agent already exist? (gap check)

> Conducted on 2026-07-02. Question: is anyone already shipping persistent surfaces per life area, owned and updated by the agent, with chat that modifies them?

## Candidates

**1. Skye (Signull Labs) — the closest.** An "agentic homescreen" for iPhone built on iOS widgets: weather/context, health, meeting prep, email drafts, banking alerts, recommendations. Persistent widgets updated in the background by the agent. **Not launched** (waitlist, $3.58M pre-seed from a16z/True Ventures, $19.5M valuation). Limitations: WidgetKit is read-only and timeline-based (not agent-owned surfaces), iPhone-only, no evidence of chat modifying the surfaces. [TechCrunch, Apr 2026](https://techcrunch.com/2026/04/27/investors-back-skye-signull-labs-ai-home-screen-app-for-iphone-ahead-of-launch/)

**2. Amazon Alexa+ (Echo Show/Hub).** A dashboard of persistent widgets (up to 8 XXL) + voice input that acts on the content. But: widgets are user-configured, the domain is home/schedule, dedicated hardware. The most concrete precedent, not a direct competitor. [About Amazon](https://www.aboutamazon.com/news/devices/getting-started-echo-show-8-11-alexa-plus-features)

**3. OpenClaw Canvas (A2UI).** A **per-session** visual workspace, secondary to the chat ("one Canvas panel visible at a time"). Dashboards = 45% of usage, but they remain chat-driven artifacts. [docs.openclaw.ai/platforms/mac/canvas](https://docs.openclaw.ai/platforms/mac/canvas)

**4. Google Gemini "Dynamic View".** UIs generated **per prompt**, ephemeral, chat-first, a Labs experiment. [research.google](https://research.google/blog/generative-ui-a-rich-custom-visual-interactive-user-experience-for-any-prompt/)

**5. Bee (Amazon) / Limitless (Meta).** "Daily Memory", retrospective insights from wearables — narrative logs, not current state per life area.

**6. Notion Dashboard Views + Agent.** Persistent dashboards the agent can generate on request — views over work databases, not proactively maintained, not life areas. [notion.com/releases/2026-03-26](https://www.notion.com/releases/2026-03-26)

**7. Others.** Dot (New Computer): shut down Oct 2025. Hermes v0.16 "surfaces": desktop/web/admin for operating the agent. LifeOS (Miessler): a DIY framework.

## Verdict

**Partially covered — the specific territory is open.** No shipped product matches: a general-purpose app where the primary screen is a set of per-life-area surfaces owned and proactively updated by the agent, with chat as the modification tool. Skye is aiming at it (a16z validation of the space) but it is not launched, is iPhone-only, and is chained to WidgetKit → our differentiators: open source, cross-platform (PWA), truly agent-owned surfaces.

**Competitive corollary:** move knowing that Skye will launch something similar.
