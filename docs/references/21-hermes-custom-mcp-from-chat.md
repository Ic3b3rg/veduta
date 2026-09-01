# Research 21 — Custom MCP configuration from Hermes chat

> Conducted on 2026-08-28 against the then-current official
> [NousResearch/hermes-agent commit `baa344d`](https://github.com/NousResearch/hermes-agent/commit/baa344dee76993f0444c18fc59a69738ccb339d0).
> All source links are immutable. **Observed absence** means no such route was found in that
> revision; **inference** is called out separately.

## Verdict

Hermes does **not** currently have one dedicated ordinary-chat contract that means: “take this
arbitrary MCP configuration, including its URL or local command and credentials, persist it, connect
it, and use its native tools now.” The Desktop chat tool accepts only a server name, one of three
actions, and a reason. Its renderer can install a reviewed catalog server or a known official
URL-only server; an unknown name returns an error. It cannot carry a pasted config object, URL,
command, headers, environment map, or credential.
([chat tool schema](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/tools/setup_mcp_tool.py#L74-L120),
[actual Desktop install branches](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/apps/desktop/src/components/assistant-ui/mcp-setup-tool.tsx#L290-L373))

The user's expectation is nevertheless understandable because Hermes has adjacent routes that can
reach parts of the outcome:

- Desktop's **Capabilities → MCP** tab has a tested paste-anything importer for complete JSON,
  URLs, stdio command lines, Claude commands, and Cursor links, followed by explicit Save and live
  reload. This is a settings workflow, not the ordinary-chat card.
- `hermes mcp add` supports custom remote and stdio servers through CLI flags and interactive
  discovery. An Agent with a local terminal can potentially drive that CLI through a background
  PTY. That is general terminal authority, not a dedicated chat import contract.
- The optional `mcporter` Skill can call arbitrary HTTP or stdio MCPs ad hoc through the terminal.
  It uses a separate client/config and does not register those tools natively in the current Hermes
  Agent.

Therefore Hermes is evidence for a natural-language front door plus explicit installation UI, but
not evidence that Veduta must silently accept and activate an arbitrary pasted MCP blob from chat.

## Scenario matrix

| Scenario                                            | Dedicated ordinary-chat behavior                                                                                           | Persistence                                                                                                             | Availability after the action                                                                                          |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Reviewed catalog MCP, named in Desktop chat         | **Yes.** `setup_mcp` opens an approve/decline card and installs by catalog name.                                           | Server config is saved; declared credentials are written through the catalog credential path.                           | The card awaits `reload.mcp` before resuming the Agent. If reload fails, config remains and tools arrive next session. |
| Known official URL-only MCP, named in Desktop chat  | **Yes.** The renderer resolves its fixed directory URL, adds it, and runs OAuth/probe.                                     | Saved in `mcp_servers`; cancellation/failure after the write attempts rollback.                                         | Same awaited reload behavior as above.                                                                                 |
| Arbitrary remote HTTP config pasted in Desktop chat | **No first-class route.** The card has no config/URL/header arguments; an unknown name errors.                             | Possible in Capabilities or via `hermes mcp add`; not performed by `setup_mcp`.                                         | Capabilities requests a live reload; CLI explicitly says to start a new session.                                       |
| Arbitrary local stdio config pasted in Desktop chat | **No first-class route.** The card cannot carry `command`, `args`, or `env`.                                               | Possible in Capabilities or via CLI. General terminal editing is physically possible but is not the supported contract. | No source-backed guarantee that a terminal-driven install exposes native tools in the same turn.                       |
| TUI or messaging chat                               | `setup_mcp` is not in those surfaces' toolsets. Its no-callback fallback points to CLI commands.                           | Depends on the available terminal/CLI route.                                                                            | Requires reload or a later session; surface and policy constraints apply.                                              |
| Desktop Capabilities MCP importer                   | **Yes, outside chat.** Parses complete JSON, URL, stdio/Claude command, or Cursor link into an editable draft.             | Only after the user explicitly saves the draft; the whole validated map is written to `config.yaml`.                    | Save requests `reload.mcp`, but does not await that request before returning.                                          |
| `hermes://mcp/install` deep link                    | **Yes, outside chat.** Accepts one remote or stdio config after validation and explicit confirmation.                      | Merges and saves after showing the full JSON; never silently overwrites a name.                                         | The dialog itself saves and navigates to the MCP tab; it does not call `reload.mcp`.                                   |
| Optional `mcporter` Skill                           | Can invoke an arbitrary HTTP/stdio MCP immediately through terminal calls if the Skill and its prerequisite are installed. | Ad hoc calls need no config; optional persistence uses `./config/mcporter.json`, not Hermes `mcp_servers`.              | Usable as CLI output in the same Agent turn, but not as newly registered native Hermes tools.                          |

## What Desktop ordinary chat actually does

`setup_mcp` is limited to `install`, `enable`, and `authorize`; it blocks on the renderer and
distinguishes explicit decline, no response, and errors. Outside Desktop, the implementation returns
a CLI-oriented error. Unit tests pin all of those outcomes.
([dispatcher and failure outcomes](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/tools/setup_mcp_tool.py#L25-L71),
[contract tests](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/tests/tools/test_setup_mcp_tool.py#L17-L75))

The tool is registered only in `desktop_ui`, and surface tests prove Desktop receives that toolset
while TUI does not. The model prompt also tells the Agent to use this card for MCP setup and never
hand-edit `mcp_servers`.
([toolset registration](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/toolsets.py#L243-L261),
[surface tests](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/tests/tui_gateway/test_gui_surface_toolsets.py#L46-L79),
[Agent instruction](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/agent/prompt_builder.py#L890-L893))

The renderer checks the reviewed catalog first and then a static compatibility directory of known
official hosted endpoints. An unknown name responds with `error`. For a known directory server it
writes the fixed URL, runs OAuth/probe, and removes the entry on cancellation/failure when possible.
For a catalog server it reveals required credential fields and waits for background installation to
succeed.
([renderer branches and rollback](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/apps/desktop/src/components/assistant-ui/mcp-setup-tool.tsx#L290-L386),
[directory scope](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/apps/desktop/src/lib/mcp-directory.ts#L1-L20))

On success, the card awaits `reload.mcp` before answering the blocked tool call, so the resumed Agent
normally receives the refreshed native tool snapshot in the same session. Reload failure is not
rolled back: the UI reports it, leaves configuration persisted, and documents that tools will be
available next session.
([reload-before-resume behavior](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/apps/desktop/src/components/assistant-ui/mcp-setup-tool.tsx#L194-L239))

## The real arbitrary-config path is Capabilities, not chat

The Desktop importer explicitly describes itself as “paste-anything.” It recognizes wrapped or bare
MCP JSON, a single server object, supported stdio commands, `claude mcp add`, HTTP(S) URLs, and Cursor
deep links. Tests cover mixed local/remote JSON, stdio environment values, and raw HTTP authorization
headers.
([parser](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/apps/desktop/src/lib/mcp-import.ts#L326-L432),
[parser tests](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/apps/desktop/src/lib/mcp-import.test.ts#L5-L199))

The importer is wired only into the MCP settings tab in the inspected Desktop source. Import merges
entries into an **unsaved** editable draft; Save validates and replaces the whole server map, then
requests a live reload. The backend validates every entry before writing, so one suspicious entry
rejects the whole save.
([draft then Save](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/apps/desktop/src/app/skills/mcp-tab.tsx#L911-L999),
[persistence and reload](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/apps/desktop/src/app/skills/mcp-tab.tsx#L718-L749),
[whole-map validation](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/hermes_cli/mcp_config.py#L120-L150))

The separate Hermes deep link is also not a chat shortcut. It treats the payload as hostile, caps it
at 32 KiB, requires exactly one HTTP(S) URL or local command, and delegates installation to a dialog.
That dialog shows the full JSON, adds a special warning for stdio execution, requires confirmation,
and blocks name collisions. Its save handler does not issue a reload itself.
([deep-link validation](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/apps/desktop/src/lib/mcp-deeplink.ts#L1-L16),
[shape checks](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/apps/desktop/src/lib/mcp-deeplink.ts#L76-L146),
[confirmation and save](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/apps/desktop/src/app/contrib/mcp-install-deeplink-dialog.tsx#L25-L34),
[dialog implementation](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/apps/desktop/src/app/contrib/mcp-install-deeplink-dialog.tsx#L94-L180))

## What the Agent can bridge through terminal

`hermes mcp add` is an official custom-server path, but it is not a raw-config importer. Its flags
cover a URL or stdio command, args, stdio environment, auth mode, preset, and connection timeout.
The command then prompts about overwrite, authentication, connection failure, and which discovered
tools to enable. A successful save explicitly tells the operator: “Start a new session to use these
tools.”
([CLI surface](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/hermes_cli/subcommands/mcp.py#L41-L73),
[validation and auth](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/hermes_cli/mcp_config.py#L438-L559),
[probe, selection, and save](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/hermes_cli/mcp_config.py#L560-L640))

An Agent can potentially run that command because its general terminal supports interactive CLIs,
but only as `background=true` plus `pty=true` on the local backend; prompts are driven through the
`process` tool, where `submit` appends Enter. Normal foreground terminal calls are non-interactive.
([terminal PTY contract](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/tools/terminal_tool.py#L1133-L1142),
[`process` prompt contract](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/tools/process_registry.py#L3244-L3289),
[non-interactive default](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/website/docs/user-guide/features/tools.md#L87-L109))

Without a TTY, EOF has material fallback behavior: a successful probe cancels at the tool-selection
prompt without saving; a failed connection defaults to not saving; a connected server with no tools
defaults to saving. With a PTY, the Agent—not the human directly—can submit answers. This makes the
bridge possible but model-dependent and unsuitable as proof of a deterministic chat contract.
([input/EOF default](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/hermes_cli/mcp_config.py#L59-L73),
[failure and no-tool fallbacks](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/hermes_cli/mcp_config.py#L565-L605))

**Observed absence:** no terminal-driven `hermes mcp add` path calls the Desktop `reload.mcp` RPC.
The classic CLI watches config only while its Agent is idle and refreshes tools for the next turn;
the dedicated add command itself asks for a new session. Therefore there is no source-backed promise
that an Agent can install a native MCP through terminal and call its newly registered tool later in
the same turn.
([idle-only watcher](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/cli.py#L20399-L20430),
[reload targets the next turn](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/cli.py#L14220-L14319))

The optional `mcporter` Skill explains how Hermes can appear more flexible: it documents ad hoc HTTP
and stdio discovery and calls, optional separate config import, and PTY-based OAuth. It is explicitly
optional and operates through terminal output rather than Hermes's native MCP registry.
([optional status](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/website/docs/user-guide/skills/optional/mcp/mcp-mcporter.md#L13-L23),
[ad hoc calls and separate config](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/website/docs/user-guide/skills/optional/mcp/mcp-mcporter.md#L59-L107),
[PTY requirement](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/website/docs/user-guide/skills/optional/mcp/mcp-mcporter.md#L134-L138))

## Credentials, approvals, warnings, and failures

- The Desktop setup card starts with an empty credential draft and uses password inputs. It does
  not read a credential out of the user's chat message. The catalog API accepts only environment
  names declared by that catalog entry and writes supplied values through the `.env` path.
  ([password fields](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/apps/desktop/src/components/assistant-ui/mcp-setup-tool.tsx#L473-L488),
  [closed credential schema](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/hermes_cli/web_routers/mcp.py#L490-L539))
- `hermes mcp add` uses a masked prompt for a remote bearer token, stores that value in `.env`, and
  persists an interpolated header. By contrast, custom stdio `--env` values are persisted directly
  in the server config. Tests pin both behaviors.
  ([CLI auth storage](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/hermes_cli/mcp_config.py#L537-L559),
  [persistence tests](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/tests/hermes_cli/test_mcp_config.py#L210-L245),
  [bearer separation test](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/tests/hermes_cli/test_mcp_config.py#L625-L641))
- The generic Capabilities importer preserves pasted `env` and HTTP `headers` values verbatim in
  its draft, and the whole-map save persists that map. A pasted secret is therefore not
  automatically migrated to the dedicated `.env` path. The expected instruction should prompt the
  user to replace placeholders or re-enter secrets through a credential UI.
  ([verbatim import behavior](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/apps/desktop/src/lib/mcp-import.ts#L185-L280),
  [header/env tests](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/apps/desktop/src/lib/mcp-import.test.ts#L101-L147))
- The chat card always requires an explicit approve/decline action. The terminal bridge instead
  inherits ordinary dangerous-command approval policy; not every command necessarily prompts.
  Custom local MCP commands are intentionally arbitrary and unsandboxed, with only narrow
  high-signal abuse checks at save and spawn time.
  ([card controls](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/apps/desktop/src/components/assistant-ui/mcp-setup-tool.tsx#L457-L520),
  [terminal approval modes](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/website/docs/user-guide/security.md#L24-L60),
  [local MCP security boundary](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/hermes_cli/mcp_security.py#L1-L24))
- Runtime MCP-call approval is not automatic for every custom server. A missing `trust` field
  defaults to `full`; only `trust: untrusted` routes write-capable calls through one-call approval,
  while exact server-supplied `readOnlyHint: true` bypasses that gate.
  ([trust defaults and call gate](https://github.com/NousResearch/hermes-agent/blob/baa344dee76993f0444c18fc59a69738ccb339d0/tools/mcp_tool.py#L4575-L4716))

## Implications for Veduta parity

Veduta does not need to copy a Hermes capability that does not exist as one coherent contract. The
useful parity target is the outcome, with a clearer boundary:

1. Let ordinary chat recognize a complete MCP setup proposal, but parse it into typed remote or
   local fields rather than executing chat text.
2. Show source, endpoint or exact local command, requested tools/effects, destination Space, and
   warnings in an Approval card. Treat arbitrary local stdio as a materially higher-risk
   installation than a reviewed remote MCP server.
3. Remove credentials from the proposal, request them again through a dedicated secret input, and
   persist only secret references in the MCP configuration.
4. When the Pending decision is accepted, validate, save atomically, probe, select a positive tool
   allowlist, reload, and report whether the MCP server is usable now or only on a later turn. Roll
   back a failed partial install.
5. Keep “possible because the Agent has a shell” out of the feature contract. A supported chat
   operation must not depend on the model correctly driving nested interactive prompts or editing
   control files with ambient OS authority.

That gives the user the natural sentence they expect—“save this MCP and use it”—while making
the actual mutation, secret handoff, authority, persistence, reload, and failure state explicit.
