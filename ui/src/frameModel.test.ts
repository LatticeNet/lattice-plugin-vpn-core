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

  it("pages the fleet table without ever paging the count, the sort or the search", () => {
    // The slice is cut from visibleLines, which is the searched and sorted whole
    // set, so a pager can never quietly narrow what the page reports on.
    const app = read("./App.vue");
    expect(app).toContain("pageRows(visibleLines.value, linePage.value, LINE_PAGE_SIZE)");
    expect(app).toContain('v-for="{ group, line } in linePageData.rows"');
    // The header counts the whole matching set, never the page.
    expect(app).toContain("{{ visibleLines.length }} {{ visibleLines.length === 1 ? 'line' : 'lines' }}");
    expect(app).not.toContain("linePageData.rows.length }} shown");
    // A new search or sort order invalidates the current page.
    expect(app).toContain("watch([search, sortKey, sortDirection], () => { linePage.value = 1; });");
  });
});
