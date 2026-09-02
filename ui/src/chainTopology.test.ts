import { describe, expect, it } from "vitest";

import {
  aggregateNodeGraph,
  chainTargetRejection,
  diagnoseTopologyAbsence,
  filterTopologyRows,
  fitNodeLayout,
  GRAPH_MIN_SCALE,
  isRelayCandidate,
  layoutNodeGraph,
  NODE_BOX_HEIGHT,
  NODE_BOX_WIDTH,
  normalizeChainTopology,
  pageTopologyRows,
  rowEvidence,
  summarizeTopology,
  type ChainTopologyWorkCounters,
  type NodeBox,
  type NodeEdge,
  type NodeLayout,
  type TopologyEdge,
  type TopologyRow,
  type TopologyTarget,
} from "./chainTopology";
import type { Line, LineChain, LineGroup } from "./vpnModel";

const line = (uuid: string, over: Partial<Line> = {}): Line => ({
  id: uuid, line_hash_id: uuid, line_uuid: uuid, node_id: `node-${uuid}`,
  core: "sing-box", source: "managed", managed: true, name: uuid,
  user_count: 1, user_known: true, ...over,
});
const groups = (...lines: Line[]): LineGroup[] => [{ node_id: "fleet", node_name: "Fleet", lines }];
const chain = (over: Partial<LineChain>): LineChain => ({
  source_line_uuid: "source", source_node_id: "node-source", status: "planned",
  current: null, attempt: null, ...over,
});
const kinds = (edges: TopologyEdge[]) => edges.map((edge) => `${edge.kind}:${edge.from}->${edge.to ?? "removed"}`);

