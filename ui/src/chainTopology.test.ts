import { describe, expect, it } from "vitest";

import { normalizeChainTopology, pageTopologyRows, type TopologyEdge } from "./chainTopology";
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
  });

  it("retains unresolved targets in the table while excluding them from the bounded graph", () => {
    const result = normalizeChainTopology(groups(line("source")), [chain({
      status: "drifted", current: { target_line_uuid: "missing", status: "drifted" },
    })]);
    expect(result.rows[0].currentTarget?.resolved).toBe(false);
    expect(result.edges[0]).toMatchObject({ to: "missing", targetResolved: false });
    expect(result.graph.edges).toEqual([]);
  });

  it("normalizes 10k lines linearly, caps the graph, and paginates the canonical table by 100", () => {
    const many = Array.from({ length: 10_000 }, (_, index) => line(`line-${String(index).padStart(5, "0")}`));
    const result = normalizeChainTopology(groups(...many), []);
    expect(result.rows).toHaveLength(10_000);
    expect(result.graph.nodes).toHaveLength(100);
    expect(result.graph.truncated).toBe(true);
    expect(pageTopologyRows(result.rows, 2).rows).toHaveLength(100);
    expect(pageTopologyRows(result.rows, 100).rows).toHaveLength(100);
    expect(pageTopologyRows(result.rows, 101).page).toBe(100);
  });
});
