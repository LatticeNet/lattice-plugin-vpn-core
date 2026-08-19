import { describe, expect, it } from "vitest";

import {
  connectedSubgraph,
  filterTopologyRows,
  layoutChainGraph,
  normalizeChainTopology,
  pageTopologyRows,
  rowEvidence,
  summarizeTopology,
  type ChainTopologyWorkCounters,
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

  it("keeps unresolved discovery-only targets in canonical rows", () => {
    const result = normalizeChainTopology(groups(
      line("source", { jump_edges: ["missing"], declared_jump_edges: ["missing"] }),
    ), []);
    expect(result.rows[0].discoveredTargets).toEqual([
      expect.objectContaining({ kind: "discovered_declared", target: expect.objectContaining({ lineUUID: "missing", resolved: false }) }),
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

describe("connectedSubgraph", () => {
  it("drops nodes that carry no edge, so an edgeless fleet draws nothing", () => {
    const topology = normalizeChainTopology(groups(line("a"), line("b"), line("c")), []);
    expect(topology.graph.nodes).toHaveLength(3);
    expect(connectedSubgraph(topology.graph).nodes).toEqual([]);
  });

  it("keeps both ends of every drawn edge", () => {
    const topology = normalizeChainTopology(groups(line("a"), line("b"), line("c")), [chain({
      source_line_uuid: "a", status: "converged",
      current: { target_line_uuid: "b", status: "converged" },
      observed_downstream_line_uuid: "b",
    })]);
    const connected = connectedSubgraph(topology.graph);
    expect(connected.nodes.map((node) => node.lineUUID)).toEqual(["a", "b"]);
    expect(connected.edges).toHaveLength(1);
  });
});

describe("layoutChainGraph", () => {
  const target = (uuid: string): TopologyTarget => ({ lineUUID: uuid, label: uuid, resolved: true });
  const link = (from: string, to: string): TopologyEdge => ({ id: `verified:${from}:${to}`, from, to, kind: "verified", targetResolved: true });

  it("ranks a chain left to right so hops read as hops", () => {
    const layout = layoutChainGraph([target("a"), target("b"), target("c")], [link("a", "b"), link("b", "c")]);
    expect(layout.nodes.map((node) => [node.lineUUID, node.rank])).toEqual([["a", 0], ["b", 1], ["c", 2]]);
    expect(layout.nodes[0].x).toBeLessThan(layout.nodes[2].x);
    expect(layout.dropped).toBe(0);
  });

  it("stacks siblings of one rank instead of overlapping them", () => {
    const layout = layoutChainGraph([target("hub"), target("x"), target("y")], [link("hub", "x"), link("hub", "y")]);
    const [x, y] = [layout.nodes[1], layout.nodes[2]];
    expect(x.rank).toBe(1);
    expect(y.rank).toBe(1);
    expect(x.y).not.toBe(y.y);
  });

  it("places a cycle in a trailing column rather than dropping it", () => {
    const layout = layoutChainGraph([target("a"), target("b")], [link("a", "b"), link("b", "a")]);
    expect(layout.nodes).toHaveLength(2);
    expect(layout.edges).toHaveLength(2);
  });

  it("reports what it dropped when the graph exceeds the drawing bound", () => {
    const nodes = Array.from({ length: 12 }, (_, index) => target(`n${index}`));
    const layout = layoutChainGraph(nodes, [link("n0", "n1")], 5);
    expect(layout.nodes).toHaveLength(5);
    expect(layout.dropped).toBe(7);
  });
});
