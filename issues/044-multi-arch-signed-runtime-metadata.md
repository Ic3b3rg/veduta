# 044 — Sign Node runtime metadata for every supported Linux architecture

## Verified bug

Signed release metadata contains one Node runtime size and hash, produced from the linux-x64
archive. The updater selects the runtime archive from the host architecture. A linux-arm64 host
therefore downloads different bytes and correctly refuses them against the x64-only signed
metadata whenever a release changes the Node version, despite the installer claiming arm64
support.

## Desired behavior

A signed release must authenticate the exact Node runtime bytes for every supported Linux
architecture. Runtime selection remains host-local, tampered downloads remain refused, and release
generation requires no manual per-architecture measurement.

## Acceptance criteria

- [ ] The signed metadata identifies size, unpacked size, and digest for linux-x64 and linux-arm64
      runtime archives without an ambiguous fallback.
- [ ] A release that pins a new Node version installs successfully on both supported architectures.
- [ ] A tampered or architecture-mismatched runtime is refused before activation.
- [ ] Release automation derives and signs both runtime entries without manual measurement.
- [ ] Compatibility behavior for already-signed metadata is explicit and tested.
- [ ] Release documentation describes the multi-architecture signing contract.
- [ ] `pnpm check` passes.

## Out of scope

- Adding non-Linux runtime targets.
- Weakening signed-byte verification in favor of same-channel checksums.
- Operator-assisted runtime installation as the normal arm64 path.

## Blocked by

None — can start immediately.
