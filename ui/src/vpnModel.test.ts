import { describe, expect, it } from "vitest";

import {
  quotaBytesFromInput,
  filterLineGroups,
  formatBytes,
  formatLineDomain,
  formatLineEndpoint,
  formatLineListen,
  lineStatus,
  lineChainTone,
  sortLineRows,
  type LineGroup,
  type LineChain,
  type LineRow,
} from "./vpnModel";

const groups: LineGroup[] = [{
  node_id: "node-hkg",
  node_name: "Hong Kong",
  lines: [{
    id: "line-1", line_hash_id: "line-1", node_id: "node-hkg", core: "sing-box",
    source: "managed", managed: true, name: "Reality 443", type: "vless",
    user_count: 2, user_known: true, status: "ok",
  }],
}];

describe("vpnModel", () => {
  it("filters against node and line fields without mutating the source", () => {
    expect(filterLineGroups(groups, "reality")).toHaveLength(1);
    expect(filterLineGroups(groups, "direct")).toHaveLength(0);
    expect(filterLineGroups(groups, "tokyo")).toHaveLength(0);
    expect(groups[0].lines).toHaveLength(1);
  });

  it("formats traffic values and classifies failures", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MiB");
    expect(lineStatus({ ...groups[0].lines[0], last_error: "probe failed" })).toBe("error");
  });

  it("formats endpoint, listen address, and reality domain with distinct semantics", () => {
    const line = {
      ...groups[0].lines[0],
      public_host: "vpn.example.com",
      listen_host: "0.0.0.0",
      listen_port: 443,
      domain: "reality.example.net",
      outbound_ref: "direct",
      last_error: "certificate mismatch",
    };

    expect(formatLineEndpoint(line)).toBe("vpn.example.com:443");
    expect(formatLineListen(line)).toBe("0.0.0.0:443");
    expect(formatLineDomain(line)).toBe("reality.example.net");
    expect(filterLineGroups([{ ...groups[0], lines: [line] }], "direct")).toHaveLength(1);
    expect(filterLineGroups([{ ...groups[0], lines: [line] }], "certificate mismatch")).toHaveLength(1);
  });

  it("keeps a missing public endpoint distinct from the listen address", () => {
    const line = {
      ...groups[0].lines[0],
      listen_host: "127.0.0.1",
      listen_port: 8443,
      domain: "sni-only.example.net",
    };

    expect(formatLineEndpoint(line)).toBe("-");
    expect(formatLineListen(line)).toBe("127.0.0.1:8443");
    expect(formatLineDomain(line)).toBe("sni-only.example.net");
  });

  it("brackets IPv6 hosts when formatting a port", () => {
    const line = {
      ...groups[0].lines[0],
      public_host: "2001:db8::1",
      listen_host: "::",
      listen_port: 443,
    };

    expect(formatLineEndpoint(line)).toBe("[2001:db8::1]:443");
    expect(formatLineListen(line)).toBe("[::]:443");
  });

  it("keeps chain reconciliation states operator-visible", () => {
    const base: LineChain = { source_line_uuid: "source", status: "converged" };
    expect(lineChainTone(base)).toBe("healthy");
    expect(lineChainTone({ ...base, status: "applying" })).toBe("warning");
    expect(lineChainTone({ ...base, status: "drifted" })).toBe("error");
    expect(lineChainTone({ ...base, status: "failed" })).toBe("error");
  });
});

import { overlayCoverage, overlayTone, rolloutSummaryLine, unresolvedOverlayDefs, type Line, type ManagedLineDef } from "./vpnModel";

