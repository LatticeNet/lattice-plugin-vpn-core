# lattice-plugin-vpn-core

Official LatticeNet sing-box management plugin. This repository owns the complete
plugin bundle: signed manifest, Linux runtime, sandboxed operator UI, deterministic
packer, tests, and release workflow inputs.

Current implementation candidate: `v0.8.0-alpha.10` (unsigned until the authorized release handoff).

## Ownership boundary

The plugin owns its four Extensions pages and their interaction logic:

- Lines
- Users
- Node Profiles
- Usage

The Dashboard does not compile these pages. It only discovers signed navigation
contributions, serves the verified bundle assets, supplies theme tokens, and
brokers exact manifest-declared RPC methods through the nonce-bound iframe bridge.
Uninstalling or deactivating this plugin removes all four entries without leaving
VPN-specific components in the base Dashboard.

The durable rendering, agent task, encrypted store, and approval engines remain in
`lattice-server`. They are exposed as services owned by `latticenet.vpn-core` so
the plugin can evolve its UI independently without duplicating security-critical
host mutation logic. Exact plugin/service ownership is checked before a Bundle v2
call may use an in-core service.

## Security model

- The iframe runs with `sandbox="allow-scripts"`; it receives no same-origin or
  top-navigation capability.
- Every call is constrained to a service and method declared in `manifest.json`.
- Fleet-wide Lines, Users, profiles, and usage reads require `vpncore:read`.
  Per-node profile settings additionally require exact-node `node:read`.
- Identity mutations require `vpncore:admin`. Saving sing-box node integration
  settings requires exact-node `node:admin` plus `task:run`.
- Credential secrets are write-only. Read models expose `has_secret`, never UUIDs
  or passwords.
- Line-chain reads expose desired/reconciliation state through
  `latticenet.vpn-core/lines.chains`; planning uses `plan_chain` and
  `plan_remove_chain`. Those external names intentionally differ from the
  internal `network/lines.chain_*_apply` approval bindings.
- Saving plugin-owned launch settings preserves every generic agent setting,
  records an audit event, and returns a reviewable reconfiguration command. It
  does not queue or execute a host task.
- Host mutation still uses plan, approval, bounded agent task, and audit paths.
- A node-restricted access token cannot open these fleet-global plugin views.

## Scope migration and rollback

The `>=0.2.2-alpha.2` server floor provides directional runtime compatibility:

| Existing grant | vpn-core | Sub-Store | Native proxy APIs |
| --- | --- | --- | --- |
| `proxy:read/admin` | matching read/admin allowed | matching read/admin allowed | allowed |
| `vpncore:read/admin` | allowed | denied | matching read/admin allowed |
| `substore:read/admin` | denied | allowed | denied |

Read never implies admin, and `prefix:*` follows the same directions. Delegation
is directed: legacy proxy grants may delegate equal-strength canonical scopes
for migration; canonical scopes cannot delegate proxy scopes or each other.

Roll out the compatible server first, then the matching Dashboard, then this
canonical-scope manifest. Roll back in reverse: restore the plugin manifests to
legacy `proxy:*` declarations first, then the Dashboard, and remove server
compatibility last only after canonical grants have been migrated or removed.

## Local verification

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

## Reproducible bundle

Build Linux runtimes with Go `1.26.4`, build the UI with Node `22`, then assemble:

```text
bin/linux-amd64/plugin
bin/linux-arm64/plugin
ui/index.html
ui/assets/*
```

`tools/pluginpack/cmd/pluginpack` writes a deterministic `tar+gzip` artifact and
prints its SHA-256 digest. Put that digest in `manifest.json`, then sign the
canonical manifest with the trusted LatticeNet Ed25519 seed using
`lattice-server/cmd/pluginsign`. The implementation branch deliberately leaves
`signature_ed25519` empty so an obsolete signature cannot appear valid. Never
commit the signing seed; signing, tagging, publishing, and release promotion are
separate authorized operations.