describe("normalizeChainTopology", () => {
  it("keeps proposals, committed baseline, and observation disjoint", () => {
    const result = normalizeChainTopology(groups(
      line("source", { jump_edges: ["wrong"], declared_jump_edges: ["wrong"] }),
      line("old"), line("candidate"), line("observed"), line("wrong"),
    ), [chain({
      status: "applying",
      current: { target_line_uuid: "old", target_node_id: "node-old", artifact_digest: "a", status: "converged" },
      attempt: { operation: "replace", candidate_target_line_uuid: "candidate", approval_id: "approval", status: "applying" },
      observed_downstream_line_uuid: "observed",
    })]);

    expect(kinds(result.edges)).toEqual([
      "committed:source->old",
      "observed:source->observed",
    ]);
    const sourceRow = result.rows.find((row) => row.sourceLineUUID === "source");
    expect(sourceRow?.proposal?.targetLineUUID).toBe("candidate");
    expect(sourceRow?.proposal?.isEdge).toBe(false);
    expect(sourceRow?.observedTargetUUID).toBe("observed");
  });

  it.each([
    ["planned create", chain({ status: "planned", attempt: { operation: "set", candidate_target_line_uuid: "target", approval_id: "a", status: "planned" } }), []],
    ["failed replace", chain({ status: "failed", current: { target_line_uuid: "old", status: "converged" }, attempt: { operation: "replace", candidate_target_line_uuid: "new", approval_id: "a", status: "failed", error: "host rejected" }, observed_downstream_line_uuid: "old" }), ["committed:source->old", "observed:source->old"]],
    ["failed remove", chain({ status: "failed", current: { target_line_uuid: "old", status: "converged" }, attempt: { operation: "remove", approval_id: "a", status: "failed" }, observed_downstream_line_uuid: "old" }), ["committed:source->old", "observed:source->old"]],
    ["applied unobserved set", chain({ status: "applied_unobserved", current: { target_line_uuid: "target", status: "applied_unobserved" } }), ["committed:source->target"]],
    ["converged set", chain({ status: "converged", current: { target_line_uuid: "target", status: "converged" }, observed_downstream_line_uuid: "target" }), ["verified:source->target"]],
    ["drifted mismatch", chain({ status: "drifted", current: { target_line_uuid: "target", status: "drifted" }, observed_downstream_line_uuid: "other" }), ["committed:source->target", "observed:source->other"]],
    ["applied unobserved remove", chain({ status: "applied_unobserved", current: { status: "applied_unobserved" }, observed_downstream_line_uuid: "old" }), ["observed:source->old"]],
    ["converged remove", chain({ status: "converged", current: { status: "converged" } }), []],
  ])("projects %s truthfully", (_name, value, expected) => {
    expect(kinds(normalizeChainTopology(groups(line("source"), line("old"), line("new"), line("target"), line("other")), [value]).edges)).toEqual(expected);
  });

  it("uses discovery edges only when the source has no chain row and preserves provenance", () => {
    const result = normalizeChainTopology(groups(
      line("declared-source", { jump_edges: ["target"], declared_jump_edges: ["target"] }),
      line("inferred-source", { jump_edges: ["target"] }), line("target"),
    ), []);
    expect(result.edges.map((edge) => edge.kind)).toEqual(["discovered_declared", "discovered_inferred"]);
    expect(result.rows.find((row) => row.sourceLineUUID === "declared-source")?.discoveredTargets).toEqual([
      expect.objectContaining({ kind: "discovered_declared", target: expect.objectContaining({ lineUUID: "target", resolved: true }) }),
    ]);
    expect(result.rows.find((row) => row.sourceLineUUID === "inferred-source")?.discoveredTargets).toEqual([
      expect.objectContaining({ kind: "discovered_inferred", target: expect.objectContaining({ lineUUID: "target", resolved: true }) }),
    ]);
  });

  it("keeps unresolved discovery-only targets in canonical rows under their hash", () => {
    const result = normalizeChainTopology(groups(
      line("source", { jump_edges: ["missing"], declared_jump_edges: ["missing"] }),
    ), []);
    expect(result.rows[0].discoveredTargets).toEqual([
      expect.objectContaining({
        kind: "discovered_declared",
        target: expect.objectContaining({ lineUUID: "", lineHashID: "missing", resolved: false }),
      }),
    ]);
    expect(result.graph.edges).toEqual([]);
  });

  /**
   * The regression that made a real fleet report zero edges. Production never
   * has line_hash_id equal to line_uuid: the hash is "line_<hex>" and the uuid
   * is a UUIDv4. Every fixture in this file that sets them equal hides it, so
   * these cases set them apart on purpose.
   */
  it("resolves a discovery edge through line_hash_id, not line_uuid", () => {
    const hub = line("hub-uuid", { line_hash_id: "line_hub", jump_edges: ["line_exit"] });
    const exit = line("exit-uuid", { line_hash_id: "line_exit", name: "exit endpoint", node_id: "node-lax" });
    const result = normalizeChainTopology(groups(hub, exit), []);

    const hubRow = result.rows.find((row) => row.sourceLineUUID === "hub-uuid");
    expect(hubRow?.discoveredTargets).toEqual([
      expect.objectContaining({
        kind: "discovered_inferred",
        target: expect.objectContaining({ lineUUID: "exit-uuid", lineHashID: "line_exit", label: "exit endpoint", nodeID: "node-lax", resolved: true }),
      }),
    ]);
    expect(result.edges).toContainEqual(expect.objectContaining({ from: "hub-uuid", to: "exit-uuid", targetResolved: true }));
    expect(result.graph.edges).toEqual([expect.objectContaining({ from: "hub-uuid", to: "exit-uuid" })]);
  });

  it("marks a declared hash edge as declared and keeps it out of the drawing when the target has no uuid", () => {
    const hub = line("hub-uuid", { line_hash_id: "line_hub", jump_edges: ["line_exit"], declared_jump_edges: ["line_exit"] });
    const exit = line("", { line_hash_id: "line_exit", name: "pending exit" });
    exit.line_uuid = undefined;
    const result = normalizeChainTopology(groups(hub, exit), []);

    expect(result.rows[0].discoveredTargets).toEqual([
      expect.objectContaining({
        kind: "discovered_declared",
        target: expect.objectContaining({ lineUUID: "", lineHashID: "line_exit", label: "pending exit", resolved: true }),
      }),
    ]);
    expect(result.graph.edges).toEqual([]);
  });

  it("retains unresolved targets in the table while excluding them from the bounded graph", () => {
    const result = normalizeChainTopology(groups(line("source")), [chain({
      status: "drifted", current: { target_line_uuid: "missing", status: "drifted" },
    })]);
    expect(result.rows[0].currentTarget?.resolved).toBe(false);
    expect(result.edges[0]).toMatchObject({ to: "missing", targetResolved: false });
    expect(result.graph.edges).toEqual([]);
  });

  it("normalizes dense 10k line and edge inputs with exact linear operation counts", () => {
    const lineUUID = (index: number) => `line-${String(index).padStart(5, "0")}`;
    const many = Array.from({ length: 10_000 }, (_, index) => {
      const target = lineUUID((index + 1) % 10_000);
      return line(lineUUID(index), {
        jump_edges: [target],
        declared_jump_edges: index % 2 === 0 ? [target] : [],
      });
    });
    const authoritative = Array.from({ length: 5_000 }, (_, index) => chain({
      source_line_uuid: lineUUID(index),
      source_node_id: `node-${lineUUID(index)}`,
      status: "converged",
      current: { target_line_uuid: lineUUID(index + 1), status: "converged" },
      observed_downstream_line_uuid: lineUUID(index + 1),
    }));
    const work: ChainTopologyWorkCounters = {
      scannedLines: 0,
      scannedChains: 0,
      scannedDeclaredEdges: 0,
      scannedDiscoveryEdges: 0,
      scannedRowSources: 0,
      constructedAuthoritativeEdges: 0,
      constructedDiscoveryEdges: 0,
      filteredGraphEdges: 0,
    };
    const result = normalizeChainTopology(groups(...many), authoritative, 100, work);
    expect(result.rows).toHaveLength(10_000);
    expect(result.edges).toHaveLength(10_000);
    expect(result.graph.nodes).toHaveLength(100);
    expect(result.graph.truncated).toBe(true);
    expect(many.slice(0, 5_000).filter((value) => value.declared_jump_edges?.length)).toHaveLength(2_500);
    expect(result.work).toEqual({ scannedLines: 10_000, scannedChains: 5_000, scannedDiscoveryEdges: 5_000 });
    expect(work).toEqual({
      scannedLines: 10_000,
      scannedChains: 5_000,
      scannedDeclaredEdges: 2_500,
      scannedDiscoveryEdges: 5_000,
      scannedRowSources: 10_000,
      constructedAuthoritativeEdges: 5_000,
      constructedDiscoveryEdges: 5_000,
      filteredGraphEdges: 10_000,
    });
    expect(pageTopologyRows(result.rows, 2).rows).toHaveLength(100);
    expect(pageTopologyRows(result.rows, 100).rows).toHaveLength(100);
    expect(pageTopologyRows(result.rows, 101).page).toBe(100);
  });
});

