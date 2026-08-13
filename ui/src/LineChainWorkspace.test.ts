import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vitest";

import LineChainWorkspace from "./LineChainWorkspace.vue";
import type { Line, LineGroup } from "./vpnModel";

function line(uuid: string, jumpEdges: string[], declaredEdges: string[]): Line {
  return {
    id: uuid, line_hash_id: uuid, line_uuid: uuid, node_id: "node-a", core: "sing-box",
    source: "discovery", managed: false, name: uuid, user_count: 0, user_known: true,
    jump_edges: jumpEdges, declared_jump_edges: declaredEdges,
  };
}

describe("LineChainWorkspace canonical table", () => {
  it("renders declared, inferred, and unresolved discovery evidence with screen-reader parity", async () => {
    const groups: LineGroup[] = [{
      node_id: "node-a",
      lines: [
        line("source", ["resolved", "missing"], ["resolved"]),
        line("resolved", [], []),
      ],
    }];
    const html = await renderToString(createSSRApp({
      render: () => h(LineChainWorkspace, {
        groups, chains: [], canPlan: false, canRemove: false, busySources: new Set<string>(),
      }),
    }));

    expect(html).toContain("Canonical line topology state");
    expect(html).toContain("Discovery evidence");
    expect(html).toContain('aria-label="Discovered topology evidence"');
    expect(html).toContain("declared");
    expect(html).toContain("inferred");
    expect(html).toContain("missing<span> · unresolved</span>");
    expect(html).toContain("committed, observed, declared, and inferred evidence");
  });
});
