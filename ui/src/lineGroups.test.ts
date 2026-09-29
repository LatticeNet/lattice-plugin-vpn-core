import { describe, expect, it } from "vitest";

import { chainPath } from "./linePath";
import {
  groupLines,
  flatLines,
  lineBytes,
  lineStateOf,
  protocolSummary,
  roleSummary,
  stateSummary,
  targetSummary,
  type LineTrafficIndex,
} from "./lineGroups";
import { ROUTE_MAX_STROKE, buildRouteMap, routeShape, routeStroke } from "./routeMap";
import { trafficByNode, type NodeTraffic } from "./trafficModel";
import type { Line, LineGroup } from "./vpnModel";

const GiB = 1024 ** 3;

function line(hash: string, node: string, extra: Partial<Line> = {}): Line {
  return {
    id: hash, line_hash_id: hash, line_uuid: `uuid-${hash}`, node_id: node, core: "sing-box", source: "discovery",
    managed: false, name: `VLESS-REALITY-${hash}.json`, type: "vless", listen_port: 30000, public_host: `${node}.invalid`,
    outbound_ref: "direct", user_count: 1, user_known: true, status: "ok", service_state: "running", ...extra,
  };
}
const relay = (hash: string, node: string, target: string, port: number, extra: Partial<Line> = {}) =>
  line(hash, node, { listen_port: port, outbound_ref: `out-${target}`, outbound_server: `${target}.invalid`, outbound_port: 443, jump_edges: [target], ...extra });

/* Two hubs onto two exits, one relay onto a vendor endpoint, one direct-only node. */
const fleet: LineGroup[] = [
  { node_id: "e1", node_name: "[Metix]-VIRCS-ATT-VDS", lines: [line("e1", "e1", { listen_port: 34656 })] },
  { node_id: "e2", node_name: "[Metix]-Aaitr-Frontier-VDS", lines: [line("e2", "e2", { listen_port: 60295 })] },
  {
    node_id: "h1", node_name: "[Metix]-DMIT-1", lines: [
      relay("r1", "h1", "e1", 31001), relay("r2", "h1", "e1", 31002), relay("r3", "h1", "e2", 31003, { user_known: false }),
      line("x1", "h1", { listen_port: 32426 }),
    ],
  },
  { node_id: "h2", node_name: "[Metix]-DMIT-2", lines: [relay("r4", "h2", "e1", 31001, { type: "trojan", status: "error", last_error: "bind: address already in use" })] },
  {
    node_id: "m", node_name: "[Lab]-hub-fra-anexia", lines: [
      line("m1", "m", { listen_port: 51099, outbound_ref: "vendor-3", outbound_server: "edge-3.vendor.invalid", outbound_port: 443 }),
    ],
  },
  { node_id: "d", node_name: "[cd]-huoshan-shanghai", lines: [line("d1", "d", { listen_port: 34099 })] },
];

const byLine = new Map<string, number>([["r1", 10 * GiB], ["r2", 5 * GiB], ["r3", 2 * GiB], ["r4", 1 * GiB], ["e1", 16 * GiB], ["e2", 2 * GiB], ["d1", 4 * GiB]]);
const byNode = new Map<string, NodeTraffic>([
  ["h1", { nodeID: "h1", egress: 0, repeated: 17 * GiB, total: 17 * GiB }],
  ["h2", { nodeID: "h2", egress: 0, repeated: 1 * GiB, total: 1 * GiB }],
  ["e1", { nodeID: "e1", egress: 16 * GiB, repeated: 0, total: 16 * GiB }],
  ["e2", { nodeID: "e2", egress: 2 * GiB, repeated: 0, total: 2 * GiB }],
  ["d", { nodeID: "d", egress: 4 * GiB, repeated: 0, total: 4 * GiB }],
]);
const known: LineTrafficIndex = { known: true, byLine, reportingNodes: new Set(["e1", "e2", "h1", "h2", "d"]) };

