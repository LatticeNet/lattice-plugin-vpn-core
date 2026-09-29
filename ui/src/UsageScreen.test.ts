import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vitest";

import UsageScreen from "./UsageScreen.vue";
import type { UsagePrevious, UsageSeries } from "./trafficModel";
import type { UsageCollectorRow, UsageLineRow, UsageView } from "./usageModel";
import type { LineGroup, VpnUser } from "./vpnModel";

const GiB = 1024 ** 3;

function render(over: Partial<{
  lines: UsageLineRow[];
  doubleCounted: number;
  period: string;
  from?: string;
  to?: string;
  collectors: UsageCollectorRow[];
  groups: LineGroup[];
  users: VpnUser[];
  canDrillDown: boolean;
  busy: boolean;
  failed: boolean;
  series: UsageSeries;
  previous: UsagePrevious;
  view: UsageView;
  canOpenUsers: boolean;
}> = {}): Promise<string> {
  return renderToString(createSSRApp({
    render: () => h(UsageScreen, {
      lines: [], doubleCounted: 0, period: "30d", from: "20260804", to: "20260902",
      collectors: [], groups: [], users: [], canDrillDown: true, busy: false, failed: false,
      ...over,
    }),
  }));
}

const named: UsageLineRow = {
  node_id: "node-a", node_name: "hkg-edge-01", line_hash_id: "lh_0000", tag: "vless-in-443",
  role: "entry", uplink: 31 * GiB, downlink: 88 * GiB, used_bytes: 119 * GiB,
  attribution: "named", attribution_proof: "proof",
  attribution_reason: "user counter on this line folds to this identity",
  user_id: "u_ops", email: "ops@example.invalid", counted: true,
};

describe("a figure never appears without saying how good it is", () => {
  it("marks an estimated row as estimated rather than folding it into a measurement", async () => {
    const html = await render({ lines: [{ ...named, estimate: true }], view: "line" });
    expect(html).toContain("estimated");
    expect(html).not.toContain(">measured<");
  });

  it("marks a counter the box reported as measured", async () => {
    const html = await render({ lines: [named], view: "line" });
    expect(html).toContain("measured");
  });
});

describe("unattributed traffic is real traffic with an unknown owner", () => {
  const orphan: UsageLineRow = {
    node_id: "node-b", node_name: "fra-exit-01", line_hash_id: "lh_0005", tag: "vless-in-443",
    role: "direct", uplink: 9 * GiB, downlink: 27 * GiB, used_bytes: 36 * GiB,
    attribution: "none", attribution_reason: "inbound bytes beyond the named user counters",
    candidates: ["u_ops", "u_lab"], counted: false,
  };

  it("says the identity is unknown and never prints a zero for it", async () => {
    const html = await render({ lines: [orphan], view: "line" });
    expect(html).toContain("unknown");
    expect(html).toContain("unattributed");
    // The bytes are reported at full value, not zeroed for want of an owner.
    expect(html).toContain("36.0 GiB");
    const byUser = await render({ lines: [orphan], view: "user" });
    expect(byUser).toContain("real traffic, owner unknown");
  });

  it("keeps a row the server could not place on any line visible and named", async () => {
    const html = await render({
      lines: [{
        node_id: "node-c", tag: "legacy-inbound", role: "direct",
        uplink: 1 * GiB, downlink: 4 * GiB, used_bytes: 5 * GiB,
        attribution: "unknown_line",
        attribution_reason: "no line on this node carries this inbound tag",
        counted: false,
      }],
      view: "line",
    });
    expect(html).toContain("unknown line");
    expect(html).toContain("legacy-inbound");
    expect(html).toContain("inbound tag only; no line on this node carries it");
  });
});

describe("the chain overlap is stated where it is shown", () => {
  it("explains the double-counted figure in place instead of reconciling it away", async () => {
    const html = await render({ lines: [named], doubleCounted: 115 * GiB, view: "node" });
    expect(html).toContain("115 GiB");
    expect(html).toContain("counted twice across the fleet, on purpose");
    expect(html).toContain("at the entry line");
  });

  it("omits the explanation when no traffic crossed a chain", async () => {
    const html = await render({ lines: [named], doubleCounted: 0, view: "node" });
    expect(html).not.toContain("counted twice across the fleet");
  });
});

describe("a failed read says unknown, never zero", () => {
  it("refuses to print 0 B for figures it does not have", async () => {
    const html = await render({ failed: true });
    expect(html).toContain("unknown");
    expect(html).not.toContain("0 B");
    expect(html).toContain("This is not an empty result");
    expect(html).toContain("not because nothing happened");
  });

  it("reads an empty but successful period as an empty period", async () => {
    const html = await render({ failed: false, collectors: [{ node_id: "node-a", status: "ok" }] });
    expect(html).toContain("No traffic in last 30 days");
    expect(html).toContain("Collectors are reporting");
    expect(html).not.toContain("This is not an empty result");
  });

  it("says an unmeasured fleet is unmeasured, not quiet, when no collector exists", async () => {
    const html = await render({ collectors: [] });
    expect(html).toContain("No node is configured to report usage");
    expect(html).toContain("unmeasured");
    // The headline says unknown too; a zero would be a figure nobody measured.
    expect(html).toContain("no node reports usage, so nothing was measured");
    expect(html).not.toContain("0 B");
  });
});

