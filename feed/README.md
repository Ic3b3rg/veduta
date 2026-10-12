# The update feed

`stable.json` is the public update feed containing signed release metadata, polled by
Veduta's daily "Check for updates" Automation. A release appears here only after its artifact
has been verified and smoke-tested and its metadata signed. See [RELEASING.md](../RELEASING.md) for the maintainer ceremony and
[ADR-0013](../docs/adr/0013-signed-self-update.md) for the trust model.

The feed intentionally contains public verification material:

- `release`: the exact signed release metadata, encoded as base64. It contains the version,
  release notes, artifact URL, hashes and size limits. Base64 preserves the signed bytes; it
  is not encryption.
- `releaseSig`: the release's digital signature.
- `signingKey`: the signing **public** key, its ID and the root key's certification signature.
- `artifactUrl`: the downloadable artifact, checked against the signed metadata.

Minisign's comment `signature from minisign secret key` describes how a signature was made.
The signature does **not** contain the secret key and cannot sign another release. No private
keys, passphrases, access tokens or installation credentials belong in this directory.

An installed instance verifies the root → signing key → release chain against the root public
key pinned during installation. Publishing this feed offers an update; installation still
requires the owner's explicit Apply action.
