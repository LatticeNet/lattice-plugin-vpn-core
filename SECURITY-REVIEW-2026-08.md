# Sidecar security review, 2026-08-19

Coverage note for the Go sidecar in this repo. Written as part of the org-wide
plugin trust-boundary review, whose main result was three findings in
lattice-plugin-sub-store. This repo produced none of that class. It has the
largest declared surface of the four, 26 methods, and the smallest sidecar,
106 lines, which is the whole reason it came out clean.

Reviewed against `origin/integration` at `1430ddc` (0.8.0-alpha.14).

## What was opened

`system-go/main.go` in full. That is the entire sidecar: one file, 106 lines,
no other non-test Go source in `system-go/`.

`manifest.json` in full: 6 interfaces, 26 declared methods, every one of them
`backing: core`.

`tools/pluginpack/pluginpack.go`, checked for archive path handling only. It is
byte-identical across all four plugin repos and already refuses `..`, absolute
paths, and `.` at line 125.

The test suite was run per-test. Three tests fail, all version and signing
drift, covered below.

This repo also got a second look from the sub-store side, because sub-store is
the one plugin that calls into it. sub-store's manifest declares `host_access`
permitting exactly `latticenet.vpn-core/nodes.export` and
`latticenet.vpn-core/subscription-sources.compose|graph_options`, and every RPC
target in sub-store is a compile-time constant matching that allowlist, with no
dynamic service or method string anywhere. So nothing reaches this plugin's
surface beyond what is declared, verified from the calling side.

## What was deliberately not opened

`ui/` was out of scope; a separate lane owned the plugin UIs and the bridge.

The server-side implementations of all 26 declared methods were not reviewed
here. Every interface is `backing: core`, so they live in lattice-server. This
matters more for this repo than for its siblings, because the declared surface
includes `users-admin` methods (`create`, `update`, `delete`, `rotate`,
`plan_add`, `plan_update`) that handle VLESS-REALITY key generation and user
credentials. Whether those in-core implementations honour their declared
`vpncore:admin` scope is unexamined and is exactly the question a server review
should answer.

One specific item I could not close from this repo, flagged during the sub-store
work and still open: sub-store's `fetchExport` passes a caller-supplied
`user_id` into `latticenet.vpn-core/nodes.export`. Whether that export filters
by the calling principal or trusts the supplied identity is decided in core, not
here. If it trusts it, that is a cross-user credential read. It needs checking
on the server side.

## The four questions

**Does any method declare a scope narrower than what it actually reaches?**

No, and structurally it cannot. All 26 declared methods are `backing: core`, and
the sidecar answers only the three lifecycle actions (`describe`, `health`,
`plan`). It serves none of the scoped methods, so there is no behaviour here for
a declared scope to be narrower than.

Checked rather than assumed: `TestManifestInterfacesAreServedAsDeclared` asserts
a core-backed method is *not* answered by the artifact, and it passes for all 26.
`TestUnsupportedActionFailsClosed` passes, so anything outside the three
lifecycle actions is refused. `TestManifestRemovesSubscriptionsSurface`,
`TestManifestScopesProfileSettingsPerNode` and
`TestManifestDeclaresLineChainContract` pass, so the declared surface is the
intended one.

This is the class that produced all three sub-store findings, where a method
declared `substore:read` ran caller-supplied JavaScript with the host egress
broker attached. Nothing of that shape can exist here, because the sidecar runs
no caller-supplied anything.

**Does the sidecar perform its own network I/O or DNS?**

No. Zero call sites for any SDK host method (`rpc.call`, `http.do`,
`http.operator.do`, `kv.*`, `secret.*`, `notify.send`, `log.write`), no
`net/http` import, no `net.Dial`, no `net.Lookup*`. The handler takes the host
client and discards it (`handleSDKRequest`, `main.go:42-44`), so it holds no
client to misuse, and `TestSDKHandlerPreservesCoreBackedHostBoundary` pins that
directly. This is the only one of the four repos with an explicit test for the
property rather than only the absence of call sites.

**Does any credential or secret reach a log line, an error string, or a reply?**

This is the one real gap in this repo, and of the two repos that share it this
is the one where it is worth more than a style note.

`renderPlan` (`main.go:94-105`) echoes every key and value of the plan payload
into the returned plan text with no filtering. lattice-plugin-wireguard does not
do this: it uses a field allowlist plus a sensitive-name denylist
(`main.go:34-47`, `main.go:137-149`), and sub-store's own `renderPlan` redacts
anything whose key contains url, secret, token, password or key.

Rated low, on the same reasoning as netguard: the plan payload echoes back to
the caller who supplied it, so a caller only ever sees their own input, and a
grep of lattice-server shows `Action: "plan"` occurring only in tests, so no
production path feeds credential-bearing data into it.

What makes it more worth fixing here than in netguard is the domain. netguard
handles firewall zones and bindings, which carry no credentials. This plugin's
declared surface is sing-box users, VLESS-REALITY key generation, and
subscription export, so a plan payload in this domain is far more likely to
carry a UUID, a password or a REALITY private key if the plan action is ever
wired to those flows. wireguard, whose domain is equally key-bearing, already
concluded the same thing and redacts. Copying its filter here is a few lines.

The residual risk, and the reason it is not zero today: if a plan is ever
persisted into an approval a second operator reviews, the echo stops being
self-directed.

Nothing else leaks. The `describe` response is a static literal.
`TestRenderPlanIsDeterministicAndNonMutating` and
`TestPlanActionUsesRequestPayload` pass, so the plan path is at least
predictable. Error strings are `fmt.Errorf` over the action name and a JSON
decode error, neither of which carries payload content.

**Does anything reach a shell, a file path, or a generated config from an
operator-supplied or upstream-supplied string?**

No. There is no `os/exec`, no `exec.Command`, no file read or write, no
`filepath` use, and no `text/template` or `html/template` anywhere in the
sidecar. The plan text is string concatenation into a comment block that is
returned, not executed and not written anywhere.

This one deserves an explicit note because the plugin's own `describe` output
advertises "on-box node discovery (read-only `sb --json list`)" and "managed
add/remove on existing 233boy machines (`sb --json add/del`)". Those are shell
invocations on a node, and they are not in this repo. The sidecar names the
capability in a static string; the execution happens through the core
plan-approve-apply pipeline and the node agent. Nothing in this subprocess
builds or runs a command line. Whether the in-core construction of those `sb`
invocations is injection-safe against operator-supplied node names or user
identifiers is unexamined and is a server-side question worth asking, since it
is the one place in this plugin's advertised surface where a string does reach a
shell.

## Open, not fixed here

Three tests fail on `origin/integration`:

`TestDescribeMatchesManifestContract`. The describe-time constant is
`0.8.0-alpha.10` (`main.go:27`) while the signed manifest is `0.8.0-alpha.14`,
so the artifact reports a version four alphas behind what the host enforces
against.

`TestVersionContractIsAlpha10AndUnsignedForHandoff` and
`TestSigningHandoffMatchesManifestVersionAndBundleDigest`. These pin a signing
handoff to a version and bundle digest that no longer match.

All three are release-process failures on a branch being shipped from, with the
guards designed to catch them already present and already red. That makes it a
decision rather than something to patch quietly. sub-store had the same version
drift with no guard at all; that one has since been fixed and pinned.