describe("topology evidence", () => {
  const row = (over: Partial<TopologyRow>): TopologyRow => ({
    sourceLineUUID: "source", sourceLabel: "source", status: "discovered",
    removalTombstone: false, discoveredTargets: [], chain: null, ...over,
  });
  const target = (uuid: string): TopologyTarget => ({ lineUUID: uuid, label: uuid, resolved: true });

  it("classifies each source by the strongest evidence it carries", () => {
    expect(rowEvidence(row({ lastError: "apply refused" }))).toBe("attention");
    expect(rowEvidence(row({ status: "drifted" }))).toBe("attention");
    expect(rowEvidence(row({ proposal: { operation: "set", approvalID: "a", status: "planned", isEdge: false } }))).toBe("proposed");
    expect(rowEvidence(row({ currentTarget: target("t") }))).toBe("linked");
    expect(rowEvidence(row({ removalTombstone: true }))).toBe("linked");
    expect(rowEvidence(row({ discoveredTargets: [{ kind: "discovered_inferred", target: target("t") }] }))).toBe("discovered");
    expect(rowEvidence(row({}))).toBe("unlinked");
  });

  it("counts the production shape honestly: many sources, no chains, no edges", () => {
    const lines = Array.from({ length: 111 }, (_, index) => line(`line-${index}`));
    const summary = summarizeTopology(normalizeChainTopology(groups(...lines), []));
    expect(summary.sources).toBe(111);
    expect(summary.unlinked).toBe(111);
    expect(summary.linked).toBe(0);
    expect(summary.edges).toBe(0);
  });

  it("filters rows down to one evidence state and keeps every row under all", () => {
    const topology = normalizeChainTopology(groups(line("a"), line("b")), [chain({
      source_line_uuid: "a", status: "converged",
      current: { target_line_uuid: "b", status: "converged" },
      observed_downstream_line_uuid: "b",
    })]);
    expect(filterTopologyRows(topology.rows, "all")).toHaveLength(2);
    expect(filterTopologyRows(topology.rows, "linked").map((value) => value.sourceLineUUID)).toEqual(["a"]);
    expect(filterTopologyRows(topology.rows, "unlinked").map((value) => value.sourceLineUUID)).toEqual(["b"]);
  });
});

