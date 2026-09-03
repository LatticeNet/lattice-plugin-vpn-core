import { describe, expect, it } from "vitest";

import {
  attributionLabel,
  attributionTone,
  collectorLabel,
  collectorReports,
  collectorTone,
  coverageNote,
  foldUsage,
  formatDay,
  formatDayRange,
  isUsagePeriod,
  lineNameIndex,
  measurementLabel,
  periodLabel,
  quotaResetDayFromInput,
  quotaState,
  roleLabel,
  summarizeAllocation,
  upstreamLines,
  type AllocatedNode,
  type UsageLineRow,
} from "./usageModel";

const row = (over: Partial<UsageLineRow> = {}): UsageLineRow => ({
  node_id: "node-a",
  node_name: "hkg-edge-01",
  line_hash_id: "lh_0001",
  tag: "vless-in",
  role: "direct",
  uplink: 100,
  downlink: 200,
  used_bytes: 300,
  attribution: "named",
  attribution_proof: "proof",
  attribution_reason: "user counter on this line folds to this identity",
  user_id: "u_alice",
  email: "alice@example.invalid",
  counted: true,
  ...over,
});

describe("counted_at is a list of upstream lines, not a time", () => {
  it("splits the comma-joined hashes the server sends", () => {
    expect(upstreamLines(row({ counted_at: "lh_0009,lh_0010" }))).toEqual(["lh_0009", "lh_0010"]);
  });

  it("tolerates spacing and reports no upstream for a standalone row", () => {
    expect(upstreamLines(row({ counted_at: " lh_0009 , lh_0010 " }))).toEqual(["lh_0009", "lh_0010"]);
    expect(upstreamLines(row())).toEqual([]);
    expect(upstreamLines(row({ counted_at: "" }))).toEqual([]);
  });
});

describe("foldUsage separates what feeds a quota from what a node moved", () => {
  // One chain: the entry counts for alice, the exit carries the same bytes
  // again for the node but must not reach her total a second time.
  const lines: UsageLineRow[] = [
    row({ node_id: "node-a", line_hash_id: "lh_entry", role: "entry", used_bytes: 300, counted: true }),
    row({
      node_id: "node-b", node_name: "lax-exit-01", line_hash_id: "lh_exit", role: "exit",
      used_bytes: 300, counted: false, attribution: "none", attribution_proof: undefined,
      attribution_reason: "reached through a relay; counted at the entry line",
      counted_at: "lh_entry", user_id: undefined, email: undefined,
    }),
    row({
      node_id: "node-b", node_name: "lax-exit-01", line_hash_id: "lh_exit", role: "shared",
      used_bytes: 50, counted: true, estimate: true, attribution: "credential",
      attribution_proof: "proof", user_id: "u_bob", email: "bob@example.invalid",
    }),
  ];

  it("counts only counted rows toward an identity", () => {
    const fold = foldUsage(lines);
    const alice = fold.byUser.find((user) => user.userID === "u_alice");
    expect(alice?.countedBytes).toBe(300);
    expect(fold.countedBytes).toBe(350);
  });

  it("counts every byte a node reported, chain overlap included", () => {
    const fold = foldUsage(lines);
    const nodeB = fold.byNode.find((node) => node.nodeID === "node-b");
    // 300 relayed + 50 direct: the node really moved both.
    expect(nodeB?.totalBytes).toBe(350);
    expect(nodeB?.relayedBytes).toBe(0);
    expect(nodeB?.unattributedBytes).toBe(300);
    expect(fold.totalBytes).toBe(650);
  });

  it("keeps estimated bytes identifiable rather than folding them into measurements", () => {
    const fold = foldUsage(lines);
    expect(fold.estimatedBytes).toBe(50);
    expect(fold.byUser.find((user) => user.userID === "u_bob")?.hasEstimate).toBe(true);
    expect(fold.byUser.find((user) => user.userID === "u_alice")?.hasEstimate).toBe(false);
  });

  it("reports traffic with no identity as unattributed, never as zero", () => {
    const fold = foldUsage(lines);
    expect(fold.unattributedBytes).toBe(300);
    expect(fold.rows).toBe(3);
  });

  it("counts an unknown line separately, since no line on the node carries the tag", () => {
    const fold = foldUsage([
      row({ attribution: "unknown_line", role: "direct", user_id: undefined, email: undefined, counted: false, used_bytes: 70, line_hash_id: undefined }),
    ]);
    expect(fold.unknownLineBytes).toBe(70);
    expect(fold.unattributedBytes).toBe(70);
    expect(fold.countedBytes).toBe(0);
  });

  it("returns an all-zero fold for an absent or empty listing", () => {
    expect(foldUsage(undefined).rows).toBe(0);
    expect(foldUsage([]).byUser).toEqual([]);
    expect(foldUsage([]).totalBytes).toBe(0);
  });

  it("orders users and nodes by the figure the screen ranks on", () => {
    const fold = foldUsage([
      row({ user_id: "u_small", used_bytes: 10, node_id: "node-small" }),
      row({ user_id: "u_big", used_bytes: 900, node_id: "node-big" }),
    ]);
    expect(fold.byUser.map((user) => user.userID)).toEqual(["u_big", "u_small"]);
    expect(fold.byNode.map((node) => node.nodeID)).toEqual(["node-big", "node-small"]);
  });
});

