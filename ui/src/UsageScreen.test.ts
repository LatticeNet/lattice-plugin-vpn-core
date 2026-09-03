import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vitest";

import UsageScreen from "./UsageScreen.vue";
import type { UsageCollectorRow, UsageLineRow } from "./usageModel";
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
    const html = await render({ lines: [{ ...named, estimate: true }] });
    expect(html).toContain("estimated");
    expect(html).not.toContain(">measured<");
  });

  it("marks a counter the box reported as measured", async () => {
    const html = await render({ lines: [named] });
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
    const html = await render({ lines: [orphan] });
    expect(html).toContain("unknown");
    expect(html).toContain("unattributed");
    // The bytes are reported at full value, not zeroed for want of an owner.
    expect(html).toContain("36.0 GiB");
    expect(html).toContain("real traffic, owner unknown");
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
    });
    expect(html).toContain("unknown line");
    expect(html).toContain("legacy-inbound");
    expect(html).toContain("inbound tag only; no line on this node carries it");
  });
});

describe("the chain overlap is stated where it is shown", () => {
  it("explains the double-counted figure in place instead of reconciling it away", async () => {
    const html = await render({ lines: [named], doubleCounted: 115 * GiB });
    expect(html).toContain("115 GiB");
    expect(html).toContain("counted twice across the fleet, on purpose");
    expect(html).toContain("at the entry line");
  });

  it("omits the explanation when no traffic crossed a chain", async () => {
    const html = await render({ lines: [named], doubleCounted: 0 });
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
    const html = await render({ lines: [named], users: [user] });
    // 119 of 200 GiB rounds to 60.
    expect(html).toContain("60% of 200 GiB");
  });

  it("says no quota is set rather than showing an empty or full bar", async () => {
    const html = await render({ lines: [named], users: [{ ...user, quota_bytes: 0 }] });
    expect(html).toContain("No quota set");
    expect(html).not.toContain("% of");
  });
});

describe("the drill-down capability is stated when absent", () => {
  it("explains what a read-only session is not able to query", async () => {
    const html = await render({ lines: [named], canDrillDown: false });
    expect(html).toContain("cannot run per-identity usage queries");
  });

  it("stays quiet when the session can query", async () => {
    const html = await render({ lines: [named], canDrillDown: true });
    expect(html).not.toContain("cannot run per-identity usage queries");
  });
});
