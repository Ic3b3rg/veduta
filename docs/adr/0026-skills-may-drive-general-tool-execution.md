# Skills may drive general tool execution

Veduta is a general personal Agent whose durable product interface is the Home: text and validated,
generative Surfaces maintained inside Spaces. That product boundary does not require every external
capability to be redesigned as a narrow provider-neutral adapter before the Agent can use it.
Requiring that boundary would turn each mature CLI or API into a new vertical integration, delay
the long tail of useful work, and make the Agent materially less capable than the tools already
installed on its self-hosted machine.

Official Skills remain first-party, repository-reviewed, versioned Agent Skills packages. In v1
they contain a concise `SKILL.md` plus focused one-hop Markdown references. Interactive turns let
the Agent select and load one or more relevant Skills autonomously; confirmed Automations preload
their associated compatible Skill set. The catalog grows with real product work rather than from a
launch quota, marketplace, or user-facing picker.

A loaded Skill may teach the Agent to use any tool available to the current turn, including
Veduta-owned typed tools, a Veduta-owned general execution tool, external CLIs, and provider APIs.
It may include commands for detecting, installing, configuring, and operating a compatible external
dependency. A missing command may put a Skill into setup mode instead of hiding it: on an explicit
user request the Agent performs the supported setup itself and asks only for information or
credentials it cannot obtain. Provider-native command execution offered by an inference runtime
remains disabled; all execution still enters through `AgentRunner` and Veduta's own tool registry so
Model connection parity, cancellation, session ownership, Trace, and output handling remain ours.

The v1 package itself contains no executable support files. First-party `scripts/` and other
executable assets remain a v1.1 addition and are reviewed, tested, and released as product code.
This does not prohibit a v1 Markdown Skill from invoking an existing external executable or using
the general execution tool to run documented setup commands. Official releases load only
first-party Skills; forks may add or replace any Skill or executable without changing Veduta's
upstream support boundary.

A Skill still grants no tool, credential, Space, trigger, or permission. However, a general
execution tool is intentionally broad: its command semantics cannot be completely classified by a
domain-specific schema. Trust levels, Approval cards, and a confirmed Automation's
`trigger -> operation -> result` remain product policy and user-facing control, but they are not
claimed as an unbypassable capability sandbox for arbitrary commands. Official Skills must request
Approval before consequential external actions, follow the confirmed Automation literally, and
record the commands and outcomes needed for truthful Trace and audit. Typed tools may continue to
enforce stronger invariants where their cost is justified; they are an optimization and hardening
option, not the only valid execution path.

External command and provider output is Untrusted. Skills should use the quarantined reader for
unattended extraction and bounded summaries, while an explicit interactive task may bring required
raw content into the Agent's current context with its origin preserved. Sensitive raw content must
follow the feature's persistence contract; for personal mail it remains transient even when a CLI
produces it. Secrets stay outside model context in the vault, operating-system keyring, or
credential files and are resolved only by the executing process. Every persistent UI result must
still validate as a Surface made from the closed Atom catalog.

The first command-backed consumer is the Himalaya path in issue #123. The Mailbox assistant Skill
owns user intent, scope, reply discipline, and result shape; a Gmail Skill may use native Gmail
operations, while the Himalaya Skill may teach direct CLI commands for generic IMAP/SMTP accounts.
They converge on the same text and Mailbox Surface experience without pretending their execution
mechanisms are identical.

This decision supersedes [ADR-0025](0025-first-party-skills-over-typed-tools.md), refines the
universal enforcement claims in [ADR-0007](0007-trust-levels.md), and refines the implementation
boundary—but not the pull-based access contract—in
[ADR-0024](0024-pull-based-personal-mailbox.md). Research and the earlier alternative are preserved
in [research 16](../references/16-hermes-skills-architecture.md).

Status: accepted
