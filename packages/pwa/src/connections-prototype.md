# Connections panel UI prototype

Related work: [issue #181](https://github.com/Ic3b3rg/veduta/issues/181),
[ADR-0033](../../../docs/adr/0033-chat-initiated-service-connections.md), and
[ADR-0032](../../../docs/adr/0032-reviewed-extension-hub.md).

## Question

Does a dedicated page with a sidebar make adding and managing accounts, Model connections,
extensions, and explicit Space access understandable? The sidebar ends with **Back to Veduta**.
The user requested the management-page organization of the
[Hermes dashboard](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard)
and Veduta's existing UI components.

## Run

From this prototype branch, run `pnpm prototype:connections`, then open
<http://localhost:5174/app/prototype/connections?variant=A>.
The default return link leads to the existing local PWA at <http://localhost:8788/>.

## Compare

- **A — Service catalog:** scannable connection cards with account, status, and Space access.
- **B — Control panel:** a compact table for inspecting several connections at once.
- **C — Guided overview:** a selector and one expanded connection with setup guidance.

All three retain the same sidebar. The floating bar or left/right arrow keys switch variants;
`variant` and `section` are URL parameters retained on reload. Arrow keys keep their ordinary
behavior inside fields and setup dialogs.

Try connecting GitHub, deny authorization once, retry with demo authorization, grant Work only,
and inspect Space access. Manage the Gmail example to reconnect, disable, or remove it. Models
and included GitHub MCP support have separate descriptions and controls.

## Boundary

This is throwaway UI evidence, with Veduta's actual Button, Input, Badge, Card, Checkbox,
Separator, and Table components plus shared catalog typography/color tokens. All changes live
in React memory and reset on reload. No Gateway, provider, or credential operation is performed;
OAuth, account verification, and extension setup are explicitly simulated. An extension preview
cannot become a verified installation. The route and variant switcher are development-only.

The connection origin from this page and proposed simplified OAuth need a reviewed production
design before implementation. This prototype does not satisfy the outstanding real-service gates
for #180/#181 or provide a general Hub installer.

## Verdict

Pending the user's review of the three variants. Preserve this prototype on its own branch;
production implementation should retain only the selected design after the required review.
