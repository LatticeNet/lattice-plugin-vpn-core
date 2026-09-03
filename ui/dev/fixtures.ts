/**
 * Canned answers shaped like the wire, for looking at the plugin in a browser.
 *
 * The default scenario is the fleet the owner actually has: 21 nodes, 111
 * lines, nothing Lattice-managed, no chains, no usage collector. Those zero
 * states are the primary experience today, so they are the default here rather
 * than an afterthought. Anything the harness cannot answer throws, because a
 * mock that quietly returns undefined teaches the UI to tolerate nonsense.
 *
 * Outbounds and jump_edges are kept internally consistent per scenario, which
 * an earlier revision of this file was not. The server derives jump_edges from
 * each line's own outbound (host, port) against a fleet-wide listen index, so
 * a fixture cannot both point its outbounds at fleet endpoints and report no
 * edges: that combination cannot come off the wire. "production" is therefore
 * a flat fleet of direct exits, "offfleet" relays through upstreams the
 * control plane does not own, "rich" carries the handful of edges the server
 * would compute for a fleet with real hub/exit structure, and "dense" relays
 * almost everything, which is what stops a drawing being readable.
 *
 * Never imported by src/; the shipped bundle is built from index.html alone.
 */

import type { UsageLineRow } from "../src/usageModel";

export type Scenario = "production" | "hubs" | "offfleet" | "rich" | "dense" | "empty" | "failing";

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
  service_state?: string; service_checked_at?: string; service_note?: string;
}

/** "dense" is "rich" with the relay density turned up; everything else matches. */
const isRich = (scenario: Scenario) => scenario === "rich" || scenario === "dense";

/**
 * What a line's outbound looks like, and therefore whether an edge can exist.
 *
 * production: every line exits directly, so the fleet has no relay structure.
 * offfleet:   three quarters relay through vendor endpoints Lattice cannot see.
 * rich:       a few hubs relay onto fleet endpoints and carry the resolved edge.
 * dense:      almost everything relays, which is what makes a drawing unreadable.
 */
function outboundShape(scenario: Scenario, made: number, index: number): Partial<FixtureLine> {
  if (scenario === "production") return { outbound_ref: "direct" };
  if (scenario === "rich" ? made % 11 !== 4 : made % 4 === 0) return { outbound_ref: "direct" };
  if (scenario === "offfleet") {
    return {
      outbound_ref: `relay-${(made % 5) + 1}`,
      outbound_server: `edge-${(made % 3) + 1}.vendor-transit.example.invalid`,
      outbound_port: 443,
    };
  }
  // The target is the port-443 line on another node, which is the line the
  // server's listen index would have matched. Its hash, not its uuid: the
  // relay graph is addressed by line_hash_id.
  const targetSlot = ((index + 3) % NODE_NAMES.length) * 6;
  return {
    outbound_ref: `relay-${(made % 5) + 1}`,
    outbound_server: `${NODE_NAMES[(index + 3) % NODE_NAMES.length]}.example.invalid`,
    outbound_port: 443,
    jump_edges: [`lh_${targetSlot.toString().padStart(4, "0")}`],
    declared_jump_edges: made % 3 === 0 ? [`lh_${targetSlot.toString().padStart(4, "0")}`] : undefined,
  };
}

