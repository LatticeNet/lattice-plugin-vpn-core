import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

describe("vpn-core frame model", () => {
  it("never reports its own height back to the host", () => {
    // The host frame is a viewport it sizes itself and it ignores the reported
    // number. Measuring the document to say how tall it is costs a full
    // synchronous layout on every body resize and buys nothing.
    const app = read("./App.vue");
    expect(app).not.toContain("ResizeObserver");
    expect(app).not.toContain("bridge?.resize");
    expect(read("./bridge.ts")).not.toContain("lattice.plugin.resize");
  });

  it("pages the fleet lens by node without ever paging the count or the search", () => {
    // The slice is cut from nodeRows, which is the searched whole set, so a
    // pager can never quietly narrow what the page reports on.
    const app = read("./App.vue");
    expect(app).toContain("pageRows(nodeRows.value, nodePage.value, NODE_PAGE_SIZE)");
    expect(app).toContain('v-for="row in nodePageData.rows"');
    // The header counts the whole matching set, never the page.
    expect(app).toContain("{{ nodeRows.length }} {{ nodeRows.length === 1 ? 'node' : 'nodes' }} · {{ fleetSummary.lines }} lines");
    expect(app).not.toContain("nodePageData.rows.length }} shown");
    // A new search invalidates the current page.
    expect(app).toContain("watch(search, () => { nodePage.value = 1; });");
  });

  it("keeps the document as the only vertical scroller", () => {
    // The table box used to cap itself at the viewport height and scroll on
    // its own, which put three scrollers on one page. Lines are paged by node
    // instead; the box may only scroll sideways.
    const styles = read("./styles.css");
    const tableWrap = styles.match(/\.table-wrap \{[^}]*\}/)?.[0] ?? "";
    expect(tableWrap).not.toContain("max-height");
    expect(tableWrap).not.toContain("100dvh");
    expect(tableWrap).toContain("overflow-x: auto");
    const graph = styles.match(/\.topology-graph \{[^}]*\}/)?.[0] ?? "";
    expect(graph).not.toContain("max-height");
  });
});