describe("a node that is not reporting is named", () => {
  it("lists the silent nodes and says their traffic is unknown rather than zero", async () => {
    const html = await render({
      lines: [named],
      collectors: [
        { node_id: "node-a", node_name: "hkg-edge-01", status: "ok" },
        { node_id: "node-z", node_name: "nrt-edge-01", status: "error" },
      ],
    });
    expect(html).toContain("nrt-edge-01");
    expect(html).toContain("did not report usage for this period");
    expect(html).toContain("unknown, not zero");
  });
});

describe("a quota is shown against what the period counted", () => {
  const user: VpnUser = {
    id: "u_ops", email: "ops@example.invalid", enabled: true, credentials: [], bindings: [],
    quota_bytes: 200 * GiB, migrated: false,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };

  it("renders the percentage against the quota the identity carries", async () => {
    const html = await render({ lines: [named], users: [user], view: "user" });
    // 119 of 200 GiB rounds to 60.
    expect(html).toContain("60% of 200 GiB");
  });

  it("says no quota is set rather than showing an empty or full bar", async () => {
    const html = await render({ lines: [named], users: [{ ...user, quota_bytes: 0 }], view: "user" });
    expect(html).toContain("No quota set");
    expect(html).not.toContain("% of");
  });
});

describe("the drill-down capability is stated when absent", () => {
  it("explains what a read-only session is not able to query", async () => {
    const html = await render({ lines: [named], canDrillDown: false, view: "line" });
    expect(html).toContain("cannot run per-identity usage queries");
  });

  it("stays quiet when the session can query", async () => {
    const html = await render({ lines: [named], canDrillDown: true, view: "line" });
    expect(html).not.toContain("cannot run per-identity usage queries");
  });
});

function lineRow(node: string, role: string, gib: number, extra: Partial<UsageLineRow> = {}): UsageLineRow {
  return {
    node_id: node, node_name: `[Metix]-${node}`, line_hash_id: `lh_${node}_${role}`, tag: "in", role,
    uplink: 0, downlink: gib * GiB, used_bytes: gib * GiB, attribution: "none", counted: false, ...extra,
  };
}
const week = [
  lineRow("VIRCS-ATT-VDS", "exit", 97.6),
  lineRow("Aaitr-Frontier-VDS", "exit", 55),
  lineRow("DMIT-1", "direct", 6),
  lineRow("DMIT-1", "entry", 140),
  lineRow("qqpw-VDS-cd1", "direct", 0.3, { user_id: "u_probe", email: "probe@lattice.invalid", attribution: "named", counted: true }),
];
const collectors = [{ node_id: "VIRCS-ATT-VDS", status: "ok" }, { node_id: "DMIT-1", status: "ok" }];

describe("the overview leads with egress", () => {
  it("heads the page with exit plus direct bytes, never the hub entry bytes", async () => {
    const html = await render({ lines: week, collectors, period: "7d" });
    // 97.6 + 55 + 6 + 0.3 = 158.9 GiB of egress; the 140 GiB of entry is not in it.
    expect(html).toContain("159 GiB");
    expect(html).toContain("left the fleet in the last 7 days");
    expect(html).toContain("Relay hubs counted another 140 GiB as it entered them");
    expect(html).not.toContain("299 GiB");
  });

  it("states the change against the previous window when the server sends one", async () => {
    const html = await render({ lines: week, collectors, period: "7d", previous: { from: "20260916", to: "20260922", egress_bytes: 141.9 * GiB } });
    expect(html).toContain("+12%");
    expect(html).toContain("against the previous 7 days");
    expect(html).toContain("2026-09-16 to 2026-09-22");
  });

  it("draws the daily stack from the series, with the stacking choice", async () => {
    const series: UsageSeries = {
      days: ["20260928", "20260929"],
      rows: [{ node_id: "VIRCS-ATT-VDS", node_name: "[Metix]-VIRCS-ATT-VDS", role: "exit", bytes: [40 * GiB, 57.6 * GiB] }],
    };
    const html = await render({ lines: week, collectors, period: "7d", series });
    expect(html).toContain("Daily egress by exit");
    expect(html).toContain("Stack by");
    expect(html).not.toContain("needs a newer server");
  });

  it("falls back to per-exit totals and says why when the server sends no series", async () => {
    const html = await render({ lines: week, collectors, period: "7d" });
    expect(html).toContain("The daily view needs a newer server");
    expect(html).toContain("exit-bars");
    expect(html).toContain("97.6 GiB");
    expect(html).not.toContain("Stack by");
  });

  it("puts measurement quality on the proof line", async () => {
    const html = await render({ lines: week, collectors, period: "7d" });
    expect(html).toContain("2 of 2 collectors ok");
    expect(html).toContain("1 of 5 lines attributed");
  });
});

describe("By user opens with the attribution fact when little carries an identity", () => {
  it("says how much carries an identity and offers Users", async () => {
    const html = await render({ lines: week, collectors, period: "7d", view: "user", canOpenUsers: true });
    expect(html).toContain("1 of 5 lines and 0.1% of the bytes in the last 7 days carry an identity");
    expect(html).toContain("Open Users");
  });

  it("does not lead with the fact when most bytes carry an identity", async () => {
    const html = await render({ lines: [named], collectors, view: "user" });
    expect(html).not.toContain("carry an identity.");
  });
});
