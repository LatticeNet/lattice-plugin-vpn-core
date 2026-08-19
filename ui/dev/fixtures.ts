/**
 * Canned answers shaped like the wire, for looking at the plugin in a browser.
 *
 * The default scenario is the fleet the owner actually has: 21 nodes, 111
 * lines, nothing Lattice-managed, no chains, no usage collector. Those zero
 * states are the primary experience today, so they are the default here rather
 * than an afterthought. Anything the harness cannot answer throws, because a
 * mock that quietly returns undefined teaches the UI to tolerate nonsense.
 *
 * Never imported by src/; the shipped bundle is built from index.html alone.
 */

export type Scenario = "production" | "rich" | "empty" | "failing";

const NODE_NAMES = [
  "hkg-edge-01", "hkg-edge-02", "sin-edge-01", "sin-edge-02", "nrt-edge-01",
  "nrt-edge-02", "lax-exit-01", "lax-exit-02", "fra-exit-01", "fra-exit-02",
  "ams-exit-01", "lhr-relay-01", "syd-relay-01", "icn-relay-01", "tpe-relay-01",
  "sjc-hub-01", "ord-hub-01", "iad-hub-01", "cdg-hub-01", "waw-hub-01", "gru-hub-01",
];

const LINE_KINDS = [
  { name: "VLESS-REALITY-443", type: "vless", port: 443, domain: "www.microsoft.com" },
  { name: "Trojan-8443", type: "trojan", port: 8443, domain: "www.cloudflare.com" },
  { name: "VLESS-REALITY-2053", type: "vless", port: 2053, domain: "www.apple.com" },
  { name: "Hysteria2-36712", type: "hysteria2", port: 36712, domain: "" },
  { name: "Shadowsocks-9000", type: "shadowsocks", port: 9000, domain: "" },
  { name: "VMess-WS-80", type: "vmess", port: 80, domain: "" },
];

function uuid(seed: number): string {
  const hex = seed.toString(16).padStart(12, "0");
  return `0000${hex.slice(0, 4)}-${hex.slice(4, 8)}-4${hex.slice(8, 11)}-8${hex.slice(0, 3)}-${hex}${hex.slice(0, 0)}`.padEnd(36, "0").slice(0, 36);
}

interface FixtureLine {
  id: string; line_hash_id: string; line_uuid?: string; node_id: string; core: string;
  source: string; managed: boolean; name: string; type?: string; listen_host?: string;
  listen_port?: number; public_host?: string; domain?: string; outbound_ref?: string;
  outbound_server?: string; outbound_port?: number; jump_edges?: string[];
  declared_jump_edges?: string[]; overlay?: boolean; overlay_status?: string;
  overlay_user?: string; metadata?: Record<string, string>; user_count: number;
  user_known: boolean; status?: string; last_error?: string;
}

/** 111 lines over 21 nodes, the exact counts production reports. */
function buildLines(scenario: Scenario): Array<{ node_id: string; node_name: string; lines: FixtureLine[] }> {
  if (scenario === "empty") return [];
  const groups = NODE_NAMES.map((name) => ({ node_id: `node-${name}`, node_name: name, lines: [] as FixtureLine[] }));
  let made = 0;
  for (let index = 0; made < 111; index += 1) {
    const group = groups[index % groups.length];
    const kind = LINE_KINDS[made % LINE_KINDS.length];
    const managed = scenario === "rich" && made % 9 === 0;
    const failing = scenario === "rich" && made % 17 === 5;
    const pending = scenario === "rich" && made % 23 === 7;
    group.lines.push({
      id: `l${made}`,
      line_hash_id: `lh_${made.toString().padStart(4, "0")}`,
      line_uuid: uuid(made + 1),
      node_id: group.node_id,
      core: "sing-box",
      source: managed ? "managed" : "discovery",
      managed,
      name: kind.name,
      type: kind.type,
      listen_host: "0.0.0.0",
      listen_port: kind.port,
      public_host: `${group.node_name}.example.invalid`,
      domain: kind.domain,
      outbound_ref: made % 4 === 0 ? "direct" : `relay-${(made % 5) + 1}`,
      outbound_server: made % 4 === 0 ? undefined : `${NODE_NAMES[(index + 3) % NODE_NAMES.length]}.example.invalid`,
      outbound_port: made % 4 === 0 ? undefined : 443,
      user_count: made % 7,
      user_known: made % 11 !== 3,
      status: failing ? "error" : pending ? "pending" : "ok",
      last_error: failing ? "listen tcp 0.0.0.0:8443: bind: address already in use" : undefined,
      overlay: managed,
      overlay_status: managed ? "applied" : undefined,
      overlay_user: managed ? "ops@example.invalid" : undefined,
      metadata: managed ? { lattice_line_uuid: uuid(made + 1), tag: `lattice-mng-${kind.port}` } : undefined,
    });
    made += 1;
  }
  return groups;
}

