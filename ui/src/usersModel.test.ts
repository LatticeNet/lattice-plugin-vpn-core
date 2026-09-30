import { describe, expect, it } from "vitest";

import {
  NO_EXPIRY,
  expiryDate,
  expiryInput,
  expiryOf,
  expiryPayload,
  expiryRelative,
  filterLineOptions,
  groupUsers,
  identityState,
  inView,
  lineOptions,
  pageUserTable,
  parseUserSort,
  encodeUserSort,
  rowsHoldUser,
  searchUsers,
  sortUsers,
  userColumns,
  usersAttention,
  usersSummary,
} from "./usersModel";
import type { LineGroup, VpnUser } from "./vpnModel";

const NOW = Date.parse("2026-09-30T08:00:00Z");
const DAY = 86_400_000;
const GiB = 1024 ** 3;
const at = (days: number) => new Date(NOW + days * DAY).toISOString();

function user(id: string, extra: Partial<VpnUser> = {}): VpnUser {
  return {
    id, email: `${id}@example.invalid`, enabled: true,
    credentials: [{ protocol: "vless", has_secret: true }], bindings: [],
    migrated: false, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    expires_at: NO_EXPIRY,
    ...extra,
  };
}

const bound = [{ line_hash_id: "lh_1", enabled: true }];
const day = (date: Date) => date.toISOString().slice(0, 10);

describe("expiry", () => {
  it("reads the server's zero time, absence and junk as no expiry", () => {
    expect(expiryDate(NO_EXPIRY)).toBeUndefined();
    expect(expiryDate(undefined)).toBeUndefined();
    expect(expiryDate("not a date")).toBeUndefined();
    expect(expiryDate("2026-10-31T00:00:00Z")?.toISOString()).toBe("2026-10-31T00:00:00.000Z");
    expect(expiryInput(NO_EXPIRY)).toBe("");
  });

  it("calls within 30 days soon, past it later, and a passed date expired", () => {
    expect(expiryOf(user("a", { expires_at: at(20) }), NOW).kind).toBe("soon");
    expect(expiryOf(user("a", { expires_at: at(30) }), NOW).kind).toBe("soon");
    expect(expiryOf(user("a", { expires_at: at(31) }), NOW).kind).toBe("later");
    expect(expiryOf(user("a", { expires_at: at(-2) }), NOW).kind).toBe("expired");
    expect(expiryOf(user("a"), NOW).kind).toBe("none");
  });

  it("says how far away in whole days", () => {
    expect(expiryRelative(expiryOf(user("a", { expires_at: at(20) }), NOW))).toBe("in 20 days");
    expect(expiryRelative(expiryOf(user("a", { expires_at: at(1) }), NOW))).toBe("in 1 day");
    expect(expiryRelative(expiryOf(user("a", { expires_at: at(0.5) }), NOW))).toBe("within a day");
    expect(expiryRelative(expiryOf(user("a", { expires_at: at(-3) }), NOW))).toBe("3 days ago");
  });

  it("sends nothing for an untouched field, the zero time for an emptied one, the instant otherwise", () => {
    expect(expiryPayload("2026-10-31T08:00", "2026-10-31T08:00")).toBeUndefined();
    expect(expiryPayload("", "")).toBeUndefined();
    expect(expiryPayload("2026-10-31T08:00", "")).toBe(NO_EXPIRY);
    expect(expiryPayload("2026-10-31T08:00", "   ")).toBe(NO_EXPIRY);
    const set = expiryPayload("", "2026-12-31T00:00");
    expect(set && !Number.isNaN(Date.parse(set))).toBe(true);
    expect(set).not.toBe(NO_EXPIRY);
  });
});

describe("one word for an identity", () => {
  it("ranks expired over quota over expiring over no line, and keeps disabled apart", () => {
    expect(identityState(user("a", { enabled: false, expires_at: at(-1) }), NOW).key).toBe("disabled");
    expect(identityState(user("a", { expires_at: at(-1), bindings: bound }), NOW).key).toBe("expired");
    expect(identityState(user("a", { quota_bytes: GiB, used_period_bytes: 2 * GiB, expires_at: at(3) }), NOW).key).toBe("over_quota");
    expect(identityState(user("a", { expires_at: at(3) }), NOW).key).toBe("expiring");
    expect(identityState(user("a"), NOW).key).toBe("unbound");
    expect(identityState(user("a", { bindings: [{ line_hash_id: "x", enabled: false }] }), NOW).key).toBe("unbound");
    expect(identityState(user("a", { bindings: bound }), NOW).key).toBe("active");
  });
});

