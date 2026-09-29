/**
 * Canned answers shaped like the wire, for looking at the plugin in a browser.
 *
 * The default scenario is the fleet the owner actually has, read on
 * 2026-09-29: 136 lines on 24 nodes, 101 relay and 34 exit, nothing
 * Lattice-managed, every line running, and a week of usage in which 313 GiB
 * left the fleet. "dense" is that fleet with a second relay region, every
 * line state and real attribution on top, "legacy" is production answered by
 * a server that predates the usage `series` and `previous` fields, and the
 * older scenarios below keep the shapes earlier screens were judged against.
 * Anything the harness cannot answer throws, because a mock that quietly
 * returns undefined teaches the UI to tolerate nonsense.
 *
 * Outbounds and jump_edges are kept internally consistent per scenario, which
 * an earlier revision of this file was not. The server derives jump_edges from
 * each line's own outbound (host, port) against a fleet-wide listen index, so
 * a fixture cannot both point its outbounds at fleet endpoints and report no
 * edges: that combination cannot come off the wire. "offfleet" relays through
 * upstreams the control plane does not own, and "rich" carries the handful of
 * edges the server would compute for a fleet with synthetic hub/exit structure.
 *
 * Never imported by src/; the shipped bundle is built from index.html alone.
 */

import type { UsageSeries, UsagePrevious } from "../src/trafficModel";
import type { UsageLineRow } from "../src/usageModel";

export type Scenario = "production" | "dense" | "legacy" | "hubs" | "offfleet" | "rich" | "empty" | "failing";
export const SCENARIOS: readonly Scenario[] = ["production", "dense", "legacy", "hubs", "offfleet", "rich", "empty", "failing"];

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

/** The synthetic fleet with managed lines, chains and failing states. */
const isRich = (scenario: Scenario) => scenario === "rich";
/** Scenarios built on the 2026-09-29 production read. */
const isProductionShape = (scenario: Scenario) => scenario === "production" || scenario === "dense" || scenario === "legacy";

/**
 * What a line's outbound looks like, and therefore whether an edge can exist.
 *
 * offfleet:   three quarters relay through vendor endpoints Lattice cannot see.
 * rich:       a few hubs relay onto fleet endpoints and carry the resolved edge.
 */