describe("route map edge weights", () => {
  const map = buildRouteMap(fleet, [], { known: true, byLine, byNode });
  const edge = (from: string, to: string) => map.edges.find((value) => value.from === from && value.to === to);

  it("draws one edge per node pair, weighted by the bytes on the lines behind it", () => {
    expect(edge("h1", "e1")).toMatchObject({ count: 2, bytes: 15 * GiB });
    expect(edge("h1", "e2")).toMatchObject({ count: 1, bytes: 2 * GiB });
    expect(edge("h1", "e1")?.width).toBe(ROUTE_MAX_STROKE);
    expect(edge("h1", "e2")?.width).toBeCloseTo(routeStroke(2, 15), 5);
    expect(map.weightedBy).toBe("bytes");
  });

  it("colours an edge by the worst line on it", () => {
    expect(edge("h2", "e1")).toMatchObject({ state: "error", states: { healthy: 1, warning: 0, error: 1 } });
    expect(edge("h1", "e1")?.state).toBe("healthy");
  });

  it("counts the line an edge dials, so a dead exit listener reddens the routes into it", () => {
    const dead = fleet.map((group) => group.node_id === "e2" ? { ...group, lines: [{ ...group.lines[0], service_state: "down" }] } : group);
    const map = buildRouteMap(dead, [], { known: true, byLine, byNode });
    expect(map.edges.find((value) => value.from === "h1" && value.to === "e2")?.state).toBe("error");
  });

  it("marks an edge onto an endpoint outside the fleet", () => {
    const off = map.edges.find((value) => value.from === "m");
    expect(off?.offFleet).toBe(true);
    expect(map.boxes.find((box) => box.id === off?.to)?.offFleet).toBe(true);
  });

  it("puts hubs left by relayed bytes and exits right by egress", () => {
    const hubs = map.boxes.filter((box) => box.rank === 0 && !box.offFleet).sort((a, b) => a.y - b.y).map((box) => box.id);
    expect(hubs.slice(0, 2)).toEqual(["h1", "h2"]);
    const exits = map.boxes.filter((box) => box.rank === 1 && !box.offFleet).sort((a, b) => a.y - b.y).map((box) => box.id);
    expect(exits).toEqual(["e1", "e2"]);
    expect(map.boxes.find((box) => box.id === "e1")).toMatchObject({ measure: "egress", bytes: 16 * GiB });
  });

  it("counts the nodes it does not draw because nothing relays through them", () => {
    expect(map.directOnly).toEqual({ nodes: 1, bytes: 4 * GiB });
  });

  it("falls back to line counts, and says so, when traffic is unknown", () => {
    const blind = buildRouteMap(fleet, [], { known: false, byLine: new Map(), byNode: new Map() });
    expect(blind.weightedBy).toBe("lines");
    const heavy = blind.edges.find((value) => value.from === "h1" && value.to === "e1");
    expect(heavy?.bytes).toBeUndefined();
    expect(heavy?.width).toBe(ROUTE_MAX_STROKE);
    expect(blind.directOnly.bytes).toBeUndefined();
  });

  it("says unknown, not zero, for a node whose collector is silent", () => {
    const silent = buildRouteMap(fleet, [], { known: true, byLine, byNode, reportingNodes: new Set(["e1", "e2", "h1", "d", "m"]) });
    expect(silent.boxes.find((box) => box.id === "h2")).toMatchObject({ silent: true, bytes: undefined });
    expect(silent.edges.find((value) => value.from === "h2")?.bytes).toBeUndefined();
    expect(silent.boxes.find((box) => box.id === "h1")).toMatchObject({ silent: false, bytes: 17 * GiB });
  });

  it("reads the route shape from line roles", () => {
    expect(routeShape(fleet)).toEqual({ hubs: 3, exits: 4, relayLines: 5, exitLines: 4, orphanLines: 0 });
  });
});

