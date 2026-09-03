# vpn-core signature handoff

> Written for 0.8.0-alpha.10 and left version-pinned, which made it wrong the
> moment the plugin moved on. As of 2026-08-19 the manifest is `0.8.0-alpha.14`
> and it is already signed. Read step 1 as "whatever version the manifest
> declares now", not as the literal string below.

This implementation lane produces deterministic, unsigned release inputs only.
It does not invoke `pluginsign`, create a tag, publish an artifact, or mutate a
running Lattice installation.

The authorized signer must verify:

1. `manifest.json` declares the version being released, and that version
   matches the tag, the GitHub release, and the plugin-index entry. Do not pin
   this checklist to one version again.
   `signature_ed25519` is empty before signing. For a v2 manifest this is a
   hygiene check, not a technical requirement: `SigningPayload` sets
   `SignatureEd25519` to the empty string itself before marshalling, so
   re-signing an already signed manifest still produces a verifying signature.
   Keep the check anyway, because an unexpectedly populated field means you are
   about to sign something you did not just build.
2. Go, UI package, and UI lockfile versions match the manifest.
3. Both Linux binaries and the complete `ui/dist` tree are packed with
   `tools/pluginpack` using the repository verification command.
4. Two packs made after changing source mtimes are byte-identical and their
   common SHA-256 equals `manifest.json.bundle.digest_sha256`.
5. The canonical manifest is signed only after that digest is fixed.

Compatibility inputs: read them from `manifest.json` rather than from this
line. At the time of writing they were server floor `0.2.2-alpha.19`, dashboard
host bridge `1`, node-agent `0.3.4-alpha.1`. The plugin version is whatever the
manifest declares.

Verified complete-bundle SHA-256:
`e9dfd94060ce9f18587aa2cf2f9e9ab77925fd734f13fceb7f1a97660430098a`.

That digest is CI's canonical one for the version `manifest.json` declares,
adopted from the run log after the branch built, and `manifest.json` carries the
same string. Adopt a fresh digest here and there together whenever the bundle
changes: a digest that describes an older build is how the wrong bytes get
signed. A test in `system-go` holds the two to the same string in both
directions, so the checklist can never quote a bundle the manifest does not.
