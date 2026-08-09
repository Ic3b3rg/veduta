# VPS deployment and browser access are separate decisions

The VPS profile defines production execution guarantees: a dedicated hardened systemd service, persistent data, self-updates, passkey authentication, and the production Gateway behavior. It does not define how a browser reaches that Gateway. Treating public exposure as part of the profile made a domain and ACME mandatory even when the user wanted a private deployment, and tempted implementations to reuse the development-only Local VPS profile for real hosts.

A VPS installation has one active browser access mode:

- **Public access** binds the Gateway to public interfaces and uses a stable public domain with ACME-managed HTTPS.
- **Tunnel access** keeps the Gateway on loopback and reaches it through an SSH local forward at a stable `http://localhost:<port>` origin.
- **Tailnet access** keeps the Gateway on loopback and uses Tailscale Serve for a stable HTTPS origin reachable only by authorized tailnet devices. It never enables Tailscale Funnel implicitly.

Tailnet access accepts one bounded disclosure: the `*.ts.net` certificate hostname may appear in public Certificate Transparency logs. That does not make the Gateway reachable outside the tailnet; the installer must disclose the distinction before enabling HTTPS.

Loss of Tailscale connectivity fails closed. Veduta stays bound to loopback and never opens a public listener or switches access mode automatically; the operator repairs or reconfigures access through SSH.

Passkey authentication remains mandatory in every mode. Network reachability is a transport boundary, not an application identity. Tunnel access therefore does not inherit the unauthenticated behavior of development loopback servers.

Only one PWA origin is active at a time. A guided access change stages and verifies the replacement before committing it, preserves all application data and Model connections, and rolls back on failure. Because WebAuthn credentials are bound to their RP ID and origin, a change from `localhost` to a public or `*.ts.net` origin requires registering a new passkey. SSH administration remains the recovery path.

The canonical installer runs on the destination server. Its guided flow selects safe defaults where possible: Tunnel access when Tailscale is absent, Tailnet access when the host is already connected to a tailnet, and never Public access implicitly. Tunnel setup hands the user one exact local-forward command rather than requiring manual configuration. The Local VPS profile remains a production-like development runner and is never the deployment mechanism for this path.

Status: accepted