describe("aggregateNodeGraph", () => {
  const relay = (uuid: string, node: string, targetHash: string, over: Partial<Line> = {}): Line => line(uuid, {
    node_id: node, outbound_ref: `to-${targetHash}`, outbound_server: "10.0.0.9", outbound_port: 443, jump_edges: [targetHash], ...over,
  });
  const exit = (uuid: string, node: string): Line => line(uuid, { node_id: node, outbound_ref: "direct" });
  const fleet = (): LineGroup[] => [
    { node_id: "hub", node_name: "hub-01", lines: [relay("h1", "hub", "e1"), relay("h2", "hub", "e2"), relay("h3", "hub", "e1"), exit("h4", "hub")] },
    { node_id: "exit-a", node_name: "exit-a", lines: [exit("e1", "exit-a"), exit("e2", "exit-a")] },
    { node_id: "idle", node_name: "idle", lines: [exit("i1", "idle")] },
  ];

  it("folds line edges onto node pairs with the count and drops nodes that touch no edge", () => {
    const groups = fleet();
    const graph = aggregateNodeGraph(groups, normalizeChainTopology(groups, []));
    expect(graph.nodes.map((node) => node.id)).toEqual(["hub", "exit-a"]);
    expect(graph.nodes[0]).toMatchObject({ label: "hub-01", lines: 4, relays: 3, exits: 1, offFleet: false });
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ from: "hub", to: "exit-a", count: 3, kind: "discovered_inferred", unresolved: 0 });
    expect(graph.edges[0].sourceLineUUIDs).toEqual(["h1", "h2", "h3"]);
  });

  it("keeps the strongest evidence as the pair's kind", () => {
    const groups = fleet();
    const topology = normalizeChainTopology(groups, [chain({
      source_line_uuid: "h1", source_node_id: "hub", status: "converged",
      current: { target_line_uuid: "e1", status: "converged" }, observed_downstream_line_uuid: "e1",
    })]);
    const [edge] = aggregateNodeGraph(groups, topology).edges;
    expect(edge).toMatchObject({ count: 3, kind: "verified", kinds: { verified: 1, discovered_inferred: 2 } });
  });

  it("draws an endpoint no fleet line owns as an off-fleet box named by what the source dials", () => {
    const groups: LineGroup[] = [{ node_id: "hub", node_name: "hub-01", lines: [relay("h1", "hub", "lh_gone", { outbound_server: "vendor.example.invalid", outbound_port: 8443 })] }];
    const graph = aggregateNodeGraph(groups, normalizeChainTopology(groups, []));
    expect(graph.nodes.map((node) => [node.id, node.offFleet])).toEqual([["hub", false], ["off:vendor.example.invalid:8443", true]]);
    expect(graph.edges[0]).toMatchObject({ to: "off:vendor.example.invalid:8443", unresolved: 1 });
  });

  it("is not bounded by the per-line drawing cap", () => {
    const groups = fleet();
    const graph = aggregateNodeGraph(groups, normalizeChainTopology(groups, [], 1));
    expect(graph.edges[0].count).toBe(3);
  });
});