describe("managed-line overlay model", () => {
  const def = (over: Partial<ManagedLineDef>): ManagedLineDef => ({
    line_uuid: "uuid", node_id: "node-a", line_hash_id: "line_x", tag: "lattice-mng-24443",
    port: 24443, sni: "www.microsoft.com", user_id: "u1", user_name: "u_ab",
    status: "planned", approval_id: "ap1", created_at: "", updated_at: "", ...over,
  });
  const groupWith = (line: Partial<Line>): LineGroup => ({
    node_id: "node-a",
    lines: [{ id: "l", line_hash_id: "line_x", node_id: "node-a", core: "sing-box", source: "discovered", managed: false, name: "lattice-mng-24443", user_count: 1, user_known: true, ...line } as Line],
  });

  it("maps statuses to semantic tones", () => {
    expect(overlayTone("applied")).toBe("success");
    expect(overlayTone("planned")).toBe("warning");
    expect(overlayTone("failed")).toBe("error");
    expect(overlayTone(undefined)).toBe("info");
  });

  it("counts only applied overlay lines as coverage", () => {
    const groups = [groupWith({ overlay: true, overlay_status: "applied" }), groupWith({})];
    expect(overlayCoverage(groups)).toEqual({ covered: 1, total: 2 });
    expect(overlayCoverage([groupWith({ overlay: true, overlay_status: "planned" })]).covered).toBe(0);
  });

  it("surfaces only defs without a visible line", () => {
    const defs = [def({}), def({ line_uuid: "u2", line_hash_id: "line_y", status: "failed" })];
    expect(unresolvedOverlayDefs(defs, [groupWith({ overlay: true })]).map((d) => d.line_uuid)).toEqual(["u2"]);
    expect(unresolvedOverlayDefs(defs, [])).toHaveLength(2);
  });

  it("summarizes the rollout honestly", () => {
    expect(rolloutSummaryLine({ ok: true, planned: [{} as never, {} as never], skipped: [] })).toContain("2 nodes");
    expect(rolloutSummaryLine({ ok: true, planned: [], skipped: [{ node_id: "n", reason: "x" }] })).toContain("skipped 1");
    expect(rolloutSummaryLine({ ok: true, planned: [], skipped: [] })).toContain("No eligible nodes");
  });
});

describe("sortLineRows", () => {
  const row = (node: string, name: string, over: Partial<Line> = {}): LineRow => ({
    group: { node_id: node, node_name: node, lines: [] },
    line: {
      id: name, line_hash_id: name, node_id: node, core: "sing-box", source: "discovery",
      managed: false, name, user_count: 0, user_known: true, ...over,
    },
  });

  it("orders by node name in both directions", () => {
    const rows = [row("beta", "b"), row("alpha", "a"), row("gamma", "c")];
    expect(sortLineRows(rows, "node", "asc").map((value) => value.group.node_id)).toEqual(["alpha", "beta", "gamma"]);
    expect(sortLineRows(rows, "node", "desc").map((value) => value.group.node_id)).toEqual(["gamma", "beta", "alpha"]);
  });

  it("puts failing lines first when sorting by status ascending", () => {
    const rows = [
      row("n", "ok"),
      row("n", "broken", { last_error: "listen: address in use" }),
      row("n", "pending", { status: "pending" }),
    ];
    expect(sortLineRows(rows, "status", "asc").map((value) => value.line.name)).toEqual(["broken", "pending", "ok"]);
  });

  it("sorts unknown user counts last instead of treating them as zero", () => {
    const rows = [row("n", "five", { user_count: 5 }), row("n", "unknown", { user_known: false }), row("n", "one", { user_count: 1 })];
    expect(sortLineRows(rows, "users", "asc").map((value) => value.line.name)).toEqual(["one", "five", "unknown"]);
  });

  it("returns a stable copy and leaves the input untouched without a key", () => {
    const rows = [row("b", "b"), row("a", "a")];
    const result = sortLineRows(rows, "", "asc");
    expect(result).not.toBe(rows);
    expect(result.map((value) => value.line.name)).toEqual(["b", "a"]);
  });
});

describe("quotaBytesFromInput", () => {
  it("leaves the stored quota alone when the box is blank", () => {
    expect(quotaBytesFromInput("")).toBeUndefined();
    expect(quotaBytesFromInput("   ")).toBeUndefined();
  });

  it("leaves it alone when the box cannot be read as a number", () => {
    // Number("abc") is NaN, and NaN serialises to null, which the server used
    // to take as zero. Neither is an instruction to remove the limit.
    expect(quotaBytesFromInput("abc")).toBeUndefined();
    expect(quotaBytesFromInput("-4")).toBeUndefined();
  });

  it("keeps a zero the operator actually typed, so a quota stays removable", () => {
    expect(quotaBytesFromInput("0")).toBe(0);
  });

  it("converts GiB to bytes", () => {
    expect(quotaBytesFromInput("5")).toBe(5 * 1024 * 1024 * 1024);
    expect(quotaBytesFromInput("1.5")).toBe(Math.round(1.5 * 1024 * 1024 * 1024));
  });
});
