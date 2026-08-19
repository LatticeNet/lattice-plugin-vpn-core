# lattice-plugin-vpn-core

Official LatticeNet sing-box management plugin. It is where an operator sees the
proxy lines running across the fleet, the identities allowed on them, how those
lines chain into each other, and how much traffic each one carried. This
repository owns the complete plugin bundle: signed manifest, Linux runtime,
sandboxed operator UI, deterministic packer, tests, and release workflow inputs.
The released version is the one in `manifest.json`.

## Ownership boundary

The plugin owns four Extensions pages and their interaction logic:

- Lines: every inbound the fleet reports, managed or merely observed, plus the
  chain topology between them.
- Users: identities, their protocol credentials, and which lines they are bound
  to.
- Node Profiles: what core each node runs, what it discovered, and the sing-box
  integration settings Lattice writes for it.
- Usage: per node, per identity, and per line, as far as a collector reports.

The Dashboard does not compile these pages. It discovers signed navigation
contributions, serves the verified bundle assets, supplies theme tokens, and
brokers exactly the manifest-declared RPC methods through the nonce-bound iframe
bridge. Deactivating the plugin removes all four entries and leaves no
VPN-specific component behind in the base Dashboard.

The durable rendering, agent task, encrypted store, and approval engines stay in
`lattice-server`, exposed as services owned by `latticenet.vpn-core`. Plugin and
service ownership is checked before a Bundle v2 call may use an in-core service.

Nothing on these pages writes to a node directly. Every host mutation goes
through plan, approval, a bounded agent task, and audit.

## Security model

- The iframe runs with `sandbox="allow-scripts"` and gets no same-origin or
  top-navigation capability.
- Every call is constrained to a service and method declared in `manifest.json`.
- Lines, Users, chains and usage reads require `vpncore:read`. Identity
  mutations, rollout, reattach and chain planning require `vpncore:admin`.
- Reading one node's profile settings requires `node:read` for that node, and
  saving them requires `node:admin` plus `task:run` for that node.
- Credential secrets are write-only with one deliberate exception: rotating a
  credential returns the new secret once, in the response to the rotate call, so
  the operator can copy it. It is shown once and never retrievable afterwards.
  Every other read model exposes `has_secret` and never a UUID or a password.
- Line-chain reads expose desired and reconciliation state through
  `latticenet.vpn-core/lines.chains`; planning uses `plan_chain` and
  `plan_remove_chain`. Those external names differ on purpose from the internal
  `network/lines.chain_*_apply` approval bindings.
- Saving plugin-owned launch settings preserves every generic agent setting,
  records an audit event, and returns a reconfiguration command for review. It
  neither queues nor executes a host task, so the node keeps running its old
  settings until someone runs that command.
- A node-restricted access token cannot open these fleet-global plugin views.

## Scope migration and rollback

The server floor in `manifest.json` (`compatibility.server`) provides directional
runtime compatibility:

| Existing grant | vpn-core | Sub-Store | Native proxy APIs |
| --- | --- | --- | --- |
| `proxy:read/admin` | matching read/admin allowed | matching read/admin allowed | allowed |
| `vpncore:read/admin` | allowed | denied | matching read/admin allowed |
| `substore:read/admin` | denied | allowed | denied |

Read never implies admin, and `prefix:*` follows the same directions. Delegation
is directed: legacy proxy grants may delegate equal-strength canonical scopes for
migration; canonical scopes cannot delegate proxy scopes or each other.

Roll out the compatible server first, then the matching Dashboard, then this
canonical-scope manifest. Roll back in reverse: restore the plugin manifests to
legacy `proxy:*` declarations first, then the Dashboard, and remove server
compatibility last, only after canonical grants have been migrated or removed.

## Local verification

`ui/.npmrc` points `@latticenet` at GitHub Packages, so `npm ci` needs a
`GITHUB_TOKEN` in the environment. CI supplies one; a local run without it fails
at the install step.

```sh
go test -race ./system-go/...
go test -race ./tools/pluginpack/...
cd ui
npm ci
npm test
npm run typecheck
npm run build
npm run verify:build
```

CI additionally runs the pinned `lattice-plugin-manifest-check` conformance gate,
which catches manifest regressions the commands above do not.

To drive the UI in a browser, `ui/dev.html` runs the real build inside a real
iframe and speaks the real bridge protocol at it, including sizing the frame to
the height the plugin reports, so overlay anchoring behaves as it does in the
console. There is no `dev` script in `ui/package.json`, so start it with
`npx vite --open /dev.html` from `ui`. It takes `?route=`, `?scenario=`,
`?width=`, `?theme=` and `?measure=1`; the scenarios are `production`,
`offfleet`, `rich`, `dense`, `empty` and `failing`.

## Reproducible bundle

Build Linux runtimes with Go `1.26.4`, build the UI with Node `22`, then assemble:

```text
bin/linux-amd64/plugin
bin/linux-arm64/plugin
ui/index.html
ui/assets/*
```

`tools/pluginpack/cmd/pluginpack` writes a deterministic `tar+gzip` artifact and
prints its SHA-256 digest. `tools/bump.sh` keeps the version in `manifest.json`,
`ui/package.json` and `system-go/main.go` in step. Put the digest in
`manifest.json`, then sign the canonical manifest with the trusted LatticeNet
Ed25519 seed using `lattice-server/cmd/pluginsign`. Signing has to come after the
digest, so that a signature can never cover a bundle that was rebuilt afterwards.
Never commit the signing seed; signing, tagging, publishing, and release
promotion are separate authorized operations.