function buildChains(scenario: Scenario) {
  if (scenario !== "rich") return [];
  return [
    {
      source_line_uuid: uuid(1), source_node_id: "node-hkg-edge-01", status: "converged",
      current: { target_line_uuid: uuid(10), target_node_id: "node-sjc-hub-01", artifact_digest: "sha256:aa", status: "converged" },
      attempt: null, observed_downstream_line_uuid: uuid(10), observed_outbound_tag: "relay-1",
    },
    {
      source_line_uuid: uuid(10), source_node_id: "node-sjc-hub-01", status: "applied_unobserved",
      current: { target_line_uuid: uuid(19), target_node_id: "node-lax-exit-01", artifact_digest: "sha256:bb", status: "applied_unobserved" },
      attempt: null,
    },
    {
      source_line_uuid: uuid(28), source_node_id: "node-fra-exit-01", status: "planned",
      current: null,
      attempt: { operation: "set", candidate_target_line_uuid: uuid(37), approval_id: "apr_7f31", status: "planned" },
    },
    {
      source_line_uuid: uuid(46), source_node_id: "node-cdg-hub-01", status: "drifted",
      current: { target_line_uuid: uuid(55), status: "converged" },
      attempt: null, observed_downstream_line_uuid: uuid(64),
      last_error: "observed downstream does not match the committed baseline",
    },
    {
      source_line_uuid: uuid(73), source_node_id: "node-waw-hub-01", status: "failed",
      current: null,
      attempt: { operation: "set", candidate_target_line_uuid: uuid(82), approval_id: "apr_91ac", status: "failed", error_code: "apply_refused", error: "agent refused the reload: config check failed" },
    },
  ];
}

const USERS = [
  {
    id: "u_ops", email: "ops@example.invalid", name: "Operations", enabled: true,
    credentials: [{ protocol: "vless", flow: "xtls-rprx-vision", has_secret: true }],
    bindings: [{ line_hash_id: "lh_0000", enabled: true }],
    quota_bytes: 0, group: "staff", migrated: false,
    created_at: "2026-01-04T09:12:00Z", updated_at: "2026-08-02T11:00:00Z",
  },
  {
    id: "u_lab", email: "lab@example.invalid", name: "Lab", enabled: true,
    credentials: [{ protocol: "vless", has_secret: true }, { protocol: "trojan", has_secret: true }],
    bindings: [{ line_hash_id: "lh_0001", enabled: true }, { line_hash_id: "lh_0002", enabled: false }],
    quota_bytes: 500 * 1024 ** 3, expires_at: "2026-12-31T00:00:00Z", group: "lab", migrated: true,
    created_at: "2026-02-11T09:12:00Z", updated_at: "2026-07-30T11:00:00Z",
  },
  {
    id: "u_retired", email: "retired-contractor-with-a-very-long-address@example.invalid", enabled: false,
    credentials: [], bindings: [], migrated: false,
    created_at: "2025-11-01T09:12:00Z", updated_at: "2026-03-30T11:00:00Z",
  },
];

function buildProfiles(scenario: Scenario) {
  if (scenario === "empty") return [];
  return NODE_NAMES.map((name, index) => ({
    node_id: `node-${name}`,
    node_name: name,
    managed: scenario === "rich" && index % 4 === 0,
    core: "sing-box",
    core_version: "1.12.4",
    config_path: `/etc/sing-box/config.json`,
    stats_api: index % 3 === 0 ? "127.0.0.1:8080" : undefined,
    applied: scenario === "rich" && index % 8 === 0,
    last_error: scenario === "rich" && index === 5 ? "sb: exit status 1: config check failed at inbounds[3]" : undefined,
    inbound_count: 5 + (index % 3),
    discovered_count: 5 + (index % 3),
    discovery_status: "ok",
    collector: index % 3 === 0 ? { source: "singbox_stats_api", status: "ok" } : { status: "not configured" },
    capabilities: ["discover", "apply"],
  }));
}

function buildUsage(scenario: Scenario) {
  if (scenario !== "rich") return { by_user: [], by_node: [], collectors: [], per_line: false };
  return {
    per_line: true,
    by_user: USERS.filter((user) => user.enabled).map((user, index) => ({
      user_id: user.id, email: user.email,
      used_bytes: (index + 1) * 91 * 1024 ** 3,
      quota_bytes: user.quota_bytes || undefined,
      status: index === 1 ? "over_quota" : "active",
      last_seen: "2026-08-18T09:00:00Z",
    })),
    by_node: NODE_NAMES.slice(0, 7).map((name, index) => ({
      node_id: `node-${name}`, node_name: name,
      used_bytes: (index + 1) * 43 * 1024 ** 3,
      user_count: 2 + (index % 3),
      at: "2026-08-18T09:00:00Z",
    })),
    collectors: NODE_NAMES.slice(0, 7).map((name, index) => ({
      node_id: `node-${name}`, node_name: name,
      source: "singbox_stats_api",
      status: index === 4 ? "error" : "ok",
      error: index === 4 ? "dial tcp 127.0.0.1:8080: connect: connection refused" : undefined,
      checked_at: "2026-08-18T09:00:00Z",
    })),
  };
}

