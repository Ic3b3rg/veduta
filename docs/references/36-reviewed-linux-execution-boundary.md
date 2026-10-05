# Reviewed executable execution on Linux: design and disposable probe

Research date: 2026-10-05. Repository inspected at
`5fc707e9adbdb626436a5fd7640f5ee6a7c20a88`.
Scope: the common Linux host boundary requested by
[issue #196](https://github.com/Ic3b3rg/veduta/issues/196), under the accepted
[ADR-0032](../adr/0032-reviewed-extension-hub.md) and
[ADR-0034](../adr/0034-veduta-owned-mcp-client.md). This is a proposed probe and an implementation
brief, not an accepted new ADR, a passing runtime report, or permission to activate a package.

## Result and sequencing

The first candidate to probe is a **systemd-managed process with a dedicated Unix identity,
a reviewed read-only root, and a private network containing only loopback**, connected to a
Gateway-owned fixed-origin relay through one explicitly mounted filesystem Unix socket.
GitHub MCP and the Veduta-native Brave process should use the same launch policy; their
protocols and fixed upstream destinations are separate reviewed inputs. This recommendation
is an inference from the controls and limitations below. Select the delivered implementation
only after the disposable probe passes on the actual intended host.

#196 remains open and blocked by [#180](https://github.com/Ic3b3rg/veduta/issues/180) and
[#186](https://github.com/Ic3b3rg/veduta/issues/186). #180's
[latest evidence](https://github.com/Ic3b3rg/veduta/issues/180#issuecomment-5994253359)
establishes real private-repository reads but explicitly leaves the separately approved write
and revocation/recovery proof outstanding. #186 still requires a reviewed Brave port and real
query proof. The closed [#177](https://github.com/Ic3b3rg/veduta/issues/177) and
[#179](https://github.com/Ic3b3rg/veduta/issues/179) settle the extension and MCP contracts;
they do not establish Linux runtime support. Research can precede those implementation gates.

## What the repository already provides

- [Artifact verification](../../packages/daemon/src/github-mcp-artifact.ts) pins GitHub MCP
  v1.12.2 for Linux x64 and Darwin arm64, checks the archive and complete regular-file inventory,
  and rechecks an installed executable. The Linux executable digest is
  `b7a96bf79c68c0d4d0cdb5713e9ff36a1730b87ee3ae710e2e6189f398d7c1aa`.
  The [official release](https://github.com/github/github-mcp-server/releases/tag/v1.12.2)
  supplies the versioned upstream artifact; the accepted inventory is recorded in ADR-0034.
- [The current launch function](../../packages/daemon/src/reviewed-github-mcp-launch.ts)
  rejects every non-Darwin platform before discovery. It accepts an executable, Gateway data
  root, and one relay port; it is not yet a reusable manifest/grant-based Linux launch contract.
- [The stdio client](../../packages/daemon/src/mcp-stdio-client.ts) uses fixed arguments,
  `shell: false`, and an explicitly constructed environment. With the reviewed launch path,
  its GitHub token variable contains a random relay credential, while the real PAT stays in the
  [fixed-origin relay](../../packages/daemon/src/github-mcp-egress.ts). Preserve this stronger
  credential separation on Linux. Killing the immediate Node child alone must not become the
  Linux guarantee for terminating all sandbox descendants.
- [The VPS service](../../deploy/veduta.service) protects the Gateway, but its `veduta` identity
  can write `/var/lib/veduta`, and its allowed network families do not implement package-specific
  egress. `RestrictNamespaces=yes` also makes launching a namespace builder inside that service
  a distinct integration question. A child inheriting the Gateway service is insufficient.
- [The Local VPS runner](../../deploy/local-vps.sh) supervises the Gateway in a shell and does
  not allocate an extension identity, namespace, or package egress policy. The
  [Local VPS contract](../adr/0009-local-vps-profile.md) permits explicit local substitutes;
  product flow parity does not imply the host can enforce executable isolation.

These are the general seams to extend. Do not add a GitHub-only Linux exception, activate a
foreign OpenClaw module, or use Model-provider-native tools. The single Agent, owning Space,
Untrusted output, and validated Surface/Event contracts remain those in
[CONTEXT.md](../../CONTEXT.md), [ARCHITECTURE.md](../../ARCHITECTURE.md), and
[SECURITY.md](../SECURITY.md).

## Primary-source comparison

| Candidate              | Relevant documented controls                                                     | Gap for this issue                                                                                                                                                                 | Recommendation                                                                               |
| ---------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| systemd system service | Dedicated `User=`, root/mount controls, `PrivateNetwork=`, and cgroup lifetime   | Settings can be unavailable or ineffective; root isolation needs all runtime files; privileged launch authority must be narrow                                                     | Probe first on one explicit Linux profile; inspect actual controls and run negative canaries |
| Bubblewrap             | Explicit mount tree, namespaces, seccomp, and loopback-only network namespace    | Caller defines the whole policy; unprivileged namespace availability and a distinct host identity remain requirements; does not supply the destination relay or resource lifecycle | Viable alternative behind a dedicated broker, not an automatic fallback                      |
| OCI container runtime  | Read-only filesystem, explicit user/mounts/capabilities, and a network-none mode | Default container networking permits egress; runtime administration is additional authority and dependency; image environment and bind sources need review                         | Possible separately proved Local VPS implementation of the same contract                     |
| Landlock alone         | Inherited restrictions on filesystem actions and, by ABI, network ports          | A port rule is not an approved-host rule; available ABI differs; it does not provide a distinct identity or the required lifecycle by itself                                       | Optional added defense, not the complete launch boundary                                     |

The systemd v255 execution source documents the root, identity and mount options, loopback-only
`PrivateNetwork=`, filesystem Unix sockets remaining reachable, and possible ineffective controls.
It also distinguishes manager/service environment sources. A declaration is therefore evidence
to inspect, not proof that the child is confined.
[systemd v255 execution source](https://github.com/systemd/systemd/blob/v255/man/systemd.exec.xml)

`IPAddressAllow=` and `IPAddressDeny=` take IP addresses/CIDRs, rather than DNS host names.
The documentation warns that the filters can have no effect when cgroup eBPF support is absent.
They cannot, alone, prove the approved-destination requirement on every host.
[systemd v255 resource-control source](https://github.com/systemd/systemd/blob/v255/man/systemd.resource-control.xml)

Bubblewrap's own documentation says protection depends on its invocation, describes the
loopback-only namespace, and warns about exposed IPC and terminal-session escape paths.
[Bubblewrap v0.11.0 README](https://github.com/containers/bubblewrap/blob/v0.11.0/README.md)

Docker documents explicit user/capability/mount choices and `--read-only`; its `none` network
driver creates only loopback. Access to Docker administration is security-sensitive. These
features support a candidate, but default bridge networking and broad runtime-socket access
are not an approved-destination boundary.
[Docker run documentation](https://docs.docker.com/engine/containers/run/),
[none network driver](https://docs.docker.com/engine/network/drivers/none/),
[Docker Engine security](https://docs.docker.com/engine/security/)

Landlock documents runtime ABI detection, inherited restrictions, and network rules on ports.
Its example drops unavailable rights for compatibility. Veduta's required controls must instead
fail closed when unavailable; silently omitting a mandatory right cannot establish #196.
[Linux Landlock documentation](https://docs.kernel.org/userspace-api/landlock.html)

## Candidate common launch contract

The following is a proposed design, not existing behavior.

1. The Gateway submits an exact reviewed artifact identity, fixed entrypoint and arguments,
   runtime/dependency inventory, manifest and schema hashes, effective mount/host/secret-slot
   set, resource limits, owning grant, and revocation generation. The launch broker resolves
   these against an installed review record. It does not accept arbitrary shell strings,
   systemd properties, executable paths, host sockets, or writable mount requests from the Agent.
2. A small host-owned broker creates the service and owns its complete cgroup. The Gateway
   retains its current hardening and receives only the reviewed process's stdio and bounded,
   redacted launch status. Give neither the Gateway nor the package a general `sudo`, systemd
   management, or rootful container socket capability. Authenticate the broker's Unix peer and
   validate all path components against roots it owns.
3. The reviewed executable, runtime, dependencies, and relay bridge are staged outside the
   Gateway data root in a host-owned, content-addressed tree. Reject links, unexpected files,
   and drift before staging and each launch. Publish a new tree for an update; do not modify a
   running version. The Gateway and package identities cannot alter the tree or its parents.
   A read-only child mount alone does not freeze a bind source that another permitted host
   writer can mutate. Host administration remains trusted.
4. Allocate an identity distinct from the Gateway, and separate identities/data for concurrent
   grants that must not inspect one another. Mount only the complete reviewed root, one scoped
   writable `/data`, bounded temporary storage, required minimal device/process views, and one
   per-launch relay socket. Do not expose the host `/`, home, Gateway data, runtime-management
   sockets, vault, or journal socket. Reuse of persistent package data must obey its ownership
   and retention policy; do not recycle an identity while its data or processes remain live.
5. Use a private network without a host interface or default route. A reviewed bridge inside it
   supplies the child's local HTTP endpoint and forwards to the one mounted filesystem Unix
   socket. The Gateway-side relay chooses a fixed TLS origin from its reviewed record, checks
   destination resolution, refuses redirects/tunnels/upgrades, bounds requests/results, and
   injects only that grant's provider credential. The bridge owns no provider credential.
6. Execute with an empty inherited environment, adding only reviewed non-secret values and the
   single opaque relay capability. For MCP preserve the exact `GITHUB_HOST` and scoped
   `GITHUB_PERSONAL_ACCESS_TOKEN` relay behavior. For Brave, #186 must review the analogous
   credential destination and both advertised modes. Do not put a PAT or Brave key in systemd
   `Environment=`/`SetCredential=` properties or invocation arguments.
7. Before discovery, a host-side verifier checks UID/groups, effective capabilities, namespace
   identities, mount sources/access, environment keys, cgroup membership/limits, and the active
   relay lease against the reviewed policy. Check evidence outside the untrusted child.
   Required-control failure returns Unsupported with a specific reason and starts no MCP
   discovery or native initialization. Revalidate on every launch, including Gateway restart.

Filesystem Unix sockets provide a narrow way to cross the network namespace while their path
remains under mount and Unix permission controls. Network namespaces isolate the IP stack,
routes and abstract Unix socket namespace; pathname sockets have separate filesystem semantics.
[Linux network namespaces manual](https://man7.org/linux/man-pages/man7/network_namespaces.7.html),
[Linux Unix sockets manual](https://man7.org/linux/man-pages/man7/unix.7.html)

GitHub MCP can keep its reviewed relay mappings to `https://api.github.com`, including the
existing GraphQL mapping. Brave documents Web Search at
`https://api.search.brave.com/res/v1/web/search` with its subscription-token header; the port's
complete mode/endpoint set must come from #186's exact reviewed source. Search result URLs are
output data and never automatically extend process egress or trigger result-page fetching.
[current GitHub relay](../../packages/daemon/src/github-mcp-egress.ts),
[Brave Web Search API](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started),
[OpenClaw Brave reference](https://docs.openclaw.ai/plugins/reference/brave),
[candidate scope](28-extension-candidate-evidence.md)

## Disposable technical probe specification

Status: **not run**. Prepare this probe before choosing the implementation. The fixture and
broker described here do not yet exist in the repository; the invocation below specifies their
required layout and systemd properties, not an available Veduta command.

Use a fresh, disposable Linux x86_64 VM with systemd as the system manager and unified cgroup
v2. Start with Ubuntu 24.04 and systemd 255 or later as the first candidate profile. Capture the
actual kernel, systemd, filesystem, LSM policy, cgroup controllers, CPU architecture, and tool
versions. This is a proposed target, not a claim that every Ubuntu 24.04 VPS is supported.
Do not relax the production Gateway service or enable host-wide unprivileged namespaces to
make a failed probe pass. Other distributions, Ubuntu 22.04, rootless/containerized systemd,
and arm64 require their own evidence; arm64 additionally lacks the reviewed GitHub artifact
in the current inventory. Deployment currently describes Ubuntu 22.04/24.04 independently of
extension support. [Deployment guide](../../deploy/README.md),
[artifact inventory](../../packages/daemon/src/github-mcp-artifact.ts),
[cgroup v2 documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html)

### Stage A: deterministic host-control canaries, no real credentials

Prepare these exact fixtures inside the VM, using synthetic content only:

- `/var/lib/veduta-linux-probe/root/`: host-owned root containing a statically linked reviewed
  `/probe/launcher` and `/probe/assertions`, plus empty `/data`, `/tmp`, `/run`, `/proc`, and
  `/dev` mount targets. Record SHA-256 for both binaries and source/compiler identity.
- `/var/lib/veduta-linux-probe/data/`: mode `0700`, owned only by a newly allocated
  `veduta-linux-probe` identity. It is the sole persistent writable mount.
- `/var/lib/veduta-linux-probe/gateway/canary` and
  `/home/veduta-linux-probe-unrelated/canary`: world-readable synthetic files outside the
  root. They must remain unreadable inside even though their ordinary file modes permit reads.
- `/run/veduta-linux-probe/relay.sock`: a per-run host pathname socket owned by the probe
  identity, mode `0600`. Its fake relay accepts only one fixed, bounded canary operation and
  rejects arbitrary URLs, CONNECT, credential-slot changes and revoked leases.
- A verified-live host loopback TCP listener on an ephemeral port, an unrelated pathname
  socket, and a host abstract Unix socket. None is granted to the child. Capture the actual
  listener port as a non-secret fixture argument; do not use a guessed unused port.

`/probe/launcher` closes every inherited descriptor except its explicit stdio and relay
capability, constructs an empty environment, and invokes `/probe/assertions` directly.
Deliberately place a non-secret `VEDUTA_PROBE_SENTINEL` in the outer service environment;
assert its absence and exact allowed environment-key set in the actual child. The fixture
performs the following finite tests, emits booleans/error classes without canary contents,
and exits nonzero on any failed assertion:

| Assertion                                                                                                                            | Expected result                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Probe UID/group versus Gateway identity; effective/ambient capabilities and `no_new_privs`                                           | Distinct unprivileged identity, no capabilities, no new privileges |
| Read each external canary, `/proc/<Gateway PID>/root`, `environ`, and `fd`                                                           | Denied; no disclosure                                              |
| Modify reviewed entrypoint or runtime bytes; create `/outside-grant`                                                                 | Denied; host hashes unchanged                                      |
| Write and read `/data/result`; write bounded `/tmp/result`                                                                           | Works; only `/data/result` persists across a new process           |
| Connect to the granted relay through an internal loopback bridge                                                                     | Works only for its fixed operation and active lease                |
| Direct TCP to the live host loopback listener, a live unapproved external IPv4/IPv6 destination, and host metadata/private addresses | Denied; approved fake relay remains usable                         |
| Direct UDP DNS, raw socket creation, host abstract/unrelated pathname sockets, namespace/mount/identity changes                      | Denied or unavailable under the required policy                    |
| Relay URL/Host/path/header confusion, redirect, CONNECT, upgrade, oversized body, or revoked lease                                   | Refused without another upstream request                           |
| Fork a descendant that ignores cancellation, then stop the unit                                                                      | Entire cgroup dies; writable data outside the grant is unchanged   |

Use host-side listener counts and verified-live destinations to distinguish a blocked request
from an unavailable server. Inspect IPv4 and IPv6 routes/interfaces as well. Absence of a packet
or an expected connection error without a positive outer-host control is insufficient evidence.
The fixture must include a successful allowed operation so a universally broken network path
cannot pass the negative tests.

This is the concrete candidate service invocation after preparing and reviewing the fixture.
Only run it on that disposable VM, with the stated identity and mount sources already created:

```sh
sudo systemd-run --unit=veduta-linux-probe --pipe --wait --collect \
  --property=Type=exec \
  --property=User=veduta-linux-probe \
  --property=Group=veduta-linux-probe \
  --property=RootDirectory=/var/lib/veduta-linux-probe/root \
  --property=WorkingDirectory=/data \
  --property=ProtectSystem=strict \
  --property=ProtectHome=yes \
  --property=PrivateNetwork=yes \
  --property=PrivateIPC=yes \
  --property=PrivateDevices=yes \
  --property=ProtectProc=invisible \
  --property=NoNewPrivileges=yes \
  --property=CapabilityBoundingSet= \
  --property=AmbientCapabilities= \
  --property=RestrictAddressFamilies='AF_UNIX AF_INET AF_INET6' \
  --property=RestrictNamespaces=yes \
  --property=ProtectKernelTunables=yes \
  --property=ProtectKernelModules=yes \
  --property=ProtectControlGroups=yes \
  --property=BindPaths=/var/lib/veduta-linux-probe/data:/data \
  --property=BindReadOnlyPaths=/run/veduta-linux-probe/relay.sock:/run/relay.sock \
  --property=TemporaryFileSystem=/tmp:rw,nosuid,nodev,noexec,size=16M \
  --property=MemoryMax=256M \
  --property=TasksMax=32 \
  --property=LimitCORE=0 \
  --property=KillMode=control-group \
  --property=TimeoutStopSec=2s \
  --property=RuntimeMaxSec=30s \
  --property=Restart=no \
  --setenv=VEDUTA_PROBE_SENTINEL=non-secret-canary \
  /probe/launcher
```

Treat unsupported properties, warnings, effective-policy differences, missing namespace
separation, or failed assertions as a failed candidate. While the bounded fixture is alive,
record the service's `MainPID` and `ControlGroup`, inspect host-side `/proc/<pid>/status`,
`mountinfo`, descriptor list and namespace identities, and inspect its actual cgroup limits.
Compare network/mount namespaces with the Gateway's; do not trust fixture self-report alone.
`systemd-run --pipe` supplies a stdio transport suitable for the probe; it is not authority to
expose unrestricted transient-unit creation in the product.
[systemd v255 run source](https://github.com/systemd/systemd/blob/v255/man/systemd-run.xml)

Repeat after removing the relay, substituting a writable code source, changing a reviewed
digest, omitting a required host control, adding an extra mount/host/slot, and changing the
revocation generation. The future verifier must refuse every altered policy **before** running
MCP discovery or `extension/initialize`. The specimen above alone does not implement that verifier.

### Stage B: exact reviewed processes and real user-visible outcomes

After #180 and #186 are complete and Stage A passes, replace only the reviewed package/protocol
inputs, retaining the same broker and effective host policy:

1. Stage the Linux x64 GitHub archive and complete inventory through the existing verifier,
   including its known executable digest. Review the complete runtime root and bridge too.
   Use an authenticated PWA setup with a fine-grained PAT restricted to a disposable repository.
   Request a bounded `list_issues` task in one Space, and verify its source-linked validated
   Surface and matching Event. Repeat after PWA reload and Gateway restart.
2. Grant the separate reviewed `issue_write` create profile. Prepare one exact issue, approve
   its L1 Pending decision, and verify response plus read-back, one durable effect record, one
   Surface commit, and no duplicate issue on reconnect. Simulate timeout/crash after dispatch:
   an uncertain write must require inspection and must never be replayed automatically.
3. Stage #186's exact Veduta-native Brave artifact and manifest. Bind its reviewed key slot
   through protected setup; run a bounded query with source-linked Surface output. Exercise
   every advertised search mode accepted by #186, both Model connection methods, restart,
   missing key, denied approval, failed load, disable, revoke, and recovery. Neither OpenClaw
   native registration nor provider-native Web facilities may supply the result.
4. Repeat the negative file/network/secret probes under each actual process policy. Attempt
   another grant's data/relay, inspect secret leakage in Chat/model context/Surface/Event/Trace,
   and prove the process receives only its opaque reviewed slot. Test IPv6 and proxy bypasses
   under the actual native runtime, not just the static fixture.
5. Run focused boundary/contract tests, clean-data browser journeys, relevant browser E2E,
   and `pnpm check`. Remove disposable remote entries, revoke the temporary credentials, stop
   every probe unit/relay, verify empty cgroups and closed sockets, remove only the probe's
   persistent state, and record actual remote/issue/worktree status before claiming completion.

These outcomes come from [#196's acceptance criteria](https://github.com/Ic3b3rg/veduta/issues/196),
[ADR-0034](../adr/0034-veduta-owned-mcp-client.md), and
[#186](https://github.com/Ic3b3rg/veduta/issues/186). The probe's synthetic canaries cannot replace
the real read, separately approved write, native query, or persistence journeys.

## Cancellation, revocation and restart

Proposed lifecycle: close/invalidate the relay lease first, reject new calls and hooks, propagate
protocol cancellation, then stop the complete cgroup after a bounded grace period. A broker
lease binds the live Gateway owner and grant generation; Gateway disconnect/crash expires the
lease and stops the unit. A fresh Gateway must revalidate the persisted enabled grant, exact
bytes and effective permissions before launching a new process. Use `Restart=no` for the
extension unit so service supervision cannot revive stale authorization independently.

`KillMode=control-group` terminates remaining unit processes and escalates after the stop
timeout; killing only the main process leaves descendants outside that lifetime guarantee.
[systemd v255 kill source](https://github.com/systemd/systemd/blob/v255/man/systemd.kill.xml)

Child termination cannot undo an upstream action already dispatched. The existing
[GitHub effect record](../../packages/daemon/src/github-mcp-effects.ts) and accepted
[MCP decision](../adr/0034-veduta-owned-mcp-client.md) continue to distinguish confirmed,
failed and uncertain writes; process recovery does not authorize automatic replay.

## Evidence available now and remaining access

Only read-only availability checks were performed in this research:

- `uname -s -m` returned `Darwin arm64`.
- `command -v docker podman nerdctl colima limactl multipass systemctl bwrap firejail
qemu-system-x86_64 qemu-system-aarch64` found none in the active PATH.
- The first conditional Docker-info check did not invoke Docker because its executable was not
  resolved through PATH. A follow-up at
  `/Applications/Docker.app/Contents/Resources/bin/docker` found the existing Docker Desktop CLI.
- Read-only `docker info` through that explicit path succeeded: Engine `29.7.2`, OS `linux`,
  architecture `aarch64`, kernel `7.0.12-linuxkit`, cgroup version `2`, with builtin seccomp and
  cgroup-namespace security options. This establishes an available Linux container engine;
  it does not establish the proposed x64/systemd profile, x64 emulation, or a passing boundary.

No VM/container was started, no runtime/dependency was installed, no host policy was changed,
no credentials were inspected, and no Linux or real-service probe was executed. The existing
Docker Desktop engine could host a separately approved disposable investigation, but its
presence alone does not verify any requested launch control or package compatibility.

The next run needs an explicitly provided disposable Linux x64 host with administration access
to create the narrow service/identity/mount controls, plus a reviewed probe fixture and bridge.
The later real-service run also needs the completed #180/#186 artifacts, an authorized disposable
GitHub repository/PAT, and a Brave key with bounded query access. Until the probe and runtime
journeys establish a supported profile, Linux executable activation remains Unsupported.
