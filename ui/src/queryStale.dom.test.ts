// @vitest-environment jsdom
/**
 * A query that does not read dims and freezes the rows, never the way out.
 *
 * While the text does not read, the rows answer the last query that did, so
 * the panel is data-stale and inert and nobody acts on a row for a query they
 * cannot see. When that last query kept no rows, the panel holds the
 * no-match state instead; an inert panel there would leave its Clear the
 * query dead exactly when the operator reaches for it. Driven on the real
 * tables with the query's own timers.
 */
import { createApp, h, nextTick, reactive, type App as VueApp, type Component } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ERROR_DELAY_MS, SETTLE_MS } from "@latticenet/plugin-bridge/chassis";

import { handlers } from "../dev/fixtures";
import LinesTable from "./LinesTable.vue";
import type { Profile } from "./profilesModel";
import ProfilesTable from "./ProfilesTable.vue";
import UsersTable from "./UsersTable.vue";
import type { LineGroup, VpnUser } from "./vpnModel";

const dense = handlers("dense");
const groups = (dense["lines/list"]({}) as { groups: LineGroup[] }).groups;
const users = (dense["users/list"]({}) as { users: VpnUser[] }).users;
const profiles = (dense["profiles/query"]({}) as { profiles: Profile[] }).profiles;

let app: VueApp | undefined;
let host: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  host.remove();
  vi.useRealTimers();
});

async function settle(ms: number): Promise<void> {
  await nextTick();
  vi.advanceTimersByTime(ms);
  await nextTick();
  await nextTick();
}

const PAGES: Array<[name: string, component: Component, props: Record<string, unknown>, panel: string, rows: string, total: number]> = [
  ["Lines", LinesTable, { groups, groupBy: "none", traffic: { known: false, byLine: new Map(), egressByLine: new Map(), reportingNodes: new Set() }, periodLabel: "7 days", canOpenEvidence: false }, ".lines-panel", "tr.line-row", groups.reduce((sum, group) => sum + group.lines.length, 0)],
  ["Users", UsersTable, { users, now: Date.parse("2026-10-08T03:00:00Z"), view: "all", groupBy: "none", sort: { key: "identity", reverse: false }, can: { edit: false, rotate: false, bind: false, delete: false } }, ".users-panel", "tr.line-row", users.length],
  ["Node Profiles", ProfilesTable, { profiles }, ".profiles-panel", "tbody tr", profiles.length],
];

describe.each(PAGES)("the %s panel under a query that does not read", (_name, component, props, panelSelector, rowSelector, total) => {
  function mount() {
    const state = reactive({ search: "" });
    app = createApp({ render: () => h(component, { ...props, search: state.search, "onUpdate:search": (value: string) => { state.search = value; } }) });
    app.mount(host);
    const panel = () => host.querySelector<HTMLElement>(panelSelector)!;
    const frozen = () => panel().hasAttribute("inert") || panel().inert === true;
    const rows = () => host.querySelectorAll(rowSelector).length;
    return { state, panel, frozen, rows };
  }

  it("is dimmed and inert while it shows rows", async () => {
    const { state, panel, frozen, rows } = mount();
    await nextTick();
    expect(rows()).toBeGreaterThan(0);
    state.search = "zzqqxxj stat:down";
    await settle(ERROR_DELAY_MS + 50);
    expect(host.querySelector(".pc-query")?.getAttribute("data-invalid")).toBe("true");
    // The rows are the last query that read: the empty one, every row.
    expect(rows()).toBeGreaterThan(0);
    expect(panel().getAttribute("data-stale")).toBe("true");
    expect(frozen()).toBe(true);
  });

  it("stays live over the no-match state, and its Clear the query brings every row back", async () => {
    const { state, panel, frozen, rows } = mount();
    state.search = "zzqqxxj";
    await settle(SETTLE_MS + 50);
    expect(rows()).toBe(0);
    expect(host.querySelector(".empty-state strong")?.textContent).toMatch(/matches this query/);
    state.search = "zzqqxxj stat:down";
    await settle(ERROR_DELAY_MS + 50);
    expect(host.querySelector(".pc-query")?.getAttribute("data-invalid")).toBe("true");
    expect(panel().getAttribute("data-stale")).toBeNull();
    expect(frozen()).toBe(false);
    // It names the query it answers, the last one that read.
    expect(host.querySelector(".empty-state p .mono")?.textContent).toBe("zzqqxxj");
    host.querySelector<HTMLButtonElement>(".empty-state .empty-actions button")!.click();
    await settle(SETTLE_MS + 50);
    expect(state.search).toBe("");
    expect(host.querySelector(".pc-query")?.getAttribute("data-invalid")).toBeNull();
    expect(host.querySelector(".pc-query-count")?.textContent).toBe(`${total}/${total}`);
    expect(rows()).toBeGreaterThan(0);
  });
});
