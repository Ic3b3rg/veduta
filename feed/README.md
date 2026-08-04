# The update feed

This directory holds `stable.json` — the gated update feed the daemon's `check-updates`
Automation polls (schema: `UpdateManifestSchema`, `packages/protocol/src/update.ts`; design:
[docs/adr/0013-signed-self-update.md](../docs/adr/0013-signed-self-update.md)). There is
**deliberately no `stable.json` committed yet**: it appears for the first time only once a
release has been signed, soaked, and promoted — see [RELEASING.md](../RELEASING.md) for the
full ceremony (`deploy/release.sh promote` writes it).

A placeholder JSON file was considered instead of this README and rejected: any placeholder
that does not conform to `UpdateManifestSchema` would fail to parse the moment something tried
to fetch it, which is a worse failure mode than the file simply not existing yet (an HTTP 404
on the feed URL). An absent `stable.json` is the documented, expected state before the first
release, and is what "no update currently offered" looks like on the wire.

Once a release is promoted, this directory looks like:

```
feed/
  README.md    (this file)
  stable.json  (the signed, gated feed)
```