describe("layoutNodeGraph", () => {
  const box = (id: string): NodeBox => ({ id, label: id, offFleet: false, lines: 1, relays: 1, exits: 0 });
  const link = (from: string, to: string, count = 1): NodeEdge =>
    ({ id: `${from}->${to}`, from, to, count, kind: "discovered_inferred", kinds: { discovered_inferred: count }, unresolved: 0, sourceLineUUIDs: [] });

  it("ranks a chain left to right so a hop reads as a hop", () => {
    const layout = layoutNodeGraph({ nodes: [box("a"), box("b"), box("c")], edges: [link("a", "b"), link("b", "c")] });
    expect(layout.nodes.map((node) => [node.id, node.rank])).toEqual([["a", 0], ["b", 1], ["c", 2]]);
    expect(layout.nodes[0].x).toBeLessThan(layout.nodes[2].x);
    expect(layout.ranks).toBe(3);
    expect(layout.edges[0].x2).toBe(layout.nodes[1].x);
  });

  it("keeps a rank of twelve in one column and wraps the thirteenth", () => {
    const exits = Array.from({ length: 13 }, (_, index) => box(`exit-${index.toString().padStart(2, "0")}`));
    const twelve = layoutNodeGraph({ nodes: [box("hub"), ...exits.slice(0, 12)], edges: exits.slice(0, 12).map((exit) => link("hub", exit.id)) });
    expect(new Set(twelve.nodes.filter((node) => node.rank === 1).map((node) => node.x)).size).toBe(1);
    expect(twelve.height).toBe(24 * 2 + 12 * NODE_BOX_HEIGHT + 11 * 14);
    const layout = layoutNodeGraph({ nodes: [box("hub"), ...exits], edges: exits.map((exit) => link("hub", exit.id)) });
    const ranked = layout.nodes.filter((node) => node.rank === 1);
    expect(new Set(ranked.map((node) => node.x)).size).toBe(2);
    expect(Math.max(...ranked.map((node) => node.y))).toBe(layout.nodes.find((node) => node.id === "exit-11")!.y);
    expect(layout.height).toBe(24 * 2 + 12 * NODE_BOX_HEIGHT + 11 * 14);
    expect(layout.width).toBe(24 * 2 + NODE_BOX_WIDTH + 130 + 2 * NODE_BOX_WIDTH + 28);
  });

  it("places a cycle in a trailing rank rather than dropping it", () => {
    const layout = layoutNodeGraph({ nodes: [box("a"), box("b")], edges: [link("a", "b"), link("b", "a")] });
    expect(layout.nodes).toHaveLength(2);
    expect(layout.edges).toHaveLength(2);
  });

  it("lays the production shape out as three ranks that fit a wide console at full scale", () => {
    const hubs = ["DMIT-1", "DMIT-2", "DMIT-3", "DMIT-4", "hk-turin", "jp-pulse"].map(box);
    const exits = ["qqpw-cd2", "qqpw-cd3", "att-vds", "frontier-vds", "frontier-nat", "softbank-nat", "vircs"].map(box);
    const edges = hubs.flatMap((hub) => exits.map((exit) => link(hub.id, exit.id, 2)));
    const cd = [box("mkcloud"), box("eb-wee"), box("frontier-nat-cd"), box("jp-nat"), box("ca-nat"), box("att-cd")];
    edges.push(link("mkcloud", "eb-wee"), link("mkcloud", "jp-nat"), link("mkcloud", "ca-nat"), link("mkcloud", "att-cd"), link("eb-wee", "frontier-nat-cd"));
    const layout = layoutNodeGraph({ nodes: [...hubs, ...exits, ...cd], edges });
    expect(layout.ranks).toBe(3);
    expect(layout.edges).toHaveLength(47);
    const fit = fitNodeLayout(layout, 1995);
    expect(fit.scale).toBe(1);
    expect(fit.overflow).toBe(false);
  });
});

describe("fitNodeLayout", () => {
  const layout = (width: number): NodeLayout => ({ nodes: [], edges: [], width, height: 200, ranks: 1 });

  it("draws at full scale when the panel is wide enough", () => {
    expect(fitNodeLayout(layout(900), 1000)).toEqual({ scale: 1, overflow: false, renderWidth: 900, renderHeight: 200 });
  });

  it("scales down to the floor and then scrolls rather than refusing", () => {
    expect(fitNodeLayout(layout(1200), 1000)).toMatchObject({ scale: 1000 / 1200, overflow: false, renderWidth: 1000 });
    const wide = fitNodeLayout(layout(4000), 1000);
    expect(wide.scale).toBe(GRAPH_MIN_SCALE);
    expect(wide.overflow).toBe(true);
    expect(wide.renderWidth).toBe(3000);
  });

  it("treats an unmeasured panel as full scale", () => {
    expect(fitNodeLayout(layout(4000), 0)).toMatchObject({ scale: 1, overflow: false });
  });
});