describe("attribution reads as a claim an operator can act on", () => {
  it("names each attribution without ever going blank", () => {
    expect(attributionLabel(row({ attribution: "named" }))).toBe("named user");
    expect(attributionLabel(row({ attribution: "credential" }))).toBe("credential match");
    expect(attributionLabel(row({ attribution: "binding" }))).toBe("only binding");
    expect(attributionLabel(row({ attribution: "substore" }))).toBe("only Sub-Store record");
    expect(attributionLabel(row({ attribution: "unknown_line" }))).toBe("unknown line");
  });

  it("says unattributed when the server listed candidates and could not choose", () => {
    expect(attributionLabel(row({ attribution: "none", candidates: ["u_a", "u_b"] }))).toBe("unattributed");
    expect(attributionLabel(row({ attribution: "none", candidates: undefined }))).toBe("no user");
  });

  it("tones proven attributions apart from inferred ones", () => {
    expect(attributionTone(row({ attribution: "named" }))).toBe("healthy");
    expect(attributionTone(row({ attribution: "credential", attribution_proof: "proof" }))).toBe("healthy");
    expect(attributionTone(row({ attribution: "binding", attribution_proof: "inferred" }))).toBe("info");
    expect(attributionTone(row({ attribution: "substore", attribution_proof: "inferred" }))).toBe("info");
    expect(attributionTone(row({ attribution: "none" }))).toBe("warning");
    expect(attributionTone(row({ attribution: "unknown_line" }))).toBe("error");
  });

  it("labels every byte figure as measured or estimated", () => {
    expect(measurementLabel(row())).toBe("measured");
    expect(measurementLabel(row({ estimate: true }))).toBe("estimated");
  });

  it("names every chain role and falls back rather than printing nothing", () => {
    expect(["direct", "entry", "relay", "exit", "shared"].map(roleLabel))
      .toEqual(["direct", "entry", "relay", "exit", "shared"]);
    expect(roleLabel("")).toBe("unknown");
  });
});

describe("a collector that is not reporting means unknown, not zero", () => {
  it("only ok counts as reporting", () => {
    expect(collectorReports("ok")).toBe(true);
    for (const state of ["error", "stats_off", "no_collector", ""]) {
      expect(collectorReports(state)).toBe(false);
    }
  });

  it("names and tones each collector state", () => {
    expect(collectorLabel("ok")).toBe("reporting");
    expect(collectorLabel("stats_off")).toBe("stats API off");
    expect(collectorLabel("no_collector")).toBe("no collector");
    expect(collectorLabel("")).toBe("not reported");
    expect(collectorTone("ok")).toBe("healthy");
    expect(collectorTone("error")).toBe("error");
    expect(collectorTone("no_collector")).toBe("warning");
  });
});