/** 111 lines over 21 nodes, the exact counts production reports. */
function buildLines(scenario: Scenario): Array<{ node_id: string; node_name: string; lines: FixtureLine[] }> {
  if (scenario === "empty") return [];
  const groups = NODE_NAMES.map((name) => ({ node_id: `node-${name}`, node_name: name, lines: [] as FixtureLine[] }));
  let made = 0;
  for (let index = 0; made < 111; index += 1) {
    const group = groups[index % groups.length];
    const kind = LINE_KINDS[made % LINE_KINDS.length];
    const managed = isRich(scenario) && made % 9 === 0;
    const failing = isRich(scenario) && made % 17 === 5;
    const pending = isRich(scenario) && made % 23 === 7;
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
      ...outboundShape(scenario, made, index),
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

/**
 * The relay fleet the owner actually runs, at the shape the wire reports it
 * (2026-09-02: 25 nodes, 138 lines, 101 relay edges, nothing managed, no
 * liveness reported). Six hubs each carry the same bank of twelve VLESS
 * relays onto seven exits; the two gomami minis carry a second Trojan bank;
 * on the [cd] side one node fans out to four named endpoints, one of which
 * relays again. This is the fixture the topology drawing is judged against.
 */
const HUB_EXITS: Array<{ node: string; host: string; ports: [number, number] }> = [
  { node: "[Metix]-qqpw-cd2-VDS", host: "72.253.152.126", ports: [53591, 53592] },
  { node: "[Metix]-qqpw-cd3-VDS", host: "72.253.152.48", ports: [42739, 42740] },
  { node: "[Metix]-Aaitr-ATT-VDS", host: "108.202.51.182", ports: [29555, 29556] },
  { node: "[Metix]-Aaitr-Frontier-VDS", host: "47.178.47.100", ports: [60295, 60296] },
  { node: "[Metix]-Aaitr-Frontier-NAT", host: "nat-us-28tz.aproxy.top", ports: [22918, 0] },
  { node: "[Metix]-Aaitr-jp-softbank-NAT", host: "nat-jp-3h8e.aproxy.top", ports: [17380, 0] },
  { node: "[Metix]-VIRCS-ATT-VDS", host: "12.22.163.232", ports: [34656, 34657] },
];
const HUBS: Array<{ node: string; trojan: boolean; own: Array<[string, string, number]> }> = [
  { node: "[Metix]-DMIT-1", trojan: false, own: [["VLESS-REALITY-32426.json", "vless", 32426]] },
  { node: "[Metix]-DMIT-2", trojan: false, own: [["VLESS-REALITY-61346.json", "vless", 61346]] },
  { node: "[Metix]-DMIT-3", trojan: false, own: [["VLESS-REALITY-52714.json", "vless", 52714]] },
  { node: "[Metix]-DMIT-4", trojan: false, own: [["VLESS-REALITY-64768.json", "vless", 64768]] },
  { node: "[Metix]-gomami-hk-turin-mini", trojan: true, own: [["VLESS-REALITY-8468.json", "vless", 8468], ["Trojan-8469.json", "trojan", 8469]] },
  { node: "[Metix]-gomami-jp-pulse-mini", trojan: true, own: [["VLESS-REALITY-52971.json", "vless", 52971], ["Trojan-52972.json", "trojan", 52972]] },
];
const CD_EXITS: Array<{ node: string; lines: Array<[string, string, number]> }> = [
  { node: "[cd]-Aaitr-ATT-VDS", lines: [["VLESS-REALITY-57289.json", "vless", 57289]] },
  { node: "[cd]-Aaitr-Frontier-NAT", lines: [["VLESS-REALITY-7899.json", "vless", 7899]] },
  { node: "[cd]-huoshan-shanghai", lines: [["VLESS-REALITY-34099.json", "vless", 34099]] },
  { node: "[cd]-LegendVPS-SG-EVO", lines: [["VLESS-REALITY-17891.json", "vless", 17891], ["Hysteria2-17892.json", "hysteria2", 17892]] },
  { node: "[cd]-Akkocloud-UK-London-KVM", lines: [["VLESS-REALITY-62962.json", "vless", 62962]] },
  { node: "[cd]-gomami-jpn-pulse-nano", lines: [["Hysteria2-13434.json", "hysteria2", 13434], ["VLESS-REALITY-16051.json", "vless", 16051]] },
  { node: "[cd]-DMIT-pro-malibu", lines: [["Hysteria2-17892.json", "hysteria2", 17892], ["VLESS-REALITY-17893.json", "vless", 17893]] },
  { node: "[cd]-qqpw-VDS-cd1", lines: [["VLESS-REALITY-62255.json", "vless", 62255]] },
  { node: "[cd]-xuezhang-jp-NAT", lines: [["VLESS-REALITY-488.json", "vless", 488], ["Hysteria2-7890.json", "hysteria2", 7890]] },
  { node: "[cd]-xuezhang-ca-NAT", lines: [["VLESS-REALITY-50981.json", "vless", 50981]] },
];

function buildHubFleet(): Array<{ node_id: string; node_name: string; lines: FixtureLine[] }> {
  const groups = new Map<string, { node_id: string; node_name: string; lines: FixtureLine[] }>();
  let made = 0;
  const group = (name: string) => {
    const id = `node-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
    return groups.get(id) ?? groups.set(id, { node_id: id, node_name: name, lines: [] }).get(id)!;
  };
  const push = (name: string, line: Omit<FixtureLine, "id" | "line_hash_id" | "line_uuid" | "node_id" | "core" | "source" | "managed" | "user_count" | "user_known" | "status">): FixtureLine => {
    const target = group(name);
    const value: FixtureLine = {
      id: `l${made}`, line_hash_id: `lh_${made.toString().padStart(4, "0")}`, line_uuid: uuid(made + 1),
      node_id: target.node_id, core: "sing-box", source: "discovery", managed: false,
      user_count: 1, user_known: true, status: "ok", listen_host: "::",
      service_state: "unknown", service_checked_at: "2026-09-02T04:39:11Z",
      service_note: "refused sing-box candidate /etc/sing-box/bin/sing-box (pid 3917185): outside the trusted executable directories (/bin, /sbin, /usr/bin, /usr/sbin, /usr/local/bin, /usr/local/sbin); owned by uid 1001, not root",
      ...line,
    };
    target.lines.push(value);
    made += 1;
    return value;
  };
  const exitLine = (node: string, name: string, type: string, port: number, host: string) => push(node, {
    name, type, listen_port: port, public_host: host, domain: type === "vless" ? "www.cloudflare.com" : "", outbound_ref: "direct",
  });

  // Exits first so their hashes exist when the hubs point at them.
  const exitHash = new Map<string, string>();
  for (const exit of HUB_EXITS) {
    const vless = exitLine(exit.node, `VLESS-REALITY-${exit.ports[0]}.json`, "vless", exit.ports[0], exit.host);
    exitHash.set(`${exit.node}:vless`, vless.line_hash_id);
    if (exit.ports[1]) {
      const hy2 = exitLine(exit.node, `Hysteria2-${exit.ports[1]}.json`, "hysteria2", exit.ports[1], exit.host);
      exitHash.set(`${exit.node}:hy2`, hy2.line_hash_id);
    }
  }
  const cdHash = new Map<string, string>();
  for (const exit of CD_EXITS) {
    for (const [name, type, port] of exit.lines) {
      const line = exitLine(exit.node, name, type, port, `${exit.node.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.roobli.invalid`);
      cdHash.set(`${exit.node}:${port}`, line.line_hash_id);
    }
  }

  // The bank: twelve relays per hub, two per exit (vless then hy2), one for a NAT exit.
  for (const hub of HUBS) {
    const host = `${hub.node.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.dmit.invalid`;
    for (const protocol of hub.trojan ? ["vless", "trojan"] : ["vless"]) {
      let port = protocol === "vless" ? 31001 : 41001;
      for (const exit of HUB_EXITS) {
        const slots: Array<["vless" | "hy2", number]> = exit.ports[1] ? [["vless", exit.ports[0]], ["hy2", exit.ports[1]]] : [["vless", exit.ports[0]]];
        for (const [slot, targetPort] of slots) {
          const short = exit.node.replace("[Metix]-", "").toLowerCase().replace(/-vds$|-nat$/, (m) => m);
          push(hub.node, {
            name: `${protocol === "vless" ? "VLESS-REALITY" : "Trojan"}-${port}.json`, type: protocol, listen_port: port, public_host: host,
            domain: protocol === "vless" ? "www.cloudflare.com" : "",
            outbound_ref: `[openjobs]-${short}-${slot}`, outbound_server: exit.host, outbound_port: targetPort,
            jump_edges: [exitHash.get(`${exit.node}:${slot}`)!],
          });
          port += 1;
        }
      }
    }
    for (const [name, type, port] of hub.own) exitLine(hub.node, name, type, port, host);
  }

  // The [cd] side: eb-wee relays once, mkcloud fans out four ways, one of them onto eb-wee.
  const ebWee = "[cd]-DMIT-eb-wee";
  exitLine(ebWee, "VLESS-REALITY-17891.json", "vless", 17891, "eb-wee.dmit.roobli.invalid");
  exitLine(ebWee, "Hysteria2-17892.json", "hysteria2", 17892, "eb-wee.dmit.roobli.invalid");
  const ebWeeRelay = push(ebWee, {
    name: "VLESS-REALITY-17893.json", type: "vless", listen_port: 17893, public_host: "eb-wee.dmit.roobli.invalid", domain: "www.cloudflare.com",
    outbound_ref: "out-to-aaitr-frontier-nat-vless-7899", outbound_server: "nat-us-28tz.aproxy.top", outbound_port: 25499,
    jump_edges: [cdHash.get("[cd]-Aaitr-Frontier-NAT:7899")!],
  });
  const mkcloud = "[cd]-mkcloud-hr-iplc";
  exitLine(mkcloud, "VLESS-REALITY-17890.json", "vless", 17890, "hr.mkcloud.roobli.invalid");
  const fan: Array<[string, string, string, number, string]> = [
    ["VLESS-REALITY-17891.json", "forward-to-xuezhang-jp-nat-vless", "jp.nat.xuezhang.roobli.invalid", 50100, cdHash.get("[cd]-xuezhang-jp-NAT:488")!],
    ["VLESS-REALITY-17893.json", "[cdcd]-aaitr-frontier-nat-HOME_vless", "eb-wee.dmit.roobli.invalid", 17893, ebWeeRelay.line_hash_id],
    ["VLESS-REALITY-17897.json", "[cdcd]-xuezhang-ca-nat-HOME_vless", "ca.nat.xuezhang.roobli.invalid", 50981, cdHash.get("[cd]-xuezhang-ca-NAT:50981")!],
    ["VLESS-REALITY-17898.json", "[cdcd]-aaitr-ATT-vds-HOME_vless", "att.aaitr.roobli.invalid", 57289, cdHash.get("[cd]-Aaitr-ATT-VDS:57289")!],
  ];
  fan.forEach(([name, ref, server, port, hash], index) => push(mkcloud, {
    name, type: "vless", listen_port: 17891 + index * 2, public_host: "hr.mkcloud.roobli.invalid", domain: "www.cloudflare.com",
    outbound_ref: ref, outbound_server: server, outbound_port: port, jump_edges: [hash],
  }));

  // One inbound with no outbound at all: the orphan production carries today.
  const stray = groups.get(group("[Metix]-gomami-jp-pulse-mini").node_id)!.lines.find((line) => line.name === "VLESS-REALITY-52971.json")!;
  stray.outbound_ref = "";

  return [...groups.values()];
}

function buildChains(scenario: Scenario) {
  if (!isRich(scenario)) return [];
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
    managed: isRich(scenario) && index % 4 === 0,
    core: "sing-box",
    core_version: "1.12.4",
    config_path: `/etc/sing-box/config.json`,
    stats_api: index % 3 === 0 ? "127.0.0.1:8080" : undefined,
    applied: isRich(scenario) && index % 8 === 0,
    last_error: isRich(scenario) && index === 5 ? "sb: exit status 1: config check failed at inbounds[3]" : undefined,
    inbound_count: 5 + (index % 3),
    discovered_count: 5 + (index % 3),
    discovery_status: "ok",
    collector: index % 3 === 0 ? { source: "singbox_stats_api", status: "ok" } : { status: "not configured" },
    capabilities: ["discover", "apply"],
  }));
}

function buildUsage(scenario: Scenario) {
  if (scenario === "offfleet") {
    // A fleet whose collectors report node totals only: usage exists, and no
    // byte of it can be placed on a line.
    return {
      per_line: false,
      by_user: USERS.filter((user) => user.enabled).map((user, index) => ({
        user_id: user.id, email: user.email, used_bytes: (index + 1) * 12 * 1024 ** 3, status: "active",
      })),
      by_node: NODE_NAMES.slice(0, 3).map((name, index) => ({
        node_id: `node-${name}`, node_name: name, used_bytes: (index + 1) * 9 * 1024 ** 3, user_count: 2,
      })),
      rows: NODE_NAMES.slice(0, 3).flatMap((name, index) => USERS.filter((user) => user.enabled).map((user) => ({
        node_id: `node-${name}`, node_name: name, user_id: user.id, email: user.email,
        bytes: (index + 1) * 4 * 1024 ** 3,
      }))),
      collectors: NODE_NAMES.slice(0, 3).map((name) => ({
        node_id: `node-${name}`, node_name: name, source: "usage_file", status: "ok", checked_at: "2026-08-18T09:00:00Z",
      })),
    };
  }
  if (!isRich(scenario)) return { by_user: [], by_node: [], rows: [], collectors: [], per_line: false };
  return {
    per_line: true,
    // Per-(node, user, line) rows, plus two nodes still on an aggregate-only
    // collector so the partial-attribution notice has something to report.
    rows: [
      ...NODE_NAMES.slice(0, 5).flatMap((name, index) => [0, 1, 2].flatMap((slot) => USERS
        .filter((user) => user.enabled)
        .map((user, seat) => ({
          node_id: `node-${name}`, node_name: name, user_id: user.id, email: user.email,
          line_hash_id: `lh_${(index * 6 + slot).toString().padStart(4, "0")}`,
          bytes: (slot + 1) * (seat + 1) * 7 * 1024 ** 3,
        })))),
      ...NODE_NAMES.slice(5, 7).map((name, index) => ({
        node_id: `node-${name}`, node_name: name, user_id: "u_ops", email: "ops@example.invalid",
        bytes: (index + 1) * 31 * 1024 ** 3,
      })),
    ],
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

/**
 * The attributed per-line rows the Usage screen renders.
 *
 * This deliberately covers every branch the server can produce, because the
 * screen's whole job is telling them apart: a named user, a credential match,
 * a lone binding, a lone Sub-Store record, a relayed portion already counted
 * upstream, an estimate, a set of candidates the server would not choose
 * between, and an inbound tag that matches no line at all. The long email and
 * the 64-character hash are here so the layout is tested against real widths
 * rather than three-word labels.
 */
function buildUsageLines(scenario: Scenario, period: string): UsageLineRow[] {
  if (scenario === "production" || scenario === "empty") return [];

  const GiB = 1024 ** 3;
  // A short window shows less traffic, the way a real one does.
  const scale = period === "today" ? 0.05 : period === "7d" ? 0.3 : period === "all" ? 1.8 : 1;
  const bytes = (value: number) => Math.round(value * GiB * scale);

  if (scenario === "offfleet") {
    // Collectors report node totals only: nothing can be placed on a line.
    return NODE_NAMES.slice(0, 3).map((name, index) => ({
      node_id: `node-${name}`, node_name: name,
      tag: `inbound-${index}`, role: "direct",
      uplink: bytes(4), downlink: bytes(8), used_bytes: bytes(12),
      attribution: "none",
      attribution_reason: "line usage, no user",
      candidates: ["u_ops", "u_lab"],
      counted: false,
    }));
  }

  return [
    {
      node_id: "node-hkg-edge-01", node_name: "hkg-edge-01", line_hash_id: "lh_0000",
      tag: "vless-in-443", role: "entry",
      uplink: bytes(31), downlink: bytes(88), used_bytes: bytes(119),
      attribution: "named", attribution_proof: "proof",
      attribution_reason: "user counter on this line folds to this identity",
      user_id: "u_ops", email: "ops@example.invalid", counted: true,
    },
    {
      node_id: "node-hkg-edge-01", node_name: "hkg-edge-01", line_hash_id: "lh_0001",
      tag: "trojan-in-8443", role: "direct",
      uplink: bytes(12), downlink: bytes(40), used_bytes: bytes(52),
      attribution: "credential", attribution_proof: "proof",
      attribution_reason: "inbound trojan password is this user's credential",
      user_id: "u_lab", email: "lab@example.invalid", counted: true,
    },
    {
      node_id: "node-sin-edge-01", node_name: "sin-edge-01", line_hash_id: "lh_0002",
      tag: "vless-in-2053", role: "direct",
      uplink: bytes(7), downlink: bytes(19), used_bytes: bytes(26),
      attribution: "binding", attribution_proof: "inferred",
      attribution_reason: "only enabled binding on this line",
      user_id: "u_lab", email: "lab@example.invalid", counted: true,
    },
    {
      node_id: "node-sin-edge-02", node_name: "sin-edge-02", line_hash_id: "lh_0003",
      tag: "hysteria2-in", role: "direct",
      uplink: bytes(3), downlink: bytes(9), used_bytes: bytes(12),
      attribution: "substore", attribution_proof: "inferred",
      attribution_reason: "only Sub-Store record selecting this line (rec_7f31c9)",
      user_id: "u_retired",
      email: "retired-contractor-with-a-very-long-address@example.invalid",
      counted: false,
    },
    // The chain: the exit carries bytes the entry counter already holds.
    {
      node_id: "node-lax-exit-01", node_name: "lax-exit-01", line_hash_id: "lh_0004",
      tag: "vless-relay-31001", role: "exit",
      uplink: bytes(30), downlink: bytes(85), used_bytes: bytes(115),
      attribution: "none",
      attribution_reason: "reached through a relay; counted at the entry line",
      counted_at: "lh_0000", counted: false,
    },
    // The same exit's own direct users, as a subtraction rather than a counter.
    {
      node_id: "node-lax-exit-01", node_name: "lax-exit-01", line_hash_id: "lh_0004",
      tag: "vless-relay-31001", role: "shared",
      uplink: bytes(2), downlink: bytes(6), used_bytes: bytes(8),
      attribution: "credential", attribution_proof: "proof",
      attribution_reason: "inbound vless uuid is this user's credential",
      user_id: "u_ops", email: "ops@example.invalid",
      estimate: true, counted: true,
    },
    // Real traffic the server refused to guess an owner for.
    {
      node_id: "node-fra-exit-01", node_name: "fra-exit-01", line_hash_id: "lh_0005",
      tag: "vless-in-443", role: "direct",
      uplink: bytes(9), downlink: bytes(27), used_bytes: bytes(36),
      attribution: "none",
      attribution_reason: "inbound bytes beyond the named user counters",
      candidates: ["u_ops", "u_lab"], counted: false,
    },
    // A counter for an inbound tag no line on the node carries.
    {
      node_id: "node-fra-exit-02", node_name: "fra-exit-02",
      tag: "legacy-shadowsocks-inbound-that-nothing-declares", role: "direct",
      uplink: bytes(1), downlink: bytes(4), used_bytes: bytes(5),
      attribution: "unknown_line",
      attribution_reason: "no line on this node carries this inbound tag",
      counted: false,
    },
    {
      node_id: "node-ams-exit-01", node_name: "ams-exit-01",
      line_hash_id: "lh_9f2c4b7e1a6d3058c4e9b2f7a1d6035849c2e7b1f4a9d6c3082e5b7f1a4d6c30",
      tag: "vless-in-443", role: "direct",
      uplink: bytes(5), downlink: bytes(14), used_bytes: bytes(19),
      attribution: "named", attribution_proof: "proof",
      attribution_reason: "user counter on this line folds to this identity",
      user_id: "u_ops", email: "ops@example.invalid", counted: true,
    },
  ];
}

/** Allocated nodes for a user, including one whose collector never reported. */
function allocatedNodes(userID: string) {
  const GiB = 1024 ** 3;
  if (userID === "u_ops") {
    return [
      {
        node_id: "node-hkg-edge-01", node_name: "hkg-edge-01", collector_state: "ok",
        lines: [{
          line_hash_id: "lh_0000", tag: "vless-in-443", role: "entry", allocation: "binding",
          period_uplink: 31 * GiB, period_downlink: 88 * GiB,
          last_seen_at: "2026-09-02T09:14:00Z", counted: true,
        }],
      },
      {
        node_id: "node-lax-exit-01", node_name: "lax-exit-01", collector_state: "ok",
        lines: [{
          line_hash_id: "lh_0004", tag: "vless-relay-31001", role: "exit", allocation: "relay",
          period_uplink: 0, period_downlink: 0, counted: false, via_relay: true,
        }],
      },
      {
        node_id: "node-syd-relay-01", node_name: "syd-relay-01", collector_state: "no_collector",
        lines: [{
          line_hash_id: "lh_0007", tag: "vless-in-443", role: "direct", allocation: "binding",
          period_uplink: 0, period_downlink: 0, counted: false,
        }],
      },
    ];
  }
  if (userID === "u_lab") {
    return [
      {
        node_id: "node-sin-edge-01", node_name: "sin-edge-01", collector_state: "ok",
        lines: [{
          line_hash_id: "lh_0002", tag: "vless-in-2053", role: "direct", allocation: "binding",
          period_uplink: 7 * GiB, period_downlink: 19 * GiB,
          last_seen_at: "2026-09-02T08:02:00Z", counted: true,
        }],
      },
      {
        node_id: "node-nrt-edge-02", node_name: "nrt-edge-02", collector_state: "error",
        lines: [{
          line_hash_id: "lh_0008", tag: "trojan-in-8443", role: "direct", allocation: "substore",
          period_uplink: 0, period_downlink: 0, counted: false,
        }],
      },
    ];
  }
  return [];
}

/** The users list with the server's usage read model attached. */
function usersWithUsage(scenario: Scenario) {
  if (!isRich(scenario)) return USERS;
  const GiB = 1024 ** 3;
  const period: Record<string, { used: number; total: number; seen?: string }> = {
    u_ops: { used: 127 * GiB, total: 1_408 * GiB, seen: "2026-09-02T09:14:00Z" },
    u_lab: { used: 481 * GiB, total: 902 * GiB, seen: "2026-09-02T08:02:00Z" },
    u_retired: { used: 0, total: 44 * GiB },
  };
  return USERS.map((user) => ({
    ...user,
    quota_period: user.id === "u_lab" ? "monthly" : "",
    quota_reset_day: user.id === "u_lab" ? 1 : 0,
    used_total_bytes: period[user.id]?.total ?? 0,
    used_period_bytes: period[user.id]?.used ?? 0,
    period_start: user.id === "u_lab" ? "2026-09-01T00:00:00Z" : undefined,
    period_end: user.id === "u_lab" ? "2026-09-30T23:59:59Z" : undefined,
    last_7d: [3, 9, 14, 0, 22, 18, 11].map((value) => value * GiB),
    last_seen_at: period[user.id]?.seen,
    allocated_nodes: allocatedNodes(user.id),
  }));
}

export function handlers(scenario: Scenario, content: ContentShape = "plain"): Record<string, (payload: any) => unknown> {
  const table = buildHandlers(scenario);
  if (content !== "hostile") return table;
  /* One shared `seen` map across every endpoint, so a node rewritten in
   * lines/list reads the same in usage/summary. Per-call maps would give the
   * same row two different names on two screens, which is a harness bug that
   * looks exactly like the product bug this fixture exists to find. */
  const seen = new Map<string, number>();
  const hits = new Map<string, number>();
  return Object.fromEntries(
    Object.entries(table).map(([route, fn]) => [route, (payload: any) => harden(fn(payload), seen, hits)]),
  );
}

function buildHandlers(scenario: Scenario): Record<string, (payload: any) => unknown> {
  const groups = scenario === "hubs" ? buildHubFleet() : buildLines(scenario);
  const chains = buildChains(scenario);
  const flat = groups.flatMap((group) => group.lines);
  return {
    "lines/list": () => ({ groups }),
    "lines/chains": () => ({ chains }),
    "lines/managed": () => ({
      managed_lines: isRich(scenario)
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
    "users/list": () => ({ users: usersWithUsage(scenario) }),
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
    "usage/query": ({ period }: { period?: string }) => {
      const window = period || "30d";
      const lines = buildUsageLines(scenario, window);
      // The chain overlap is exactly the relayed row's bytes: the exit reports
      // them and the entry already counted them.
      const doubleCounted = lines
        .filter((row) => (row.counted_at ?? "") !== "")
        .reduce((sum, row) => sum + row.used_bytes, 0);
      const day = ({ today: ["20260902", "20260902"], "7d": ["20260827", "20260902"], all: ["20250728", "20260902"] } as Record<string, string[]>)[window]
        ?? ["20260804", "20260902"];
      return {
        ...buildUsage(scenario),
        lines,
        double_counted_via_chains_bytes: doubleCounted,
        period: window,
        from: day[0],
        to: day[1],
      };
    },
    "users-admin/usage_query": ({ user_id, node_id, line_hash_id, period }: Record<string, string>) => {
      const key = user_id ? "user_id" : node_id ? "node_id" : "line_hash_id";
      const lines = buildUsageLines(scenario, period || "30d")
        .filter((row) => (user_id ? row.user_id === user_id : node_id ? row.node_id === node_id : row.line_hash_id === line_hash_id));
      const used = lines.reduce((sum, row) => sum + row.used_bytes, 0);
      return {
        scope: { [key]: user_id || node_id || line_hash_id },
        period: period || "30d", from: "20260804", to: "20260902",
        uplink: lines.reduce((sum, row) => sum + row.uplink, 0),
        downlink: lines.reduce((sum, row) => sum + row.downlink, 0),
        used_bytes: used,
        days: [{ day: "20260902", uplink: 1, downlink: 2, used_bytes: 3 }],
        lines,
        double_counted_via_chains_bytes: 0,
      };
    },
  };
}

/* ---------------------------------------------------------------------------
 * Content shape, orthogonal to the seven scenarios above.
 *
 * Every value of `Scenario` is a topology: how the fleet is wired and which
 * edges the control plane can see. None of them says anything about the shape
 * of the strings the server returns, and that is the axis every defect in the
 * usage-screen review came from. A server enum this build has not learned, an
 * unbreakable token in a collector error, node names distinguished only by a
 * trailing suffix, and identifiers that share a prefix because they are
 * time-ordered: none depends on how the fleet is wired, and none of the seven
 * scenarios can express any of them. Four rounds of careful work kept shipping
 * and kept being broken by the next fixture for exactly that reason.
 *
 * So this is a modifier rather than an eighth scenario. Adding it to that enum
 * would put a content shape in a list that means topology, and the next reader
 * would take it for one. `hostile` composes with any topology.
 *
 * It rewrites display strings only. Structure, counts, ids used as keys and
 * every number are untouched, so a topology renders the same shape of screen
 * either way and only the text is adversarial.
 * ------------------------------------------------------------------------- */

export type ContentShape = "plain" | "hostile";

/* Values chosen because each one broke something real, not because each one is
 * long. Length alone is the easy case and the caps already handle it. */
const HOSTILE = {
  /* Sibling nodes named from one template, differing only past the cut. */
  name: (i: number) =>
    `${["frankfurt-equinix-fr5", "amsterdam-equinix-am7", "singapore-equinix-sg3"][i % 3]}` +
    `-transit-egress-cluster-node-${String((i % 9) + 1).padStart(2, "0")}-` +
    (i % 2 ? "secondary" : "primary"),
  /* ULIDs are lexicographically time-ordered, so ids minted seconds apart
   * share a long prefix and differ in the tail. End truncation removes
   * precisely the distinguishing part. */
  ulid: (i: number) =>
    `nd_01J8ZQK4X9F7M2P5R8T1V4W7Y0B3D6G9J2L5N8Q1S4U7X0Z3C6F9H2K5M8P1R4` +
    `${String.fromCharCode(65 + (i % 26))}${i % 10}`,
  /* Generated paths have the same property for the same reason. */
  path: (i: number) =>
    `/var/lib/lattice/managed/sing-box/generated/production/cluster-am7/` +
    `node-${String((i % 9) + 1).padStart(2, "0")}/config.observed.json`,
  /* An identity that outgrows any cap a cell can be given. */
  identity: (i: number) =>
    `network.operations.oncall.${String(i).padStart(2, "0")}.${i % 2 ? "secondary" : "primary"}` +
    `@subsidiary-holdings.example.invalid`,
  /* A realistic resolver failure whose hostname has no break opportunity: no
   * space, no hyphen, no dot inside the label. The surrounding message wraps
   * at its spaces, so what has to overflow is the label alone.
   *
   * Its length is load-bearing and was measured, not chosen for looks. At the
   * 2xs size this renders at, the shorter form of this name wanted 325px in a
   * 342px collector grid, so it fit with 17px to spare and the fixture stopped
   * detecting the defect it was built for. A hostile value that fits is not
   * hostile, it is a green run that proves nothing. Sized against the
   * container it has to break, with margin, and re-verified after. */
  unbreakable: () =>
    "dial tcp: lookup collector_internal_am7_transit_egress_cluster_secondary_endpoint_observed " +
    "on 10.0.0.1:53: no such host",
  /* A value this build has not learned. Label helpers echo an unrecognised
   * server enum verbatim, so the widest string a cell can hold is not bounded
   * by anything this repo knows about. */
  enum: (i: number) =>
    (i % 2
      ? "reality_sni_fallback_via_upstream_relay_chain_unverified"
      : "multi_hop_relay_with_reality_fallback_egress"),
};

/* Rewritten by field name rather than by path, so a fixture growing a new row
 * is covered without touching this. Field names were read out of the fixtures
 * rather than guessed: an identity is `email`, not `name` (`name` is a display
 * label like "Operations"), and a collector failure is `error` on the usage
 * rows and `last_error` on profiles. My first attempt guessed and rewrote only
 * the node names, which rendering it immediately showed. */
const HOSTILE_FIELDS: Record<string, (i: number) => string> = {
  node_name: HOSTILE.name,
  tag: HOSTILE.name,
  email: HOSTILE.identity,
  line_hash_id: HOSTILE.ulid,
  downstream_line_uuid: HOSTILE.ulid,
  config_path: HOSTILE.path,
  outbound_ref: HOSTILE.path,
  last_error: HOSTILE.unbreakable,
  error: HOSTILE.unbreakable,
  discovery_error: HOSTILE.unbreakable,
  attribution_reason: HOSTILE.enum,
};

/* Enums are handled separately and deliberately sparingly. An unrecognised
 * enum was a real defect, because the label helpers echo a value this build
 * has not learned verbatim and nothing bounds its width. But these fields
 * drive rendering branches rather than only text, so rewriting every row would
 * change the topology's meaning: every collector would read as broken and the
 * scenario would no longer be the scenario. Only the first occurrence of each
 * is replaced, which puts one unknown value beside known ones, which is also
 * the shape the real bug arrived in. */
const HOSTILE_ENUMS = new Set(["role", "collector_state", "status", "collector_status"]);

/* Identity fields keep a stable rewrite per original value, so the same node
 * reads the same everywhere it appears and a reader can still follow one row
 * across two tables. A fresh counter per field would break that. */
export function harden<T>(value: T, seen = new Map<string, number>(), hits = new Map<string, number>()): T {
  if (Array.isArray(value)) return value.map((item) => harden(item, seen, hits)) as unknown as T;
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string" && item !== "" && HOSTILE_ENUMS.has(key)) {
      const n = hits.get(key) ?? 0;
      hits.set(key, n + 1);
      out[key] = n === 0 ? HOSTILE.enum(hits.size) : item;
      continue;
    }
    const rewrite = HOSTILE_FIELDS[key];
    if (rewrite && typeof item === "string" && item !== "") {
      const memo = `${key}:${item}`;
      if (!seen.has(memo)) seen.set(memo, seen.size);
      out[key] = rewrite(seen.get(memo)!);
    } else {
      out[key] = harden(item, seen, hits);
    }
  }
  return out as T;
}
