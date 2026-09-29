import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vitest";

import LinesTable from "./LinesTable.vue";
import type { GroupBy, LineTrafficIndex } from "./lineGroups";
import type { Line, LineGroup } from "./vpnModel";

const GiB = 1024 ** 3;

function line(hash: string, node: string, extra: Partial<Line> = {}): Line {
  return {
    id: hash, line_hash_id: hash, node_id: node, core: "sing-box", source: "discovery", managed: false,
    name: `VLESS-REALITY-${hash}.json`, type: "vless", listen_port: 31001, outbound_ref: "direct",
    user_count: 1, user_known: true, status: "ok", service_state: "running", ...extra,
  };
}

const groups: LineGroup[] = [
  { node_id: "exit", node_name: "[Metix]-VIRCS-ATT-VDS", lines: [line("e1", "exit")] },
  {
    node_id: "hub", node_name: "[Metix]-DMIT-1", lines: [
      line("r1", "hub", { outbound_ref: "to-vircs", outbound_server: "12.22.163.232", outbound_port: 34656, jump_edges: ["e1"] }),
      line("r2", "hub", { listen_port: 31002, outbound_ref: "to-vircs", outbound_server: "12.22.163.232", outbound_port: 34656, jump_edges: ["e1"] }),
    ],
  },
];

function render(traffic: LineTrafficIndex, over: Partial<{ groups: LineGroup[]; search: string; groupBy: GroupBy }> = {}): Promise<string> {
  return renderToString(createSSRApp({
    render: () => h(LinesTable, {
      groups, groupBy: "node", search: "", traffic, periodLabel: "7 days", canOpenEvidence: true, ...over,
    }),
  }));
}

const known: LineTrafficIndex = { known: true, byLine: new Map([["e1", 97.6 * GiB], ["r1", 30 * GiB], ["r2", 10 * GiB]]), reportingNodes: new Set(["exit", "hub"]) };

describe("the Lines table", () => {
  it("says a state every line shares once, in the header, and drops the column", async () => {
    const html = await render(known);
    expect(html).toContain("3 running");
    expect(html).not.toContain(">State<");
  });

  it("keeps the state column when lines differ", async () => {
    const mixed = [groups[0], { ...groups[1], lines: [groups[1].lines[0], { ...groups[1].lines[1], service_state: "down" }] }];
    const html = await render(known, { groups: mixed });
    expect(html).toContain(">State<");
    expect(html).toContain("1 down of 2");
  });

  it("fills every member column on a group row with an aggregate", async () => {
    const html = await render(known);
    expect(html).toContain("2 relay");
    expect(html).toContain("vless 2");
    expect(html).toContain(":31001 to :31002");
    expect(html).toContain("1 node");
    expect(html).toContain("40.0 GiB");
  });

  it("says unknown, never zero, when the usage read failed", async () => {
    const html = await render({ known: false, byLine: new Map(), reportingNodes: new Set() });
    expect(html).toContain(">unknown<");
    expect(html).not.toContain("0 B");
  });

  it("flattens to the matching lines when searched", async () => {
    const html = await render(known, { search: "DMIT" });
    expect(html).toContain("2 of 3 lines match, listed flat");
    expect(html).not.toContain("group-row");
  });

  it("offers one row affordance and keeps evidence in the menu", async () => {
    const html = await render(known);
    expect(html).toContain('aria-haspopup="menu"');
    // No per-row Evidence or Details button: the row opens the panel, the menu holds the rest.
    expect(html).not.toMatch(/<button[^>]*>(<svg[\s\S]*?<\/svg>)?\s*(Evidence|Details)\s*<\/button>/);
  });
});
