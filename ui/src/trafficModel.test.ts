import { describe, expect, it } from "vitest";

import {
  OTHERS_KEY,
  attributionSummary,
  byteTicks,
  bytesByLine,
  changeAgainst,
  egressByDay,
  hasSeries,
  nodeDaily,
  rankExits,
  roleTotals,
  seriesEgressGap,
  shortDay,
  stackByExit,
  stackByRole,
  trafficByNode,
  type UsageSeries,
} from "./trafficModel";
import type { UsageLineRow } from "./usageModel";

const GiB = 1024 ** 3;

function row(node: string, role: string, gib: number, extra: Partial<UsageLineRow> = {}): UsageLineRow {
  return {
    node_id: node, node_name: `[Metix]-${node}`, line_hash_id: `lh_${node}_${role}_${gib}`, tag: "in", role,
    uplink: 0, downlink: gib * GiB, used_bytes: gib * GiB, attribution: "none", counted: false, ...extra,
  };
}

const week: UsageLineRow[] = [
  row("vircs", "exit", 97.6),
  row("frontier", "exit", 55),
  row("dmit-1", "entry", 60),
  row("dmit-1", "direct", 6),
  row("eb-wee", "relay", 0.2),
];

describe("egress is exit plus direct, and entry is the same traffic counted again", () => {
  it("splits the line rows by role and never adds entry or relay to egress", () => {
    const totals = roleTotals(week);
    expect(totals.egress).toBeCloseTo((97.6 + 55 + 6) * GiB, 0);
    expect(totals.repeated).toBeCloseTo((60 + 0.2) * GiB, 0);
    expect(totals.total).toBeCloseTo(totals.egress + totals.repeated, 0);
  });

  it("counts a shared line, a chain target with its own users, as egress", () => {
    const totals = roleTotals([row("a", "shared", 3), row("a", "exit", 2)]);
    expect(totals.shared).toBe(3 * GiB);
    expect(totals.egress).toBe(5 * GiB);
    expect(trafficByNode([row("a", "shared", 3)]).get("a")?.egress).toBe(3 * GiB);
  });

  it("keeps a role the contract does not name out of egress, and visible", () => {
    const totals = roleTotals([row("a", "unknown", 3)]);
    expect(totals.egress).toBe(0);
    expect(totals.other).toBe(3 * GiB);
  });

  it("totals nodes from the line rows, egress and relayed apart", () => {
    const nodes = trafficByNode(week);
    expect(nodes.get("dmit-1")).toMatchObject({ egress: 6 * GiB, repeated: 60 * GiB, total: 66 * GiB });
    expect(nodes.get("vircs")?.egress).toBe(97.6 * GiB);
  });

  it("sums every row that names a line, so a split line reads as one figure", () => {
    const index = bytesByLine([row("a", "exit", 2, { line_hash_id: "lh_x" }), row("a", "shared", 1, { line_hash_id: "lh_x" })]);
    expect(index.get("lh_x")).toBe(3 * GiB);
  });

  it("ranks exits by egress with their share, and leaves the trend out without a series", () => {
    const ranked = rankExits(week);
    expect(ranked.map((exit) => exit.nodeID)).toEqual(["vircs", "frontier", "dmit-1"]);
    expect(ranked[0].share).toBeCloseTo(97.6 / 158.6, 5);
    expect(ranked[0].trend).toBeUndefined();
  });
});

const series: UsageSeries = {
  days: ["20260927", "20260928", "20260929"],
  rows: [
    { node_id: "a", node_name: "A", role: "exit", bytes: [10, 20, 30] },
    { node_id: "b", node_name: "B", role: "exit", bytes: [5, 5, 5] },
    { node_id: "c", node_name: "C", role: "direct", bytes: [1, 2, 3] },
    { node_id: "d", role: "exit", bytes: [0, 1, 0] },
    { node_id: "e", node_name: "E", role: "shared", bytes: [2, 2, 2] },
    { node_id: "hub", node_name: "Hub", role: "entry", bytes: [14, 24, 34] },
  ],
};

