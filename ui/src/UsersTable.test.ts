import { createSSRApp, h } from "vue";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vitest";

import ProfilesTable from "./ProfilesTable.vue";
import type { Profile } from "./profilesModel";
import UsersTable from "./UsersTable.vue";
import { NO_EXPIRY, type UserOutcome, type UsersGroupBy, type UsersView } from "./usersModel";
import type { VpnUser } from "./vpnModel";

const NOW = Date.parse("2026-09-30T08:00:00Z");
const DAY = 86_400_000;

function user(id: string, extra: Partial<VpnUser> = {}): VpnUser {
  return {
    id, email: `${id}@example.invalid`, name: id, enabled: true,
    credentials: [{ protocol: "vless", has_secret: true }], bindings: [],
    migrated: true, created_at: "2026-05-02T09:12:00Z", updated_at: "2026-05-02T09:12:00Z",
    expires_at: NO_EXPIRY, used_total_bytes: 0, used_period_bytes: 0, allocated_nodes: [],
    ...extra,
  };
}

const users = [
  user("probe", { group: "probe", bindings: [{ line_hash_id: "lh_1", enabled: true }], expires_at: new Date(NOW + 20 * DAY).toISOString(), used_total_bytes: 1.2 * 1024 ** 3, used_period_bytes: 1.2 * 1024 ** 3 }),
  user("m-1", { group: "metix" }),
  user("m-2", { group: "metix" }),
  user("off", { enabled: false }),
];
const can = { edit: true, rotate: true, bind: true, delete: true };

function render(over: Partial<{ users: VpnUser[]; groupBy: UsersGroupBy; view: UsersView; search: string; outcome: UserOutcome; can: typeof can }> = {}): Promise<string> {
  return renderToString(createSSRApp({
    render: () => h(UsersTable, {
      users, now: NOW, view: "all", search: "", groupBy: "none", sort: { key: "identity", reverse: false }, can, ...over,
    }),
  }));
}

describe("the identities table", () => {
  it("gives a row one open target and one menu, and pins the identity column", async () => {
    const html = await render();
    expect(html).toContain('data-user-open="probe"');
    expect(html).toContain('aria-label="Actions for probe@example.invalid"');
    expect(html).toContain('class="sticky-first line-col"');
    // No per-row icon buttons or chevrons: those were the old table.
    expect(html).not.toContain("Edit identity\"");
    expect(html).not.toContain("row-chevron");
  });

  it("drops a column blank on every identity and says so in the header", async () => {
    const html = await render();
    expect(html).not.toContain(">Quota <");
    expect(html).toContain("no identity has a quota");
    expect(html).toContain(">Expires <");
    expect(html).toContain(">Used <");
  });

  it("puts aggregates on every member column of a group row and hides the column the grouping states", async () => {
    const html = await render({ groupBy: "group" });
    expect(html).toContain("metix");
    expect(html).toContain("2 identities · 2 enabled");
    expect(html).not.toContain(">Group <");
    expect(html).toContain("1 within 30 days");
  });

  it("lists a view the attention list points at and offers the way back", async () => {
    const html = await render({ view: "unbound" });
    expect(html).toContain("2 enabled identities are bound to no line.");
    expect(html).toContain("Show all 4");
    expect(html).not.toContain('data-user-open="probe"');
  });

  it("writes an outcome under the row it concerns, and over the table when that row is gone", async () => {
    const under = await render({ outcome: { userId: "m-1", anchor: "m-1", text: "m-1 saved.", tone: "success" } });
    expect(under.indexOf("m-1 saved.")).toBeGreaterThan(under.indexOf('data-user-open="m-1"'));
    expect(under.indexOf("m-1 saved.")).toBeLessThan(under.indexOf('data-user-open="m-2"'));
    const gone = await render({ outcome: { userId: "x", anchor: "", text: "x deleted.", tone: "success" } });
    expect(gone.indexOf("x deleted.")).toBeLessThan(gone.indexOf("<table"));
  });

  it("shows no menu column to a session that can change nothing", async () => {
    const html = await render({ can: { edit: false, rotate: false, bind: false, delete: false } });
    expect(html).not.toContain("Actions for");
  });
});

describe("the node profiles table", () => {
  const profile = (name: string, extra: Partial<Profile> = {}): Profile => ({
    node_id: `node-${name}`, node_name: name, managed: false, core: "sing-box", core_version: "1.12.4",
    config_path: "/etc/sing-box/config.json", applied: false, inbound_count: 3, discovered_count: 3,
    collector: { source: "singbox_stats_api", status: "ok" }, capabilities: [], ...extra,
  });

  it("keeps only the columns that differ and lists the exception first", async () => {
    const html = await renderToString(createSSRApp({
      render: () => h(ProfilesTable, { profiles: [profile("a"), profile("b"), profile("jnb", { collector: { status: "error", last_error: "connection refused" } })] }),
    }));
    expect(html).toContain("1 node needs a look, listed first");
    expect(html).toContain(">Collector<");
    expect(html).not.toContain(">Core<");
    expect(html).toContain("Every node: sing-box 1.12.4");
    expect(html.indexOf("jnb")).toBeLessThan(html.indexOf('data-profile-open="node-a"'));
  });

  it("narrows to two columns when every other value is shared", async () => {
    const html = await renderToString(createSSRApp({ render: () => h(ProfilesTable, { profiles: [profile("a"), profile("b")] }) }));
    expect(html).toContain('data-compact="true"');
    expect(html).toContain("2 nodes, nothing to fix");
  });
});