describe("the collection at a glance", () => {
  const users = [
    user("probe", { bindings: bound, expires_at: at(20), used_total_bytes: 1.2 * GiB, used_period_bytes: 1.2 * GiB }),
    user("m-017", { expires_at: at(9) }),
    user("owner", { quota_bytes: 1024 * GiB, expires_at: at(92) }),
    user("off", { enabled: false, expires_at: at(4) }),
    user("idle"),
  ];

  it("counts only enabled identities toward expiring and unbound, soonest first", () => {
    const summary = usersSummary(users, NOW);
    expect(summary).toMatchObject({ total: 5, enabled: 4, disabled: 1, attributed: 1, withQuota: 1, overQuota: 0 });
    expect(summary.expiring.map((value) => value.id)).toEqual(["m-017", "probe"]);
    expect(summary.unbound.map((value) => value.id).sort()).toEqual(["idle", "m-017", "owner"]);
    expect(summary.states.map((value) => [value.key, value.count])).toEqual([["expiring", 2], ["unbound", 2], ["disabled", 1]]);
  });

  it("lists attention as claim, proof and the view that shows the rows", () => {
    const items = usersAttention(users, NOW, day);
    expect(items.map((item) => [item.key, item.view, item.severity])).toEqual([["expiring", "expiring", "warning"], ["unbound", "unbound", "warning"]]);
    expect(items[0].claim).toBe("2 identities expire within 30 days");
    expect(items[0].evidence).toContain("m-017@example.invalid (2026-10-09)");
    expect(items[1].claim).toBe("3 enabled identities are bound to no line");
  });

  it("puts expired identities first and says nothing when there is nothing", () => {
    const items = usersAttention([user("gone", { expires_at: at(-3), bindings: bound }), user("ok", { bindings: bound })], NOW, day);
    expect(items.map((item) => [item.key, item.severity])).toEqual([["expired", "error"]]);
    expect(usersAttention([user("ok", { bindings: bound })], NOW, day)).toEqual([]);
    expect(usersAttention([], NOW, day)).toEqual([]);
  });

  it("narrows to a view the attention list points at", () => {
    expect(users.filter((value) => inView(value, "expiring", NOW)).map((value) => value.id)).toEqual(["probe", "m-017"]);
    expect(users.filter((value) => inView(value, "unbound", NOW))).toHaveLength(3);
    expect(users.filter((value) => inView(value, "all", NOW))).toHaveLength(5);
  });
});

describe("columns with nothing to show leave for the header", () => {
  it("drops group, expiry, quota and usage when blank on every identity, and says so", () => {
    const { show, notes } = userColumns([user("a"), user("b")], NOW);
    expect(show).toEqual({ group: false, status: false, expires: false, quota: false, lines: false, used: false });
    expect(notes).toEqual(["no identity is in a group", "no identity has an expiry", "no identity has a quota", "no identity is bound to a line", "this server does not report usage per identity"]);
  });

  it("keeps a column one identity fills, and tells unreported usage from none counted", () => {
    const users = [user("a", { group: "metix", used_period_bytes: 0, allocated_nodes: [] }), user("b", { bindings: bound, used_period_bytes: 0 })];
    const { show, notes } = userColumns(users, NOW);
    expect(show.group).toBe(true);
    expect(show.status).toBe(true);
    expect(show.used).toBe(false);
    expect(notes).toContain("no traffic is counted to any identity");
  });
});

describe("search, sort and group", () => {
  const users = [
    user("zed", { group: "metix", credentials: [{ protocol: "trojan", has_secret: true }] }),
    user("amy", { group: "openjobs", expires_at: at(40), bindings: bound }),
    user("bob", { expires_at: at(5), quota_bytes: 10 * GiB, used_period_bytes: 9 * GiB }),
    user("cat", { group: "metix", enabled: false }),
  ];

  it("matches every word across email, group and protocol", () => {
    expect(searchUsers(users, "metix trojan").map((value) => value.id)).toEqual(["zed"]);
    expect(searchUsers(users, "  ")).toHaveLength(4);
  });

  it("reads and writes the sort key, falling back on junk", () => {
    expect(parseUserSort("-expires")).toEqual({ key: "expires", reverse: true });
    expect(parseUserSort("bogus")).toEqual({ key: "identity", reverse: false });
    expect(encodeUserSort({ key: "identity", reverse: false })).toBe("");
    expect(encodeUserSort({ key: "used", reverse: true })).toBe("-used");
  });

  it("keeps identities without the value last in both directions", () => {
    const soonest = sortUsers(users, { key: "expires", reverse: false }, NOW).map((value) => value.id);
    const latest = sortUsers(users, { key: "expires", reverse: true }, NOW).map((value) => value.id);
    expect(soonest).toEqual(["bob", "amy", "cat", "zed"]);
    expect(latest).toEqual(["amy", "bob", "cat", "zed"]);
    expect(sortUsers(users, { key: "status", reverse: false }, NOW).map((value) => value.id)).toEqual(["bob", "zed", "amy", "cat"]);
    expect(sortUsers(users, { key: "group", reverse: false }, NOW).map((value) => value.id)).toEqual(["cat", "zed", "amy", "bob"]);
  });

  it("groups by name with no group last, and by state worst first, each with aggregates", () => {
    const byGroup = groupUsers(sortUsers(users, { key: "identity", reverse: false }, NOW), "group", NOW);
    expect(byGroup.map((group) => [group.label, group.users.length])).toEqual([["metix", 2], ["openjobs", 1], ["no group", 1]]);
    expect(byGroup[0].agg).toMatchObject({ count: 2, enabled: 1, worst: { key: "unbound", count: 1 }, uniformState: false });
    const byState = groupUsers(users, "status", NOW);
    expect(byState.map((group) => group.label)).toEqual(["expiring", "no line", "active", "disabled"]);
    expect(byState[0].agg.nextExpiry?.toISOString()).toBe(at(5));
    expect(groupUsers(users, "none", NOW)).toEqual([]);
  });
});