describe("diagnoseTopologyAbsence", () => {
  const relay = (uuid: string, over: Partial<Line> = {}) => line(uuid, {
    outbound_ref: "relay-1", outbound_server: "exit.example.invalid", outbound_port: 443, ...over,
  });

  it("reports no_identity when nothing carries a line_uuid", () => {
    const nameless = line("x");
    nameless.line_uuid = undefined;
    const topology = normalizeChainTopology(groups(nameless), []);
    expect(diagnoseTopologyAbsence(groups(nameless), topology, 0)).toMatchObject({ reason: "no_identity", relayCandidates: 0 });
  });

  it("reports no_relay when every outbound on the fleet is direct", () => {
    const fleet = groups(line("a", { outbound_ref: "direct" }), line("b"));
    expect(diagnoseTopologyAbsence(fleet, normalizeChainTopology(fleet, []), 0))
      .toMatchObject({ reason: "no_relay", relayCandidates: 0, unmatchedUpstreams: [] });
  });

  it("names the upstreams when lines relay somewhere this control plane cannot see", () => {
    const fleet = groups(
      relay("a", { outbound_server: "vendor-a.example.invalid" }),
      relay("b", { outbound_server: "vendor-b.example.invalid" }),
      relay("c", { outbound_server: "vendor-a.example.invalid" }),
    );
    expect(diagnoseTopologyAbsence(fleet, normalizeChainTopology(fleet, []), 0)).toEqual({
      reason: "upstream_off_fleet",
      relayCandidates: 3,
      unmatchedUpstreams: ["vendor-a.example.invalid:443", "vendor-b.example.invalid:443"],
    });
  });

  it("does not count a relay whose upstream already resolved as unmatched", () => {
    const fleet = groups(relay("a", { jump_edges: ["a"] }));
    expect(diagnoseTopologyAbsence(fleet, normalizeChainTopology(fleet, []), 1))
      .toMatchObject({ reason: "drawn", relayCandidates: 1, unmatchedUpstreams: [] });
  });

  it("treats a relay with no resolvable server or port as a direct exit", () => {
    expect(isRelayCandidate(line("a", { outbound_ref: "relay-1" }))).toBe(false);
    expect(isRelayCandidate(line("a", { outbound_ref: "relay-1", outbound_server: "h", outbound_port: 0 }))).toBe(false);
    expect(isRelayCandidate(line("a", { outbound_ref: "DIRECT", outbound_server: "h", outbound_port: 443 }))).toBe(false);
    expect(isRelayCandidate(line("a", { outbound_ref: "relay-1", outbound_server: "h", outbound_port: 443 }))).toBe(true);
  });
});

describe("chainTargetRejection", () => {
  const eligible = (over: Partial<Line> = {}) => line("target", {
    core: "sing-box", type: "vless", security: "reality", transport: "tcp",
    overlay: true, overlay_status: "applied", status: "ok", node_id: "node-target", ...over,
  });

  it("accepts a healthy applied REALITY overlay on another node", () => {
    expect(chainTargetRejection(eligible(), "node-source")).toBeNull();
  });

  it.each([
    ["same_node", eligible({ node_id: "node-source" })],
    ["not_reality_vless", eligible({ type: "trojan" })],
    ["not_reality_vless", eligible({ security: "" })],
    ["not_reality_vless", eligible({ transport: "ws" })],
    ["not_reality_vless", eligible({ core: "xray" })],
    ["not_managed_overlay", eligible({ overlay: false })],
    ["not_managed_overlay", eligible({ overlay_status: "planned" })],
    ["not_managed_overlay", eligible({ status: "error" })],
  ])("rejects with %s", (reason, candidate) => {
    expect(chainTargetRejection(candidate, "node-source")).toBe(reason);
  });

  it("rejects a line with no control-plane identity", () => {
    const nameless = eligible();
    nameless.line_uuid = undefined;
    expect(chainTargetRejection(nameless, "node-source")).toBe("no_identity");
  });

  /**
   * A line flagged `managed` is not by itself a legal target: the plan call
   * needs the target's REALITY descriptor, which only a rolled-out overlay has.
   * Offering one is how the picker used to promise a plan the server refuses.
   */
  it("refuses a merely managed line that is not a rolled-out overlay", () => {
    expect(chainTargetRejection(line("target", { managed: true, node_id: "node-target" }), "node-source"))
      .toBe("not_reality_vless");
  });
});
