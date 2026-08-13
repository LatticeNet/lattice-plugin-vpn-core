# vpn-core 0.8.0-alpha.9 signature handoff

This implementation lane produces deterministic, unsigned release inputs only.
It does not invoke `pluginsign`, create a tag, publish an artifact, or mutate a
running Lattice installation.

The authorized signer must verify:

1. `manifest.json` version is exactly `0.8.0-alpha.9` and
   `signature_ed25519` is empty before signing.
2. Go, UI package, and UI lockfile versions match the manifest.
3. Both Linux binaries and the complete `ui/dist` tree are packed with
   `tools/pluginpack` using the repository verification command.
4. Two packs made after changing source mtimes are byte-identical and their
   common SHA-256 equals `manifest.json.bundle.digest_sha256`.
5. The canonical manifest is signed only after that digest is fixed.

Compatibility inputs: server floor `0.2.2-alpha.19`, dashboard host bridge `1`,
node-agent `0.3.4-alpha.1`, and plugin `0.8.0-alpha.9`.

Verified complete-bundle SHA-256:
`959a8e5b4a5f4210b29d9489ae809ae81a180fc525d0e1ce69dc063b2e0a0870`.