function outboundShape(scenario: Scenario, made: number, index: number): Partial<FixtureLine> {
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

/** 111 lines over 21 synthetic nodes, the fleet's size in August. */
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

type FleetGroup = { node_id: string; node_name: string; lines: FixtureLine[] };

interface RelayFleetOptions {
  /** What the liveness probe says: the refusal of 2026-09-02, or running once the binaries moved. */
  liveness: "refused" | "running";
  /** Nodes the fleet no longer carries. */
  drop?: readonly string[];
  /** A second relay region, every line state, a few managed lines and one off-fleet relay. */
  dense?: boolean;
}

const nodeKey = (name: string) => `node-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;

/** The second region "dense" adds: four hubs, each a bank of ten relays onto ten exits. */
const LAB_EXITS = [
  "[Lab]-Hetzner-Falkenstein-FSN1-DC14-dedicated-AX41", "[Lab]-exit-waw-oktawave", "[Lab]-exit-ams-leaseweb",
  "[Lab]-exit-lax-quadranet", "[Lab]-exit-sea-ovh", "[Lab]-exit-sjc-vultr", "[Lab]-exit-ord-hivelocity",
  "[Lab]-exit-mia-zenlayer", "[Lab]-exit-gru-latitude", "[Lab]-exit-jnb-teraco",
];
const LAB_HUBS = ["[Lab]-hub-hkg-equinix-hk2", "[Lab]-hub-tyo-sakura-ishikari", "[Lab]-hub-sin-digitalocean-sgp1", "[Lab]-hub-fra-anexia"];

function buildRelayFleet(options: RelayFleetOptions): FleetGroup[] {
  const groups = new Map<string, FleetGroup>();
  const dropped = new Set(options.drop ?? []);
  let made = 0;
  const group = (name: string) => {
    const id = nodeKey(name);
    return groups.get(id) ?? groups.set(id, { node_id: id, node_name: name, lines: [] }).get(id)!;
  };
  const liveness: Partial<FixtureLine> = options.liveness === "running"
    ? { service_state: "running", service_checked_at: "2026-09-29T07:58:12Z" }
    : {
        service_state: "unknown", service_checked_at: "2026-09-02T04:39:11Z",
        service_note: "refused sing-box candidate /etc/sing-box/bin/sing-box (pid 3917185): outside the trusted executable directories (/bin, /sbin, /usr/bin, /usr/sbin, /usr/local/bin, /usr/local/sbin); owned by uid 1001, not root",
      };
  const push = (name: string, line: Omit<FixtureLine, "id" | "line_hash_id" | "line_uuid" | "node_id" | "core" | "source" | "managed" | "user_count" | "user_known" | "status">): FixtureLine => {
    const target = group(name);
    const value: FixtureLine = {
      id: `l${made}`, line_hash_id: `lh_${made.toString().padStart(4, "0")}`, line_uuid: uuid(made + 1),
      node_id: target.node_id, core: "sing-box", source: "discovery", managed: false,
      user_count: 1, user_known: true, status: "ok", listen_host: "::",
      ...liveness,
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
    if (dropped.has(exit.node)) continue;
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
          const short = exit.node.replace("[Metix]-", "").toLowerCase();
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
  const stray = group("[Metix]-gomami-jp-pulse-mini").lines.find((line) => line.name === "VLESS-REALITY-52971.json")!;
  stray.outbound_ref = "";

  if (options.dense) {
    const labHash: string[] = [];
    LAB_EXITS.forEach((node, index) => {
      const line = exitLine(node, "VLESS-REALITY-443.json", "vless", 443, `lab-exit-${index + 1}.lab.invalid`);
      labHash.push(line.line_hash_id);
    });
    LAB_HUBS.forEach((hub, hubIndex) => {
      const host = `lab-hub-${hubIndex + 1}.lab.invalid`;
      LAB_EXITS.forEach((exit, index) => push(hub, {
        name: `VLESS-REALITY-${51001 + index}.json`, type: "vless", listen_port: 51001 + index, public_host: host, domain: "www.microsoft.com",
        outbound_ref: `lab-${exit.replace("[Lab]-", "").toLowerCase()}`, outbound_server: `lab-exit-${index + 1}.lab.invalid`, outbound_port: 443,
        jump_edges: [labHash[index]],
      }));
      const own = exitLine(hub, "lattice-mng-24443", "vless", 24443, host);
      if (hubIndex < 3) {
        Object.assign(own, {
          managed: true, source: "managed", overlay: true, overlay_status: "applied", overlay_user: "ops@example.invalid",
          user_count: 3, security: "reality", transport: "tcp",
          metadata: { lattice_line_uuid: own.line_uuid!, tag: "lattice-mng-24443" },
        });
      }
    });
    // One relay onto a vendor endpoint nothing on the fleet owns.
    push(LAB_HUBS[3], {
      name: "VLESS-REALITY-51099.json", type: "vless", listen_port: 51099, public_host: "lab-hub-4.lab.invalid", domain: "www.microsoft.com",
      outbound_ref: "vendor-transit-3", outbound_server: "edge-3.vendor-transit.example.invalid", outbound_port: 443,
    });
    // Every line state the table has to tell apart.
    const find = (node: string, name: string) => group(node).lines.find((line) => line.name === name)!;
    Object.assign(find("[Metix]-DMIT-2", "VLESS-REALITY-31004.json"), { status: "error", last_error: "listen tcp [::]:31004: bind: address already in use" });
    Object.assign(find("[Metix]-VIRCS-ATT-VDS", "Hysteria2-34657.json"), { service_state: "down" });
    Object.assign(find("[Metix]-qqpw-cd2-VDS", "VLESS-REALITY-53591.json"), { service_state: "restarting" });
    Object.assign(find(LAB_EXITS[6], "VLESS-REALITY-443.json"), { status: "pending" });
    Object.assign(find(LAB_HUBS[1], "VLESS-REALITY-51003.json"), { user_known: false });
  }

  return [...groups.values()];
}

/** The fleet as it stood on 2026-09-02, liveness refused on every node. */
function buildHubFleet(): FleetGroup[] {
  return buildRelayFleet({ liveness: "refused" });
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

/* ── production, dense and legacy ──────────────────────────────────────────
 * The 2026-09-29 read. Egress per node over seven days is the production
 * figure (VIRCS-ATT 97.6, Aaitr-Frontier-VDS 55.0 and so on, in the unit the
 * console prints); entry bytes on the relay hubs are that same traffic
 * counted again at the hub, so they are derived from the exit they dial
 * rather than invented separately. Every total below comes out of these
 * tables, and the daily series is those totals spread over the days, so the
 * two agree on egress to the byte, as the wire contract requires. */

const GiB = 1024 ** 3;

/** The fleet as the server lists it on 2026-09-29: 24 nodes, 136 lines. */
function buildProductionFleet(scenario: Scenario): FleetGroup[] {
  return buildRelayFleet({ liveness: "running", drop: ["[cd]-LegendVPS-SG-EVO"], dense: scenario === "dense" });
}

/** Seven-day egress per exit-role node. Sums to 271.6. */
const EXIT_7D: Record<string, number> = {
  "[Metix]-VIRCS-ATT-VDS": 97.6, "[Metix]-Aaitr-Frontier-VDS": 55.0, "[Metix]-Aaitr-ATT-VDS": 33.6,
  "[Metix]-qqpw-cd3-VDS": 33.5, "[Metix]-Aaitr-Frontier-NAT": 24.0, "[Metix]-qqpw-cd2-VDS": 14.1,
  "[Metix]-Aaitr-jp-softbank-NAT": 6.3, "[cd]-xuezhang-jp-NAT": 3.4, "[cd]-Aaitr-ATT-VDS": 2.1,
  "[cd]-xuezhang-ca-NAT": 1.8, "[cd]-Aaitr-Frontier-NAT": 0.2,
};
const LAB_EXIT_7D = [18, 12.5, 9, 7.2, 5.5, 4.1, 3.3, 2.4, 1.6, 0.9];

/** Seven-day bytes on lines that are in no chain. Sums to 41.4. */
const DIRECT_7D: Record<string, number> = {
  "[Metix]-DMIT-1|VLESS-REALITY-32426.json": 6.0,
  "[Metix]-DMIT-2|VLESS-REALITY-61346.json": 5.1,
  "[Metix]-DMIT-3|VLESS-REALITY-52714.json": 4.4,
  "[Metix]-DMIT-4|VLESS-REALITY-64768.json": 3.9,
  "[Metix]-gomami-hk-turin-mini|VLESS-REALITY-8468.json": 5.5,
  "[Metix]-gomami-hk-turin-mini|Trojan-8469.json": 2.2,
  "[Metix]-gomami-jp-pulse-mini|Trojan-52972.json": 1.6,
  "[cd]-huoshan-shanghai|VLESS-REALITY-34099.json": 4.8,
  "[cd]-gomami-jpn-pulse-nano|Hysteria2-13434.json": 1.2,
  "[cd]-gomami-jpn-pulse-nano|VLESS-REALITY-16051.json": 1.9,
  "[cd]-DMIT-pro-malibu|Hysteria2-17892.json": 0.9,
  "[cd]-DMIT-pro-malibu|VLESS-REALITY-17893.json": 1.6,
  "[cd]-qqpw-VDS-cd1|VLESS-REALITY-62255.json": 0.3,
  "[cd]-DMIT-eb-wee|VLESS-REALITY-17891.json": 0.6,
  "[cd]-DMIT-eb-wee|Hysteria2-17892.json": 0.3,
  "[cd]-mkcloud-hr-iplc|VLESS-REALITY-17890.json": 0.7,
  "[cd]-xuezhang-jp-NAT|Hysteria2-7890.json": 0.4,
};

/** Bytes on the middle hop of the one two-hop chain. */
const RELAY_7D = 0.2;
/** Entry bytes are this share of what the exits behind them moved: 255.3 of 271.6. */
const ENTRY_RATIO = 255.3 / 271.6;

/** How the hubs split the traffic onto one exit between them. */
const HUB_WEIGHT: Record<string, number> = {
  "[Metix]-gomami-hk-turin-mini": 0.34, "[Metix]-gomami-jp-pulse-mini": 0.22,
  "[Metix]-DMIT-1": 0.14, "[Metix]-DMIT-2": 0.12, "[Metix]-DMIT-3": 0.1, "[Metix]-DMIT-4": 0.08,
  "[Lab]-hub-hkg-equinix-hk2": 0.4, "[Lab]-hub-tyo-sakura-ishikari": 0.3,
  "[Lab]-hub-sin-digitalocean-sgp1": 0.2, "[Lab]-hub-fra-anexia": 0.1,
};

const PERIOD_SCALE: Record<string, number> = { today: 0.142, "7d": 1, "30d": 4.05, all: 7.6 };
const PERIOD_DAYS: Record<string, number> = { today: 1, "7d": 7, "30d": 30, all: 60 };
/** Egress in the window before, as a share of this one: +12% on the week. */
const PREVIOUS_RATIO: Record<string, number> = { today: 1 / 0.93, "7d": 1 / 1.12, "30d": 1 / 1.05 };

function dayList(count: number, end = "20260929"): string[] {
  const last = Date.UTC(Number(end.slice(0, 4)), Number(end.slice(4, 6)) - 1, Number(end.slice(6, 8)));
  const days: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(last - offset * 86_400_000);
    days.push(`${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`);
  }
  return days;
}

/** Split an integer total over weights, the last day taking the remainder. */
function spread(total: number, weights: number[]): number[] {
  const sum = weights.reduce((value, next) => value + next, 0) || 1;
  const values = weights.map((weight) => Math.floor((total * weight) / sum));
  values[values.length - 1] += total - values.reduce((value, next) => value + next, 0);
  return values;
}

function dayWeights(count: number, seed: number): number[] {
  return Array.from({ length: count }, (_, index) => {
    const weekend = (index + seed) % 7 === 5 || (index + seed) % 7 === 6 ? 0.12 : 0;
    return 1 + 0.16 * Math.sin((index + seed) * 0.9) + weekend + index * 0.004;
  });
}

type RoleName = "entry" | "relay" | "exit" | "direct";

function productionRoles(groups: FleetGroup[]): Map<string, RoleName | undefined> {
  const targeted = new Set<string>();
  for (const group of groups) for (const line of group.lines) for (const hash of line.jump_edges ?? []) targeted.add(hash);
  const roles = new Map<string, RoleName | undefined>();
  for (const group of groups) for (const line of group.lines) {
    const relays = !!line.jump_edges?.length || (!!line.outbound_server && (line.outbound_port ?? 0) > 0 && (line.outbound_ref ?? "") !== "direct");
    const hasOutbound = !!(line.outbound_ref ?? "").trim() || !!line.outbound_server;
    if (!hasOutbound) roles.set(line.line_hash_id, undefined);
    else if (relays) roles.set(line.line_hash_id, targeted.has(line.line_hash_id) ? "relay" : "entry");
    else roles.set(line.line_hash_id, targeted.has(line.line_hash_id) ? "exit" : "direct");
  }
  return roles;
}

/** Collectors that are not reporting in "dense": their nodes have no rows at all. */
const DENSE_SILENT: Record<string, { status: string; error: string }> = {
  "[Lab]-exit-jnb-teraco": { status: "error", error: "dial tcp 127.0.0.1:9090: connect: connection refused" },
  "[Lab]-hub-fra-anexia": { status: "stats_off", error: "the sing-box experimental API is not enabled on this node" },
};

interface ProductionUsage {
  lines: UsageLineRow[];
  series: UsageSeries;
  previous?: UsagePrevious;
  collectors: Array<{ node_id: string; node_name: string; source: string; status: string; error?: string; checked_at: string }>;
}

function productionUsage(groups: FleetGroup[], scenario: Scenario, period: string, users: Array<{ id: string; email: string }>): ProductionUsage {
  const scale = PERIOD_SCALE[period] ?? 1;
  const roles = productionRoles(groups);
  const nodeOf = new Map<string, FleetGroup>();
  const lineOf = new Map<string, FixtureLine>();
  for (const group of groups) for (const line of group.lines) {
    nodeOf.set(line.line_hash_id, group);
    lineOf.set(line.line_hash_id, line);
  }
  const silent = scenario === "dense" ? DENSE_SILENT : {};

  // Bytes on every line that is not an entry: exits by node, directs by line.
  const bytes = new Map<string, number>();
  for (const group of groups) {
    const exits = group.lines.filter((line) => roles.get(line.line_hash_id) === "exit");
    const labIndex = LAB_EXITS.indexOf(group.node_name);
    const nodeExit = EXIT_7D[group.node_name] ?? (labIndex >= 0 ? LAB_EXIT_7D[labIndex] : 0);
    const split = exits.length === 2 ? [0.7, 0.3] : exits.map(() => 1 / Math.max(1, exits.length));
    exits.forEach((line, index) => bytes.set(line.line_hash_id, nodeExit * split[index]));
    for (const line of group.lines) {
      const role = roles.get(line.line_hash_id);
      if (role === "direct") {
        const known = DIRECT_7D[`${group.node_name}|${line.name}`];
        bytes.set(line.line_hash_id, known ?? (group.node_name.startsWith("[Lab]") ? 1.1 : 0));
      }
      if (role === "relay") bytes.set(line.line_hash_id, RELAY_7D);
    }
  }
  // Entries: the traffic onto each target, split between the hubs that dial it.
  for (const [hash, total] of [...bytes]) {
    const sources = [...lineOf.values()].filter((line) => (line.jump_edges ?? []).includes(hash));
    if (!sources.length) continue;
    const weight = (line: FixtureLine) => {
      const hub = nodeOf.get(line.line_hash_id)!;
      const protocol = hub.lines.some((value) => value.type === "trojan" && value.jump_edges?.length) ? (line.type === "trojan" ? 0.3 : 0.7) : 1;
      return (HUB_WEIGHT[hub.node_name] ?? 1) * protocol;
    };
    const sum = sources.reduce((value, line) => value + weight(line), 0);
    for (const line of sources) {
      if (roles.get(line.line_hash_id) !== "entry") continue;
      bytes.set(line.line_hash_id, (bytes.get(line.line_hash_id) ?? 0) + (total * ENTRY_RATIO * weight(line)) / sum);
    }
  }

  const probeHash = groups.find((group) => group.node_name === "[cd]-qqpw-VDS-cd1")?.lines[0]?.line_hash_id;
  const malibu = new Set(groups.find((group) => group.node_name === "[cd]-DMIT-pro-malibu")?.lines.map((line) => line.line_hash_id) ?? []);
  const rows: UsageLineRow[] = [];
  let seat = 0;
  for (const group of groups) {
    if (silent[group.node_name]) continue;
    for (const line of group.lines) {
      const role = roles.get(line.line_hash_id);
      const amount = bytes.get(line.line_hash_id) ?? 0;
      if (!role || amount <= 0) continue;
      const used = Math.round(amount * scale * GiB);
      const uplink = Math.round(used * 0.18);
      const row: UsageLineRow = {
        node_id: group.node_id, node_name: group.node_name, line_hash_id: line.line_hash_id,
        tag: line.name.replace(/\.json$/, ""), role,
        uplink, downlink: used - uplink, used_bytes: used,
        attribution: "none", attribution_reason: "line usage, no user", counted: false,
      };
      if (line.line_hash_id === probeHash) {
        Object.assign(row, {
          attribution: "named", attribution_proof: "proof", attribution_reason: "user counter on this line folds to this identity",
          user_id: "u_probe", email: "probe@lattice.invalid", counted: true,
        });
      } else if (malibu.has(line.line_hash_id)) {
        Object.assign(row, {
          attribution: "substore", attribution_proof: "inferred", attribution_reason: "only Sub-Store record selecting this line (rec_5e21a0)",
          user_id: "u_cdcd", email: "cdcd@roobli.invalid", counted: false,
        });
      } else if (scenario === "dense") {
        // Real attribution on the second region and the DMIT banks, so the
        // By user layer has quotas to read and By line has every register.
        seat += 1;
        const user = users[seat % users.length];
        if (role === "entry") {
          Object.assign(row, { attribution: "named", attribution_proof: "proof", attribution_reason: "user counter on this line folds to this identity", user_id: user.id, email: user.email, counted: true });
        } else if (role === "exit") {
          const upstream = [...lineOf.values()].find((value) => (value.jump_edges ?? []).includes(line.line_hash_id));
          Object.assign(row, { attribution: "none", attribution_reason: "reached through a relay; counted at the entry line", counted_at: upstream?.line_hash_id });
        } else if (seat % 3 === 0) {
          Object.assign(row, { attribution: "credential", attribution_proof: "proof", attribution_reason: "inbound vless uuid is this user's credential", user_id: user.id, email: user.email, counted: true, estimate: seat % 2 === 0 });
        } else if (seat % 3 === 1) {
          Object.assign(row, { attribution: "none", attribution_reason: "inbound bytes beyond the named user counters", candidates: [users[0].id, users[1].id] });
        }
      }
      rows.push(row);
    }
  }
  if (scenario === "dense") {
    const node = groups.find((group) => group.node_name === "[Metix]-DMIT-3")!;
    const used = Math.round(0.8 * scale * GiB);
    rows.push({
      node_id: node.node_id, node_name: node.node_name, tag: "legacy-shadowsocks-inbound-that-nothing-declares", role: "direct",
      uplink: Math.round(used * 0.2), downlink: used - Math.round(used * 0.2), used_bytes: used,
      attribution: "unknown_line", attribution_reason: "no line on this node carries this inbound tag", counted: false,
    });
  }

  const days = dayList(PERIOD_DAYS[period] ?? 30);
  const byNodeRole = new Map<string, { node_id: string; node_name?: string; role: string; total: number }>();
  for (const row of rows) {
    const key = `${row.node_id} ${row.role}`;
    const entry = byNodeRole.get(key) ?? byNodeRole.set(key, { node_id: row.node_id, node_name: row.node_name, role: row.role, total: 0 }).get(key)!;
    entry.total += row.used_bytes;
  }
  const seeds = new Map(groups.map((group, index) => [group.node_id, index % 7]));
  const series: UsageSeries = {
    days,
    rows: [...byNodeRole.values()].map((entry) => ({
      node_id: entry.node_id, node_name: entry.node_name, role: entry.role,
      bytes: spread(entry.total, dayWeights(days.length, seeds.get(entry.node_id) ?? 0)),
    })),
    truncated: false,
  };
  const egress = rows.filter((row) => row.role === "exit" || row.role === "direct").reduce((sum, row) => sum + row.used_bytes, 0);
  const ratio = PREVIOUS_RATIO[period];
  const before = dayList(days.length * 2).slice(0, days.length);
  const previous = ratio ? { from: before[0], to: before[before.length - 1], egress_bytes: Math.round(egress * ratio) } : undefined;

  const collectors = [...groups, { node_id: nodeKey("[cd]-LegendVPS-SG-EVO"), node_name: "[cd]-LegendVPS-SG-EVO", lines: [] }].map((group) => ({
    node_id: group.node_id, node_name: group.node_name, source: "singbox_stats_api",
    status: silent[group.node_name]?.status ?? "ok", error: silent[group.node_name]?.error,
    checked_at: "2026-09-29T07:58:40Z",
  }));
  return { lines: rows, series, previous, collectors };
}

function productionUsers(scenario: Scenario, groups: FleetGroup[]) {
  const probeHash = groups.find((group) => group.node_name === "[cd]-qqpw-VDS-cd1")?.lines[0]?.line_hash_id ?? "";
  const base = [
    {
      id: "u_cdcd", email: "cdcd@roobli.invalid", name: "cdcd", enabled: true,
      credentials: [{ protocol: "vless", flow: "xtls-rprx-vision", has_secret: true }],
      bindings: [], quota_bytes: 0, group: "owner", migrated: true,
      created_at: "2026-05-02T09:12:00Z", updated_at: "2026-09-20T11:00:00Z",
    },
    {
      id: "u_openjobs", email: "shenzhen-office@openjobs.invalid", name: "OpenJobs Shenzhen", enabled: true,
      credentials: [{ protocol: "vless", has_secret: true }],
      bindings: [], quota_bytes: 1024 * GiB, quota_period: "monthly", quota_reset_day: 1,
      expires_at: "2026-12-31T00:00:00Z", group: "openjobs", migrated: true,
      created_at: "2026-06-11T09:12:00Z", updated_at: "2026-09-01T11:00:00Z",
    },
    {
      id: "u_probe", email: "probe@lattice.invalid", name: "Liveness probe", enabled: true,
      credentials: [{ protocol: "vless", has_secret: true }],
      bindings: [{ line_hash_id: probeHash, enabled: true }], quota_bytes: 0,
      expires_at: "2026-10-31T00:00:00Z", group: "probe", migrated: false,
      created_at: "2026-09-10T09:12:00Z", updated_at: "2026-09-10T09:12:00Z",
    },
  ];
  if (scenario !== "dense") return base;
  const team = Array.from({ length: 9 }, (_, index) => ({
    id: `u_team_${index + 1}`, email: `team-${index + 1}@example.invalid`, name: `Team seat ${index + 1}`, enabled: index !== 8,
    credentials: [{ protocol: "vless", has_secret: true }], bindings: [],
    quota_bytes: [50, 100, 200, 0, 100, 50, 0, 20, 100][index] * GiB, quota_period: "monthly", quota_reset_day: 1,
    expires_at: index % 3 === 0 ? `2026-1${index % 2}-15T00:00:00Z` : undefined, group: "team", migrated: false,
    created_at: "2026-07-01T09:12:00Z", updated_at: "2026-09-01T11:00:00Z",
  }));
  return [...base, ...USERS, ...team];
}

function productionProfiles(groups: FleetGroup[]) {
  return [...groups, { node_id: nodeKey("[cd]-LegendVPS-SG-EVO"), node_name: "[cd]-LegendVPS-SG-EVO", lines: [] }].map((group) => ({
    node_id: group.node_id, node_name: group.node_name, managed: group.lines.some((line) => line.managed),
    core: "sing-box", core_version: "1.12.4", config_path: "/etc/sing-box/config.json", stats_api: "127.0.0.1:9090",
    applied: group.lines.some((line) => line.overlay_status === "applied"),
    inbound_count: group.lines.length, discovered_count: group.lines.length, discovery_status: "ok",
    collector: { source: "singbox_stats_api", status: "ok" }, capabilities: ["discover", "apply"],
  }));
}

export function handlers(scenario: Scenario): Record<string, (payload: any) => unknown> {
  const production = isProductionShape(scenario);
  const groups = production ? buildProductionFleet(scenario) : scenario === "hubs" ? buildHubFleet() : buildLines(scenario);
  const chains = buildChains(scenario);
  const flat = groups.flatMap((group) => group.lines);
  const users = production ? productionUsers(scenario, groups) : usersWithUsage(scenario);
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
    "users/list": () => ({ users }),
    "users-admin/create": () => ({ ok: true }),
    "users-admin/update": () => ({ ok: true }),
    "users-admin/delete": () => ({ ok: true }),
    "users-admin/bind": () => ({ ok: true }),
    "users-admin/unbind": () => ({ ok: true }),
    "users-admin/rotate": () => ({ protocol: "vless", revealed_credential: "4f2a1c88-0d55-4a3e-9d31-6b71f0c2a9de" }),
    "users-admin/plan_add": () => ({ approval: { id: "apr_add", plan: JSON.stringify({ summary: "sb user add" }) } }),
    "users-admin/plan_update": () => ({ approval: { id: "apr_upd", plan: JSON.stringify({ summary: "sb user update" }) } }),
    "users-admin/plan_remove": () => ({ approval: { id: "apr_del", plan: JSON.stringify({ summary: "sb user del" }) } }),
    "profiles/query": () => ({ profiles: production ? productionProfiles(groups) : buildProfiles(scenario) }),
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
      if (production) {
        const usage = productionUsage(groups, scenario, window, users);
        const repeated = usage.lines.filter((row) => row.role === "entry" || row.role === "relay").reduce((sum, row) => sum + row.used_bytes, 0);
        return {
          // The legacy aggregate fields, as production sends them: by_node is
          // zero on every node, which is why nothing may read it.
          by_user: [],
          by_node: groups.map((group) => ({ node_id: group.node_id, node_name: group.node_name, used_bytes: 0, user_count: 0 })),
          rows: [],
          per_line: true,
          collectors: usage.collectors,
          lines: usage.lines,
          double_counted_via_chains_bytes: repeated,
          period: window,
          from: usage.series.days[0],
          to: usage.series.days[usage.series.days.length - 1],
          // An older server sends neither field; "legacy" is that server.
          ...(scenario === "legacy" ? {} : { series: usage.series, ...(usage.previous ? { previous: usage.previous } : {}) }),
        };
      }
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
      const source = production ? productionUsage(groups, scenario, period || "30d", users).lines : buildUsageLines(scenario, period || "30d");
      const lines = source
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
