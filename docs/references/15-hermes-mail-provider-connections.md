# Research 15 — Mail provider connections in Hermes Agent

> Conducted on 2026-08-19 against the official Hermes Agent documentation and
> [NousResearch/hermes-agent at `13ce0c5`](https://github.com/NousResearch/hermes-agent/commit/13ce0c5c675e843af70d19c9e5144249cd51c8d1).
> Scope: every bundled or optional path that connects to or operates email, including
> credential handling, account ownership, multi-account behavior, and provider abstraction.
> Statements labelled **absence** or **inference** are not documented product guarantees.

## Finding

Hermes does not have one native mailbox-provider contract. It has several independent paths
with different purposes and command shapes:

| Path                                                               | Mailbox and providers                                                                                                                                            | Connection and credential location                                                                                                                                   | Account multiplicity                                                                                                       | Principal capabilities                                                                                                      |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Email gateway adapter                                              | Dedicated agent account; claims Gmail, Outlook, Yahoo, Fastmail, or any IMAP/SMTP provider                                                                       | Python `imaplib`/`smtplib`; address, password or app password, and hosts in `~/.hermes/.env`                                                                         | One scalar account per profile; the gateway can multiplex profile adapters                                                 | Continuously poll new inbound mail and reply in-thread; not general mailbox management                                      |
| Himalaya bundled skill                                             | Personal or dedicated account; any backend supported by Himalaya, documented as IMAP/SMTP, Notmuch, or Sendmail                                                  | External `himalaya` CLI and `~/.config/himalaya/config.toml`; password command/keyring recommended, raw password or generic OAuth2 also documented                   | Native named multi-account config and `--account` selection                                                                | List, search, read, compose, reply, forward, move, copy, delete, flags, and attachments                                     |
| Google Workspace bundled skill                                     | The user's Gmail account                                                                                                                                         | Google OAuth desktop-client flow; client secret and refreshable token JSON under the active Hermes home; `gws` CLI when present, otherwise bundled Google API client | **Inference:** one Google identity per Hermes profile, because there is one token file and all Gmail calls use `userId=me` | Gmail search/get/send/reply/list labels/modify labels, plus non-mail Workspace APIs                                         |
| AgentMail optional skill                                           | Agent-owned hosted inboxes, explicitly not the user's personal mailbox                                                                                           | `agentmail-mcp` launched through `npx`; AgentMail API key pasted into `~/.hermes/config.yaml`                                                                        | Multiple inbox resources under one API key                                                                                 | Create/delete/list inboxes; list/get threads; send/reply/forward/update; attachments                                        |
| Native Codex plugins through the optional Codex app-server runtime | Gmail and Outlook/Microsoft are claimed examples                                                                                                                 | Provider authorization is performed in Codex's UI; Hermes discovers installed Codex plugins and writes enablement into `~/.codex/config.toml`                        | **Absence:** Hermes does not document provider-token storage or multi-account behavior                                     | Gmail read/send and Outlook calendar/email are claimed; detailed mail operations are delegated to the external Codex plugin |
| `unbroker` optional security skill                                 | The operator's mailbox, but only for data-broker opt-out email; inferred presets for Gmail, Outlook/Hotmail/Live, Yahoo, iCloud, and Fastmail, or explicit hosts | Its own Python `imaplib`/`smtplib` client using `EMAIL_*`; alternatively logged-in webmail or AgentMail                                                              | One scalar `EMAIL_ADDRESS`                                                                                                 | Recipient-locked SMTP opt-out requests and read-only IMAP polling for verification links; not a general mailbox connector   |

The bundled `email-inbox-triage` skill is an orchestration policy, not another connection.
It tells the Agent to load Himalaya, Google Workspace, or another relevant connector, then
defines scope, classification, approval, and verification rules. Provider commands remain in
the connector skills.
([triage ownership and routing](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/email/email-inbox-triage/SKILL.md#L14-L36),
[approval and verification](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/email/email-inbox-triage/SKILL.md#L53-L63))

## 1. Email gateway: email as a chat transport

The built-in gateway is for people to email the Agent, not for the Agent to manage a user's
mailbox. Hermes explicitly requires a dedicated account and distinguishes this path from
Himalaya. It polls IMAP `UNSEEN`, converts allowed incoming messages into Hermes conversation
events, and sends SMTP replies with `In-Reply-To` and `References` headers.
([documented distinction and claimed providers](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/website/docs/user-guide/messaging/email.md#L7-L28),
[polling and replies](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/website/docs/user-guide/messaging/email.md#L94-L123))

Setup uses a mailbox password or app password stored in `~/.hermes/.env`; the documentation
instructs operators to protect that file with mode `0600`. The implementation logs into IMAP and
SMTP with the address and password, so it implements password authentication rather than OAuth.
([configuration and storage](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/website/docs/user-guide/messaging/email.md#L53-L81),
[security guidance](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/website/docs/user-guide/messaging/email.md#L172-L181),
[IMAP/SMTP implementation](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/plugins/platforms/email/adapter.py#L630-L715))

The configuration surface has one `EMAIL_ADDRESS`, password, IMAP host, and SMTP host. The
adapter's process-level UID cache is keyed by address because a multiplex gateway can host
several profile adapters. Therefore the supported multi-account shape is one account per profile,
not a named-account selector within one Email adapter.
([scalar configuration](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/gateway/config.py#L2163-L2184),
[multiplex implementation note](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/plugins/platforms/email/adapter.py#L529-L559))

## 2. Himalaya: broad mailbox operation through an external CLI

Himalaya is Hermes's broadest provider-neutral mailbox path. The skill shells out to the
external CLI, which can use IMAP/SMTP, Notmuch, or Sendmail. It exposes the usual mailbox
operations and structured JSON output; Hermes itself does not translate these into a typed mail
API.
([backend and integration boundary](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/email/himalaya/SKILL.md#L16-L34),
[operations](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/email/himalaya/SKILL.md#L102-L155),
[mutations and flags](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/email/himalaya/SKILL.md#L214-L246))

Himalaya owns its credentials outside Hermes. Its config may contain a raw password, invoke a
secret-manager command such as `pass` or macOS Keychain, use a system keyring, or configure a
generic OAuth2 flow. The Hermes reference recommends command or keyring storage. Multiple named
accounts are a first-class feature and are selected with `--account`.
([credential choices](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/email/himalaya/references/configuration.md#L39-L60),
[multiple accounts](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/email/himalaya/references/configuration.md#L163-L180),
[generic OAuth2](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/email/himalaya/references/configuration.md#L182-L202))

Hermes gives concrete Gmail and iCloud examples, while its dedicated-agent guide claims Gmail,
Outlook, Fastmail, Migadu, and custom-domain IMAP/SMTP accounts. The skill itself uses a
`personal` account in its example, so the connector is technically suitable for either personal
or agent-owned mail even though the autonomous-agent guide recommends a low-privilege dedicated
mailbox.
([personal account example](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/email/himalaya/SKILL.md#L49-L80),
[provider examples](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/email/himalaya/references/configuration.md#L62-L123),
[dedicated-account recommendation](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/website/docs/guides/agent-email-address.md#L6-L21))

## 3. Google Workspace: a Gmail-specific API path

The bundled Google Workspace skill operates Gmail through Google APIs. It prefers the external
`gws` CLI when installed and otherwise uses `google-api-python-client`, while keeping a JSON CLI
contract. Gmail operations use `userId="me"` and cover search, full-message fetch, send, threaded
reply, label listing, and label modification.
([backend selection and setup](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/productivity/google-workspace/SKILL.md#L20-L37),
[documented Gmail commands](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/productivity/google-workspace/SKILL.md#L168-L200),
[Gmail API implementation](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/productivity/google-workspace/scripts/google_api.py#L203-L314))

The user creates a Google Cloud desktop OAuth client. Hermes stores
`google_client_secret.json`, a refreshable `google_token.json`, and temporary PKCE state under the
active, profile-scoped Hermes home; `gws` consumes the same token. **Implementation inference:**
there is one active Google identity per Hermes profile because filenames are singular and Gmail
calls are fixed to `me`; Hermes documents no within-profile account selector.
([OAuth procedure and token storage](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/productivity/google-workspace/SKILL.md#L83-L165),
[profile-scoped path resolution](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/productivity/google-workspace/scripts/_hermes_home.py#L1-L32),
[`gws` token bridge](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/productivity/google-workspace/scripts/gws_bridge.py#L21-L106))

### Documented least-privilege control is not implemented at this revision

The skill tells the Agent to pass `--services email,calendar` or another narrowed service list.
At the pinned revision, `setup.py` defines no `--services` or `--format` arguments, constructs the
authorization URL from one fixed `SCOPES` list, and requests Gmail read/send/modify together with
Calendar, Drive, Contacts, Sheets, and Docs. It can tolerate scopes that the user manually declines,
but the documented service-selection mechanism does not exist. This is a documentation/source
mismatch and means the standard setup is not least-privilege by service.
([documented service selection](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/productivity/google-workspace/SKILL.md#L53-L73),
[documented command examples](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/productivity/google-workspace/SKILL.md#L118-L145),
[fixed scopes and parser](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/productivity/google-workspace/scripts/setup.py#L42-L56),
[authorization request](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/productivity/google-workspace/scripts/setup.py#L362-L380),
[actual CLI arguments](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/productivity/google-workspace/scripts/setup.py#L485-L495))

## 4. AgentMail: hosted, agent-owned inboxes via MCP

AgentMail is an optional skill for giving the Agent its own hosted identity. It explicitly says
not to use it for a user's personal email. Hermes runs `agentmail-mcp` through `npx`; because MCP
environment values are not expanded from `.env`, the documented setup places the API key directly
in `~/.hermes/config.yaml`.
([ownership and requirements](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/optional-skills/email/agentmail/SKILL.md#L14-L31),
[MCP and credential configuration](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/optional-skills/email/agentmail/SKILL.md#L33-L54))

One key can list and create multiple inboxes. The exposed tools operate inbox and thread resources,
send/reply/forward, update message state, and fetch attachments. Real-time receive requires a public
webhook endpoint; the skill recommends `list_threads` polling from cron for personal deployments.
([tool set](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/optional-skills/email/agentmail/SKILL.md#L56-L91),
[polling limitation](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/optional-skills/email/agentmail/SKILL.md#L110-L115))

## 5. Codex plugins: optional Gmail and Microsoft connectors owned by another runtime

When the opt-in Codex app-server runtime is enabled for OpenAI/Codex turns, Hermes can discover
native Codex plugins already installed by the user. Hermes documentation names Gmail read/send and
Outlook calendar/email through a Microsoft connector. These plugins are authorized once through
Codex's UI; Hermes queries `plugin/list` and writes their activation entries to
`~/.codex/config.toml`.
([documented plugin model and capabilities](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/website/docs/user-guide/features/codex-app-server-runtime.md#L6-L56),
[setup and migration](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/website/docs/user-guide/features/codex-app-server-runtime.md#L150-L185),
[migration implementation](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/hermes_cli/codex_runtime_plugin_migration.py#L450-L507))

This is a real supported route but not a Hermes-owned mail implementation. **Absence:** the Hermes
sources do not define the provider's OAuth scopes, provider-token storage, multi-account semantics,
or a stable mail operation schema for these plugins. They are opaque tools supplied and managed by
the Codex runtime.

## 6. Outlook and Microsoft status

Hermes has no native Microsoft Graph mailbox client at this revision. Its own Graph application
and webhook support is for Teams meetings, transcripts, recordings, chats, and calendar-style
events; its documented permissions do not include `Mail.Read`, `Mail.ReadWrite`, or `Mail.Send`.
The only documented Microsoft mail routes are generic IMAP/SMTP through the gateway or Himalaya,
or the optional external Codex Microsoft connector.
([Hermes Graph purpose](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/website/docs/guides/microsoft-graph-app-registration.md#L6-L18),
[documented Graph permissions](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/website/docs/guides/microsoft-graph-app-registration.md#L52-L87),
[webhook scope](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/website/docs/user-guide/messaging/msgraph-webhook.md#L7-L17))

There is an important compatibility caveat. Hermes's Email guide tells Microsoft 365 users to
create an app password, while the adapter calls password-based `imap.login()` and `smtp.login()`.
Microsoft says Basic authentication is disabled in all Exchange Online tenants, that this blocks
app passwords, and that IMAP/SMTP clients must use OAuth 2.0 or another modern API. Therefore the
documented gateway recipe should not be treated as current Exchange Online support. Himalaya's
generic OAuth2 configuration could provide a route, but Hermes ships no Outlook-specific OAuth
wizard or values.
([Hermes Outlook recipe](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/website/docs/user-guide/messaging/email.md#L30-L49),
[Microsoft Basic-auth status](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online),
[Microsoft IMAP/SMTP OAuth guidance](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth))

## Specialized and non-connector paths

The optional `unbroker` skill has its own narrow email client. It reuses scalar `EMAIL_*`
credentials, infers common provider hosts, restricts SMTP recipients to known data-broker privacy
addresses, and opens IMAP read-only to find verification links. It is reusable evidence about
protocol implementation, but it is intentionally not a general mailbox surface.
([scope and connection modes](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/optional-skills/security/unbroker/SKILL.md#L27-L31),
[credentials and providers](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/optional-skills/security/unbroker/SKILL.md#L64-L92),
[protocol implementation](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/optional-skills/security/unbroker/scripts/emailer.py#L1-L82))

Generic computer-use can drive Mail, Outlook, or Thunderbird through their existing logged-in UI.
That is an application-automation escape hatch, not provider authentication or a mailbox contract.
Likewise, the Telegram adapter's `gmail-triage` callbacks only dispatch operator-supplied scripts
from `~/.hermes/scripts/gmail-triage`; those scripts are not bundled and do not constitute another
connection.
([computer-use boundary](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/autonomous-ai-agents/computer-use/SKILL.md#L339-L350),
[Telegram script hook](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/plugins/platforms/telegram/adapter.py#L7392-L7452))

## No common Hermes mail-provider interface

**Absence:** no common `MailboxProvider`, capability schema, normalized message/thread type, or
provider registry was found in the official paths above. The integration boundary is procedural:

- the Email gateway implements a platform adapter for inbound chat events;
- Himalaya and Google Workspace are skill-authored terminal commands with different JSON shapes;
- AgentMail supplies MCP tools with its own inbox/thread resource model;
- Codex plugins are opaque tools in an optional external runtime; and
- inbox triage instructs the model to choose a connector and apply common policy.

The nearest shared layer is the natural-language triage procedure, not a programmatic provider
interface. Consequently, support for a provider in one path does not imply the same authentication,
capabilities, or behavior in another.

## Implications for Veduta's Gmail + IMAP/SMTP contract

1. **Normalize the product outcome, not every connector command.** Gmail API, Himalaya CLI, MCP,
   and future tools may expose different semantics to the Agent. Veduta should make their durable
   text, Mail summaries, and Mailbox Surfaces coherent without rebuilding each mature tool behind a
   mandatory provider-neutral adapter.
2. **Keep connector expertise explicit in Skills.** Gmail thread IDs, labels, OAuth scopes, and
   atomic modify operations differ from generic IMAP folders, flags, and RFC headers. A Gmail Skill
   can use native operations while a Himalaya Skill teaches direct CLI commands; mailbox-assistant
   owns the shared user intent and output discipline.
3. **Use OAuth for Gmail and treat password/app-password auth as a separate, lower-assurance IMAP
   mode.** Store secrets in Veduta's credential facility, not plaintext workflow or Automation
   configuration. Never copy the AgentMail example of embedding a key in general YAML.
4. **Do not claim Outlook through password IMAP/SMTP.** A credible Microsoft 365 adapter needs OAuth
   2.0 for IMAP/SMTP or a dedicated Microsoft Graph mail implementation. Provider names should be
   advertised only when the supported auth flow is verified.
5. **Make multiple accounts part of the domain model.** Himalaya's explicit account selector is the
   useful precedent. Avoid hidden “one token file means one account” coupling; every request and
   Automation should bind to a stable account ID.
6. **Keep setup claims truthful.** The Google Workspace docs/source mismatch shows why prose about
   narrow scopes or available dependencies is insufficient. Native Gmail OAuth scopes remain
   code-tested; direct CLI Skills must test their setup, command behavior, and advertised provider
   support without claiming a universal capability sandbox.
7. **Separate personal mailboxes from agent-owned addresses and chat gateways.** These have different
   trust boundaries, polling rules, sender authorization, and UX. Veduta's v1 Mailbox assistant is
   closest to Hermes's pull-based mailbox skills, not its always-on Email gateway or AgentMail.
8. **Keep triage policy above connector Skills.** The workflow `trigger → operation → output` stays
   user-facing and provider-independent, while connector Skills own native operations or direct CLI
   commands. The Automation records its exact account, query boundary, operation, and output target;
   first-party behavior tests prove connector defaults do not widen that instruction.

The direct-execution decision that revises the earlier adapter-only recommendation is recorded in
[ADR-0026](../adr/0026-skills-may-drive-general-tool-execution.md).
