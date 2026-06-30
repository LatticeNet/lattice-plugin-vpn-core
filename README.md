# lattice-plugin-vpn-core

Official LatticeNet system plugin. Built from `lattice-plugin-template`.

- **Type:** `system`
- **Publisher:** `latticenet`
- Registered in [lattice-plugin-index](https://github.com/LatticeNet/lattice-plugin-index).

The plugin artifact (`system-go/`) implements the Lattice system-plugin stdio
contract (newline-JSON `{action,payload}` -> `{ok,plan,message,result,error}`);
the Lattice system runner executes it for the verify/plan/health lifecycle. The
heavy engine stays in `lattice-server` (ADR-001 D5/D6: engine in core, providers
are officially-maintained registered plugins). See `manifest.json` for the
declared capability set.

## Dashboard contribution surface

The plugin contributes first-party VPN Manage pages through manifest navigation
entries and builtin dashboard component keys:

- `vpn-core.lines`
- `vpn-core.users`
- `vpn-core.profiles`
- `vpn-core.subscriptions`
- `vpn-core.usage`

These keys must be registered in both places:

- dashboard `PluginView.vue` builtin component registry
- server plugin contribution builtin view registry

The manifest declares the navigation and interface surface; the builtin
registries are the trusted first-party bridge that resolves those declarations
to the shipped dashboard views. If a manifest points at a component key that is
not registered, the plugin can still load but the page renders as unavailable.

## Operational model

vpn-core is a control-plane entrypoint for sing-box VPN management. It is not the
ultimate source of truth for a node's live sing-box configuration.

Authoritative layers:

1. The node's actual sing-box configuration and runtime state.
2. Discovered inventory reported by the node-agent or probe tasks.
3. vpn-core stored control-plane intent: users, line bindings, profiles,
   subscriptions, usage snapshots, and operator annotations.

When Lattice writes or rewrites node sing-box config, it should preserve enough
metadata to make future reads reversible. Use explicit Lattice-owned comments or
annotations where the target sing-box config format permits it, for example
`lattice_comment_<field>` style metadata beside generated inbounds/outbounds.
The goal is to keep operator intent recoverable while still treating sing-box's
real config as the fact standard.

Discovered-only lines are observed facts. They should be displayed and can be
adopted by an operator, but they should not be silently treated as fully managed
vpn-core state.

## Current pages

### Lines

Lines are the node-facing sing-box entrypoints. Inbounds are converging into
Lines so an operator can reason in terms of "this node has this protocol/port
line with these users bound" rather than switching between separate line and
inbound concepts.

### Users

Users are VPN identities. The desired UX is one identity with a complete
credential set rather than forcing the operator to create one protocol at a
time. Secrets are write-only in the dashboard contract; read views expose only
presence such as `has_secret`.

### Node Profiles

Profiles bind node runtime behavior and line selection. They are control-plane
intent and should be reconciled with discovered runtime state before destructive
host writes.

### Subscriptions

Subscriptions are producer-side views of user/line/profile state. They define
what the control plane can serve; publisher integration remains a separate
boundary.

### Usage

Usage currently exposes control-plane snapshots. Historical per-line accounting
depends on the node-side sing-box stats collector and should be treated as an
enrichment layer until that collector is live.

## Capability boundaries

The system runner executes the Linux artifact under the plugin runtime directory
and brokers host calls through the Lattice plugin bridge. Host calls are
capability checked:

- `rpc:call`
- `http:egress`
- plugin KV
- notify/log bridge calls

Outbound HTTP uses the same guarded egress model as server webhooks and must not
be used to reach loopback/private/metadata targets unless explicitly supported
by a reviewed local capability.

## Build

```sh
cd system-go && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -o lattice-plugin-vpn-core .
```