describe("paging a grouped table by identity", () => {
  const many = Array.from({ length: 121 }, (_, index) => user(`u${String(index).padStart(3, "0")}`));
  const few = [user("a", { bindings: bound }), user("b", { bindings: bound })];
  const groups = groupUsers([...many, ...few], "status", NOW);

  it("cuts a big group across pages and repeats its header as continued", () => {
    const first = pageUserTable({ groups }, 1, 50);
    expect(first.pages).toBe(3);
    expect(first.rows[0]).toMatchObject({ kind: "group", continued: false });
    expect(first.rows.filter((row) => row.kind === "user")).toHaveLength(50);
    expect([first.from, first.to, first.total]).toEqual([1, 50, 123]);
    const second = pageUserTable({ groups }, 2, 50);
    expect(second.rows[0]).toMatchObject({ kind: "group", continued: true });
    const third = pageUserTable({ groups }, 3, 50);
    const labels = third.rows.filter((row) => row.kind === "group").map((row) => row.kind === "group" && [row.group.label, row.continued]);
    expect(labels).toEqual([["no line", true], ["active", false]]);
    expect(rowsHoldUser(third.rows, "b")).toBe(true);
    expect(rowsHoldUser(first.rows, "b")).toBe(false);
  });

  it("holds a folded group as one slot", () => {
    const folded = new Set([groups[0].key]);
    const page = pageUserTable({ groups }, 1, 50, folded);
    expect(page.pages).toBe(1);
    expect(page.rows.map((row) => row.kind)).toEqual(["group", "group", "user", "user"]);
    expect([page.from, page.to]).toEqual([1, 2]);
  });

  it("pages a flat list like any other table", () => {
    const page = pageUserTable({ flat: many }, 3, 50);
    expect(page.rows).toHaveLength(21);
    expect([page.from, page.to, page.total]).toEqual([101, 121, 121]);
  });
});

describe("the line picker", () => {
  const groups: LineGroup[] = [
    { node_id: "n1", node_name: "[cd]-qqpw-VDS-cd1", lines: [
      { id: "1", line_hash_id: "lh_1", node_id: "n1", core: "sing-box", source: "d", managed: false, name: "VLESS-REALITY-62255.json", type: "vless", listen_port: 62255, user_count: 1, user_known: true },
      { id: "2", line_hash_id: "lh_2", node_id: "n1", core: "sing-box", source: "d", managed: false, name: "Hysteria2-7890.json", type: "hysteria2", listen_port: 7890, user_count: 1, user_known: true },
    ] },
    { node_id: "n2", node_name: "[Metix]-DMIT-1", lines: [
      { id: "3", line_hash_id: "lh_3", node_id: "n2", core: "sing-box", source: "d", managed: false, name: "VLESS-REALITY-32426.json", type: "vless", listen_port: 32426, user_count: 1, user_known: true },
    ] },
  ];
  const options = lineOptions(groups);

  it("finds lines by node, protocol or port and leaves bound ones out", () => {
    expect(filterLineOptions(options, "qqpw vless", new Set()).shown.map((option) => option.hash)).toEqual(["lh_1"]);
    expect(filterLineOptions(options, "vless", new Set(["lh_1"])).shown.map((option) => option.hash)).toEqual(["lh_3"]);
    expect(filterLineOptions(options, "7890", new Set()).shown[0]).toMatchObject({ node: "[cd]-qqpw-VDS-cd1", detail: "hysteria2 :7890" });
    const capped = filterLineOptions(options, "", new Set(), 2);
    expect([capped.shown.length, capped.matched]).toEqual([2, 3]);
  });
});