describe("group rows carry aggregates in every member column", () => {
  it("groups by node, heaviest first, with counts, ports, targets, users, bytes and the worst state", () => {
    const groups = groupLines(fleet, "node", known);
    expect(groups[0].key).toBe("h1");
    const h1 = groups[0].agg;
    expect(h1.lines).toBe(4);
    expect(roleSummary(h1)).toBe("3 relay · 1 exit");
    expect(protocolSummary(h1)).toBe("vless 4");
    expect(h1.ports).toEqual({ min: 31001, max: 32426 });
    expect(targetSummary(h1)).toBe("2 nodes");
    expect(h1.users).toEqual({ known: 3, unknownLines: 1 });
    expect(h1.bytes).toBe(17 * GiB);
    expect(h1.unknownBytes).toBe(0);
    expect(h1.worst).toMatchObject({ label: "running", count: 4 });
    expect(h1.uniformState).toBe(true);
    expect(groups[0].sub).toBe("bank of 3 vless to 2 nodes");
  });

  it("names the worst state and its count when members differ", () => {
    const h2 = groupLines(fleet, "node", known).find((group) => group.key === "h2")!;
    expect(h2.agg.worst).toMatchObject({ label: "config error", tone: "error", count: 1 });
  });

  it("keeps an unknown traffic figure unknown and makes the sum a floor", () => {
    const partial: LineTrafficIndex = { known: true, byLine, reportingNodes: new Set(["e1"]) };
    const m = groupLines(fleet, "node", partial).find((group) => group.key === "m")!;
    expect(m.entries[0].bytes).toBeUndefined();
    expect(m.agg.unknownBytes).toBe(1);
    expect(lineBytes({ known: false, byLine, reportingNodes: new Set() }, fleet[0].lines[0])).toBeUndefined();
    expect(lineBytes(known, fleet[2].lines[3])).toBe(0);
  });

  it("groups by bank and puts every line outside a bank in one remainder group", () => {
    const groups = groupLines(fleet, "bank", known);
    expect(groups[0]).toMatchObject({ key: "h1:vless", label: "[Metix]-DMIT-1" });
    expect(groups[0].agg.lines).toBe(3);
    expect(groups[0].sub).toContain("ports 31001 to 31003");
    const rest = groups[groups.length - 1];
    expect(rest.key).toBe("unbanked");
    expect(rest.agg.lines).toBe(fleet.flatMap((group) => group.lines).length - 3);
  });

  it("groups by the exit traffic finally leaves from, with the relays that reach it", () => {
    const groups = groupLines(fleet, "exit", known);
    const e1 = groups.find((group) => group.key === "e1")!;
    expect(e1.entries.map((entry) => entry.line.line_hash_id).sort()).toEqual(["e1", "r1", "r2", "r4"]);
    expect(e1.sub).toBe("leaves here, reached by 3 relay lines on 2 hubs");
    expect(groups.find((group) => group.key.startsWith("off:"))?.entries[0].line.line_hash_id).toBe("m1");
    expect(groups.find((group) => group.key === "h1")?.entries.map((entry) => entry.line.line_hash_id)).toEqual(["x1"]);
  });

  it("returns one group for none and flattens search results heaviest first", () => {
    const none = groupLines(fleet, "none", known);
    expect(none).toHaveLength(1);
    expect(none[0].agg.lines).toBe(9);
    expect(flatLines([fleet[2]], known).map((entry) => entry.line.line_hash_id)).toEqual(["r1", "r2", "r3", "x1"]);
  });
});

describe("a status shared by every line moves to the header", () => {
  it("finds the uniform state", () => {
    expect(stateSummary([fleet[0], fleet[1]])).toMatchObject({ uniform: "running", configErrors: 0 });
  });

  it("lists the states worst first when they differ", () => {
    const summary = stateSummary(fleet);
    expect(summary.uniform).toBeUndefined();
    expect(summary.configErrors).toBe(1);
    expect(summary.counts[0]).toMatchObject({ label: "config error", count: 1 });
  });

  it("orders a dead service over a config error and keeps an unreported service neutral", () => {
    expect(lineStateOf(line("a", "n", { service_state: "down", status: "error" })).label).toBe("down");
    expect(lineStateOf(line("a", "n", { service_state: "unknown" }))).toMatchObject({ label: "config ok", tone: "neutral" });
    expect(lineStateOf(line("a", "n", { service_state: "unknown", service_note: "refused" })).label).toBe("unproven");
  });
});

describe("the chain one line belongs to", () => {
  it("draws a relay from its entry to the exit it dials", () => {
    const hops = chainPath(fleet, fleet[2].lines[0]);
    expect(hops.map((hop) => [hop.role, hop.nodeName, hop.current])).toEqual([
      ["entry", "[Metix]-DMIT-1", true],
      ["exit", "[Metix]-VIRCS-ATT-VDS", false],
    ]);
  });

  it("folds the lines that feed an exit into one entry hop that counts them", () => {
    const hops = chainPath(fleet, fleet[0].lines[0]);
    expect(hops[0]).toMatchObject({ role: "entry", nodeName: "2 nodes", fanIn: { lines: 3, nodes: 2 } });
    expect(hops[0].state?.label).toBe("config error");
    expect(hops[1]).toMatchObject({ role: "exit", current: true });
  });

  it("ends a relay onto an endpoint outside the fleet with that endpoint", () => {
    const hops = chainPath(fleet, fleet[4].lines[0]);
    // Traffic enters the fleet on this line and leaves it at the vendor.
    expect(hops.map((hop) => hop.role)).toEqual(["entry", "off-fleet"]);
    expect(hops[1].nodeName).toBe("edge-3.vendor.invalid:443");
  });

  it("is a single exit hop for a direct line", () => {
    expect(chainPath(fleet, fleet[5].lines[0]).map((hop) => hop.role)).toEqual(["exit"]);
  });
});

describe("node totals come from the line rows", () => {
  it("never reads the legacy by_node figure", () => {
    const nodes = trafficByNode([{ node_id: "e1", tag: "in", role: "exit", uplink: 0, downlink: 5, used_bytes: 5, attribution: "none", counted: false }]);
    expect(nodes.get("e1")?.egress).toBe(5);
  });
});