describe("allocation coverage says which nodes the figure does not cover", () => {
  const nodes: AllocatedNode[] = [
    { node_id: "node-a", node_name: "hkg-edge-01", collector_state: "ok", lines: [
      { line_hash_id: "lh_1", role: "entry", allocation: "binding", period_uplink: 10, period_downlink: 20, counted: true },
    ] },
    { node_id: "node-b", node_name: "lax-exit-01", collector_state: "no_collector", lines: [
      { line_hash_id: "lh_2", role: "exit", allocation: "relay", period_uplink: 0, period_downlink: 0, counted: false, via_relay: true },
    ] },
    { node_id: "node-c", collector_state: "error", lines: [] },
  ];

  it("counts nodes, lines and the relayed exits", () => {
    const summary = summarizeAllocation(nodes);
    expect(summary).toMatchObject({ nodes: 3, lines: 2, viaRelayLines: 1, reportingNodes: 1 });
    expect(summary.silentNodes.map((node) => node.node_id)).toEqual(["node-b", "node-c"]);
  });

  it("writes a note naming the silent nodes, falling back to the id", () => {
    const note = coverageNote(summarizeAllocation(nodes));
    expect(note).toContain("lax-exit-01");
    expect(note).toContain("node-c");
    expect(note).toContain("unknown rather than zero");
  });

  it("says nothing when every allocated node reports", () => {
    expect(coverageNote(summarizeAllocation([nodes[0]]))).toBe("");
    expect(coverageNote(summarizeAllocation([]))).toBe("");
    expect(coverageNote(summarizeAllocation(undefined))).toBe("");
  });
});

describe("quotaState treats absent and zero alike, because the wire does", () => {
  it("reports no quota for absent, zero and negative", () => {
    for (const quota of [undefined, 0, -5]) {
      expect(quotaState(900, quota).hasQuota).toBe(false);
    }
  });

  it("computes a clamped percentage and the remaining allowance", () => {
    const state = quotaState(50, 200);
    expect(state).toMatchObject({ hasQuota: true, percent: 25, over: false, remainingBytes: 150, tone: "healthy" });
  });

  it("warns near the ceiling and errors at or past it", () => {
    expect(quotaState(160, 200).tone).toBe("warning");
    expect(quotaState(200, 200)).toMatchObject({ over: true, tone: "error", percent: 100, remainingBytes: 0 });
    expect(quotaState(400, 200)).toMatchObject({ over: true, percent: 100, remainingBytes: 0 });
  });
});

describe("quota reset day accepts only a day every month has", () => {
  it("takes 1 through 28 and rejects the rest", () => {
    expect(quotaResetDayFromInput("1")).toBe(1);
    expect(quotaResetDayFromInput(" 28 ")).toBe(28);
    for (const bad of ["0", "29", "31", "-1", "1.5", "abc"]) {
      expect(quotaResetDayFromInput(bad)).toBeUndefined();
    }
  });

  it("reads blank as leave it alone", () => {
    expect(quotaResetDayFromInput("")).toBeUndefined();
    expect(quotaResetDayFromInput("   ")).toBeUndefined();
  });
});

describe("period bounds render from the server's yyyymmdd", () => {
  it("formats a day and a range", () => {
    expect(formatDay("20260801")).toBe("2026-08-01");
    expect(formatDayRange("20260801", "20260831")).toBe("2026-08-01 to 2026-08-31");
    expect(formatDayRange("20260801", "20260801")).toBe("2026-08-01");
  });

  it("returns nothing rather than half a range or a malformed day", () => {
    expect(formatDay("2026-08-01")).toBe("");
    expect(formatDay(undefined)).toBe("");
    expect(formatDayRange("20260801", undefined)).toBe("");
    expect(formatDayRange(undefined, "20260831")).toBe("");
  });

  it("knows the periods the server accepts", () => {
    expect(["today", "7d", "30d", "all"].every(isUsagePeriod)).toBe(true);
    expect(isUsagePeriod("quota")).toBe(false);
    expect(isUsagePeriod("")).toBe(false);
    expect(periodLabel("7d")).toBe("Last 7 days");
    expect(periodLabel("weird")).toBe("weird");
  });
});

describe("lineNameIndex names a row from the fleet listing", () => {
  it("maps hash to line name and ignores a group with no lines", () => {
    const index = lineNameIndex([
      { node_id: "node-a", node_name: "hkg-edge-01", lines: [
        { id: "1", line_hash_id: "lh_1", node_id: "node-a", core: "sing-box", source: "discovery", managed: false, name: "VLESS-REALITY-443", user_count: 0, user_known: true },
      ] },
      { node_id: "node-b", lines: [] },
    ]);
    expect(index.get("lh_1")).toBe("VLESS-REALITY-443");
    expect(index.size).toBe(1);
    expect(lineNameIndex(undefined).size).toBe(0);
  });
});