export function handlers(scenario: Scenario): Record<string, (payload: any) => unknown> {
  const groups = buildLines(scenario);
  const chains = buildChains(scenario);
  const flat = groups.flatMap((group) => group.lines);
  return {
    "lines/list": () => ({ groups }),
    "lines/chains": () => ({ chains }),
    "lines/managed": () => ({
      managed_lines: scenario === "rich"
        ? [{
            line_uuid: uuid(900), node_id: "node-gru-hub-01", line_hash_id: "lh_9000",
            tag: "lattice-mng-24443", port: 24443, sni: "www.microsoft.com",
            user_id: "u_ops", user_name: "ops", status: "planned", approval_id: "apr_5c02",
            created_at: "2026-08-17T09:00:00Z", updated_at: "2026-08-17T09:00:00Z",
          }]
        : [],
    }),
    "lines/get": ({ line_hash_id }: { line_hash_id: string }) => {
      const found = flat.find((line) => line.line_hash_id === line_hash_id);
      if (!found) throw new Error(`line "${line_hash_id}" was not found`);
      return { line: { ...found, metadata: found.metadata ?? { discovered_at: "2026-08-18T08:40:00Z" } } };
    },
    "lines/rollout": () => ({
      ok: true,
      planned: NODE_NAMES.slice(0, 18).map((name, index) => ({
        node_id: `node-${name}`, approval_id: `apr_${index}`, line_uuid: uuid(500 + index),
        tag: "lattice-mng-24443", port: 24443 + (index % 3), sni: "www.microsoft.com",
      })),
      skipped: [
        { node_id: "node-syd-relay-01", reason: "agent offline for 3 days" },
        { node_id: "node-icn-relay-01", reason: "port 24443 through 24445 already bound" },
        { node_id: "node-tpe-relay-01", reason: "node does not allow task execution" },
      ],
    }),
    "lines/plan_chain": () => ({ approval: { id: "apr_new_chain" }, preview: { summary: "One outbound is rewritten on the source node." } }),
    "lines/plan_remove_chain": () => ({ approval: { id: "apr_drop_chain" }, preview: { summary: "The source outbound returns to direct." } }),
    "lines/sync_metadata": () => ({ approval: { id: "apr_sync", plan: JSON.stringify({ summary: "write the sidecar identity file" }) } }),
    "lines/reattach": () => ({ ok: true }),
    "users/list": () => ({ users: USERS }),
    "users-admin/create": () => ({ ok: true }),
    "users-admin/update": () => ({ ok: true }),
    "users-admin/delete": () => ({ ok: true }),
    "users-admin/bind": () => ({ ok: true }),
    "users-admin/unbind": () => ({ ok: true }),
    "users-admin/rotate": () => ({ protocol: "vless", revealed_credential: "4f2a1c88-0d55-4a3e-9d31-6b71f0c2a9de" }),
    "users-admin/plan_add": () => ({ approval: { id: "apr_add", plan: JSON.stringify({ summary: "sb user add" }) } }),
    "users-admin/plan_update": () => ({ approval: { id: "apr_upd", plan: JSON.stringify({ summary: "sb user update" }) } }),
    "users-admin/plan_remove": () => ({ approval: { id: "apr_del", plan: JSON.stringify({ summary: "sb user del" }) } }),
    "profiles/query": () => ({ profiles: buildProfiles(scenario) }),
    "profiles/settings": ({ node_id }: { node_id: string }) => ({
      node_id,
      node_name: node_id.replace("node-", ""),
      prerequisites: {
        allow_exec: true, allow_root_exec: false, no_exec: false,
        reported_allow_exec: true, reported_allow_root_exec: false, reported_no_exec: false,
      },
      saved: { singbox_discover: true, singbox_bin: "/usr/local/bin/sb", singbox_stats_api: "127.0.0.1:8080" },
      reported: { singbox_discover: true, singbox_bin: "/usr/local/bin/sb" },
      reconfigure_required: true,
    }),
    "profiles/configure": ({ node_id }: { node_id: string }) => ({
      command: `lattice-agent reconfigure --node ${node_id} --set singbox_discover=true`,
      settings: {
        node_id, node_name: node_id.replace("node-", ""),
        prerequisites: {
          allow_exec: true, allow_root_exec: false, no_exec: false,
          reported_allow_exec: true, reported_allow_root_exec: false, reported_no_exec: false,
        },
        saved: { singbox_discover: true, singbox_bin: "/usr/local/bin/sb" },
        reconfigure_required: false,
      },
    }),
    "usage/query": () => buildUsage(scenario),
  };
}