describe("series folding", () => {
  it("sums egress per day from exit and direct rows only", () => {
    expect(egressByDay(series)).toEqual([18, 30, 40]);
  });

  it("stacks the top exits and folds the rest into others, day totals equal to egress", () => {
    const stack = stackByExit(series, 2);
    expect(stack.segments.map((segment) => segment.label)).toEqual(["A", "B", "3 other exits"]);
    expect(stack.segments[2].key).toBe(OTHERS_KEY);
    expect(stack.segments[2].values).toEqual([3, 5, 5]);
    expect(stack.totals).toEqual(egressByDay(series));
    expect(stack.max).toBe(40);
  });

  it("does not invent an others segment when every exit has its own", () => {
    const stack = stackByExit(series, 6);
    expect(stack.segments.some((segment) => segment.key === OTHERS_KEY)).toBe(false);
    expect(stack.segments.map((segment) => segment.key)).toEqual(["a", "b", "c", "e", "d"]);
  });

  it("stacks by role with egress at the bottom and the repeated count above it", () => {
    const stack = stackByRole(series);
    expect(stack.segments.map((segment) => segment.key)).toEqual(["exit", "shared", "direct", "entry"]);
    expect(stack.totals).toEqual([32, 54, 74]);
  });

  it("gives one node's daily bytes, narrowed by role, and nothing for a node with no row", () => {
    expect(nodeDaily(series, "a")).toEqual([10, 20, 30]);
    expect(nodeDaily(series, "hub", new Set(["exit", "direct"]))).toBeUndefined();
    expect(nodeDaily(series, "missing")).toBeUndefined();
  });

  it("tolerates a short bytes array by reading the missing days as zero", () => {
    const ragged: UsageSeries = { days: ["20260928", "20260929"], rows: [{ node_id: "a", role: "exit", bytes: [4] }] };
    expect(egressByDay(ragged)).toEqual([4, 0]);
  });

  it("holds the series to the line rows on egress", () => {
    const lines = [row("a", "exit", 0, { used_bytes: 60 }), row("b", "exit", 0, { used_bytes: 15 }), row("c", "direct", 0, { used_bytes: 6 }), row("d", "exit", 0, { used_bytes: 1 }), row("e", "shared", 0, { used_bytes: 6 })];
    expect(seriesEgressGap(series, lines)).toBe(0);
    expect(seriesEgressGap(series, lines.slice(1))).toBe(60);
  });

  it("attaches each exit's trend when a series is present", () => {
    const lines = [row("a", "exit", 0, { used_bytes: 60 })];
    expect(rankExits(lines, series)[0].trend).toEqual([10, 20, 30]);
  });
});

describe("the no-series fallback", () => {
  it("recognises an absent or empty series", () => {
    expect(hasSeries(undefined)).toBe(false);
    expect(hasSeries(null)).toBe(false);
    expect(hasSeries({ days: [], rows: [] })).toBe(false);
    expect(hasSeries(series)).toBe(true);
  });

  it("still ranks per-exit totals from the line rows, which is what the fallback bars draw", () => {
    const ranked = rankExits(week, undefined);
    expect(ranked).toHaveLength(3);
    expect(ranked.every((exit) => exit.trend === undefined)).toBe(true);
    expect(ranked.reduce((sum, exit) => sum + exit.egress, 0)).toBe(roleTotals(week).egress);
  });
});

describe("change against the previous window", () => {
  it("reads a percentage with a sign and a hyphen-minus", () => {
    expect(changeAgainst(313, { from: "a", to: "b", egress_bytes: 280 })?.label).toBe("+12%");
    expect(changeAgainst(270, { from: "a", to: "b", egress_bytes: 300 })?.label).toBe("-10%");
    expect(changeAgainst(300, { from: "a", to: "b", egress_bytes: 300 })?.label).toBe("no change");
  });

  it("says nothing when there is no previous window or it moved nothing", () => {
    expect(changeAgainst(313, undefined)).toBeUndefined();
    expect(changeAgainst(313, { from: "a", to: "b", egress_bytes: 0 })).toBeUndefined();
  });
});

describe("attribution and axis helpers", () => {
  it("counts lines with a counted identity and the share of bytes that carry one", () => {
    const summary = attributionSummary([
      row("a", "direct", 1, { user_id: "u_probe", counted: true }),
      row("b", "direct", 2, { user_id: "u_cdcd", counted: false }),
      row("c", "exit", 97),
    ]);
    expect(summary).toMatchObject({ lines: 3, countedLines: 1 });
    expect(summary.share).toBeCloseTo(3 / 100, 5);
  });

  it("labels days and picks round byte ticks", () => {
    expect(shortDay("20260923")).toBe("09-23");
    expect(shortDay("2026-09-23")).toBe("");
    expect(byteTicks(0)).toEqual([0]);
    expect(byteTicks(58 * GiB)).toEqual([0, 20 * GiB, 40 * GiB]);
  });
});
