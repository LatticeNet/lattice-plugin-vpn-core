import { describe, expect, it } from "vitest";

import { lineRole } from "../src/fleetRows";
import { attributionSummary, roleTotals, seriesEgressGap, type UsageSeries } from "../src/trafficModel";
import type { UsageLineRow } from "../src/usageModel";
import type { LineGroup } from "../src/vpnModel";
import { handlers } from "./fixtures";

const GiB = 1024 ** 3;
const gib = (value: number) => Math.round((value / GiB) * 10) / 10;

interface UsageAnswer {
  lines: UsageLineRow[];
  series?: UsageSeries;
  previous?: { egress_bytes: number };
  collectors: Array<{ status: string }>;
  by_node: Array<{ used_bytes: number }>;
}

function read(scenario: "production" | "dense" | "legacy", period = "7d") {
  const table = handlers(scenario);
  const groups = (table["lines/list"]({}) as { groups: LineGroup[] }).groups;
  const usage = table["usage/query"]({ period }) as UsageAnswer;
  return { groups, usage };
}

describe("the production fixture is the 2026-09-29 read", () => {
  it("lists 136 lines on 24 nodes, 101 relay and 34 exit, nothing managed, every line running", () => {
    const { groups } = read("production");
    const lines = groups.flatMap((group) => group.lines);
    expect(groups).toHaveLength(24);
    expect(lines).toHaveLength(136);
    expect(lines.filter((line) => lineRole(line) === "relay")).toHaveLength(101);
    expect(lines.filter((line) => lineRole(line) === "exit")).toHaveLength(34);
    expect(lines.filter((line) => line.managed)).toHaveLength(0);
    expect(lines.every((line) => line.status === "ok" && line.service_state === "running")).toBe(true);
  });

  it("moves 313 GiB of egress in seven days and counts 255 GiB again at the hubs", () => {
    const { usage } = read("production");
    const totals = roleTotals(usage.lines);
    expect(gib(totals.exit)).toBe(271.6);
    expect(gib(totals.direct)).toBe(41.4);
    expect(gib(totals.egress)).toBe(313);
    expect(gib(totals.entry)).toBe(255.3);
    expect(gib(totals.relay)).toBe(0.2);
  });

  it("attributes one of 134 lines, reports 25 collectors, and zeroes the legacy by_node field", () => {
    const { usage } = read("production");
    const summary = attributionSummary(usage.lines);
    expect(summary.lines).toBe(134);
    expect(summary.countedLines).toBe(1);
    expect(usage.lines.filter((row) => row.attribution === "none")).toHaveLength(131);
    expect(usage.collectors).toHaveLength(25);
    expect(usage.collectors.every((row) => row.status === "ok")).toBe(true);
    expect(usage.by_node.every((row) => row.used_bytes === 0)).toBe(true);
  });

  it("sends a series that agrees with the line rows on egress, for 7 and 30 days, and a previous window", () => {
    for (const period of ["7d", "30d"]) {
      const { usage } = read("production", period);
      expect(usage.series?.days).toHaveLength(period === "7d" ? 7 : 30);
      expect(seriesEgressGap(usage.series!, usage.lines)).toBe(0);
      expect(usage.previous?.egress_bytes).toBeGreaterThan(0);
    }
  });
});

describe("dense and legacy", () => {
  it("dense keeps the contract and adds silent collectors, identities and every line state", () => {
    const { groups, usage } = read("dense");
    const lines = groups.flatMap((group) => group.lines);
    expect(lines.length).toBeGreaterThan(136);
    expect(new Set(lines.map((line) => line.service_state))).toEqual(new Set(["running", "down", "restarting"]));
    expect(lines.some((line) => line.status === "error")).toBe(true);
    expect(seriesEgressGap(usage.series!, usage.lines)).toBe(0);
    // One chain target serves its own users too; its bytes are egress.
    const shared = usage.lines.filter((row) => row.role === "shared");
    expect(shared).toHaveLength(1);
    expect(roleTotals(usage.lines).egress).toBe(usage.lines.filter((row) => ["exit", "direct", "shared"].includes(row.role)).reduce((sum, row) => sum + row.used_bytes, 0));
    expect(usage.series!.rows.some((row) => row.role === "shared")).toBe(true);
    expect(usage.series!.rows.every((row) => row.role !== "unknown")).toBe(true);
    expect(usage.collectors.filter((row) => row.status !== "ok")).toHaveLength(2);
    expect(attributionSummary(usage.lines).share).toBeGreaterThan(0.1);
  });

  it("legacy is production from a server without series or previous", () => {
    const { usage } = read("legacy");
    expect(usage.series).toBeUndefined();
    expect(usage.previous).toBeUndefined();
    expect(gib(roleTotals(usage.lines).egress)).toBe(313);
  });
});
