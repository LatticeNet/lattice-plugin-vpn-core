import { describe, expect, it } from "vitest";

import { filterLineGroups, pageRows, sortLineRows, type LineGroup, type LineRow } from "./vpnModel";

const line = (nodeID: string, name: string, users: number) => ({
  id: `${nodeID}-${name}`,
  line_hash_id: `${nodeID}-${name}`,
  node_id: nodeID,
  core: "sing-box",
  source: "discovery",
  managed: false,
  name,
  user_count: users,
  user_known: true,
});

const fleet: LineGroup[] = Array.from({ length: 21 }, (_, node) => ({
  node_id: `node-${String(node).padStart(2, "0")}`,
  node_name: `edge-${String(node).padStart(2, "0")}`,
  lines: Array.from({ length: node < 6 ? 6 : 5 }, (_, slot) =>
    line(`node-${String(node).padStart(2, "0")}`, `line-${slot}`, (node + slot) % 7)),
}));

const rowsOf = (groups: LineGroup[]): LineRow[] =>
  groups.flatMap((group) => group.lines.map((value) => ({ group, line: value })));

describe("pageRows", () => {
  const items = Array.from({ length: 111 }, (_, index) => index);

  it("reports the whole set as the total, not the page", () => {
    const page = pageRows(items, 1, 50);
    expect(page.rows).toHaveLength(50);
    expect(page.total).toBe(111);
    expect(page.pages).toBe(3);
    expect([page.from, page.to]).toEqual([1, 50]);
  });

  it("numbers the last, short page by what it actually holds", () => {
    const page = pageRows(items, 3, 50);
    expect(page.rows).toHaveLength(11);
    expect([page.from, page.to]).toEqual([101, 111]);
  });

  it("clamps a page past either end instead of showing nothing", () => {
    expect(pageRows(items, 99, 50).page).toBe(3);
    expect(pageRows(items, 0, 50).page).toBe(1);
    expect(pageRows(items, Number.NaN, 50).page).toBe(1);
  });

  it("keeps an empty set on page one with a zero range", () => {
    const page = pageRows([], 4, 50);
    expect(page).toMatchObject({ page: 1, pages: 1, from: 0, to: 0, total: 0 });
  });

  it("covers the whole set exactly once across its pages", () => {
    const seen = [1, 2, 3].flatMap((page) => pageRows(items, page, 50).rows);
    expect(seen).toEqual(items);
  });
});

describe("the fleet table pages a set that is already searched and sorted", () => {
  it("counts every match, not the page, and slices the sorted order", () => {
    const all = rowsOf(fleet);
    expect(all).toHaveLength(111);

    const sorted = sortLineRows(all, "users", "desc");
    const first = pageRows(sorted, 1, 50);
    const last = pageRows(sorted, 3, 50);

    // The header reports the whole set from the same array the page is cut from.
    expect(first.total).toBe(111);
    // Sorting is global: the top of page one outranks the bottom of page three.
    expect(first.rows[0].line.user_count).toBeGreaterThanOrEqual(
      last.rows[last.rows.length - 1].line.user_count,
    );
    expect(sorted.slice(100, 111)).toEqual(last.rows);
  });

  it("searches the whole fleet before the page is cut", () => {
    const matched = rowsOf(filterLineGroups(fleet, "edge-07"));
    const page = pageRows(matched, 1, 50);
    expect(page.total).toBe(matched.length);
    expect(page.total).toBeLessThan(111);
    expect(page.rows.every((row) => (row.group.node_name ?? "").includes("edge-07"))).toBe(true);
  });
});
