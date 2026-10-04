import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lineRole } from "../src/fleetRows";
import { attributionSummary, roleTotals, seriesEgressGap, type UsageSeries } from "../src/trafficModel";
import type { UsageLineRow } from "../src/usageModel";
import { NO_EXPIRY, expiryOf, isAttributed, isBound, usersSummary } from "../src/usersModel";
import type { LineGroup, VpnUser } from "../src/vpnModel";
import { handlers, resetUserStores } from "./fixtures";

const GiB = 1024 ** 3;
const gib = (value: number) => Math.round((value / GiB) * 10) / 10;

interface UsageAnswer {
  lines: UsageLineRow[];
  series?: UsageSeries;
  previous?: { egress_bytes: number };
  collectors: Array<{ status: string }>;
  by_node: Array<{ used_bytes: number }>;
}

function read(scenario: "production" | "dense" | "legacy", period = "7d") {
  const table = handlers(scenario);
  const groups = (table["lines/list"]({}) as { groups: LineGroup[] }).groups;
  const usage = table["usage/query"]({ period }) as UsageAnswer;
  return { groups, usage };
}

describe("the production fixture is the 2026-09-29 read", () => {
  it("lists 136 lines on 24 nodes, 101 relay and 34 exit, nothing managed, every line running", () => {
    const { groups } = read("production");
    const lines = groups.flatMap((group) => group.lines);
    expect(groups).toHaveLength(24);
    expect(lines).toHaveLength(136);
    expect(lines.filter((line) => lineRole(line) === "relay")).toHaveLength(101);
    expect(lines.filter((line) => lineRole(line) === "exit")).toHaveLength(34);
    expect(lines.filter((line) => line.managed)).toHaveLength(0);
    expect(lines.every((line) => line.status === "ok" && line.service_state === "running")).toBe(true);
  });

  it("moves 313 GiB of egress in seven days and counts 255 GiB again at the hubs", () => {
    const { usage } = read("production");
    const totals = roleTotals(usage.lines);
    expect(gib(totals.exit)).toBe(271.6);
    expect(gib(totals.direct)).toBe(41.4);
    expect(gib(totals.egress)).toBe(313);
    expect(gib(totals.entry)).toBe(255.3);
    expect(gib(totals.relay)).toBe(0.2);
  });

  it("attributes one of 134 lines, reports 25 collectors, and zeroes the legacy by_node field", () => {
    const { usage } = read("production");
    const summary = attributionSummary(usage.lines);
    expect(summary.lines).toBe(134);
    expect(summary.countedLines).toBe(1);
    expect(usage.lines.filter((row) => row.attribution === "none")).toHaveLength(131);
    expect(usage.collectors).toHaveLength(25);
    expect(usage.collectors.every((row) => row.status === "ok")).toBe(true);
    expect(usage.by_node.every((row) => row.used_bytes === 0)).toBe(true);
  });

  it("sends a series that agrees with the line rows on egress, for 7 and 30 days, and a previous window", () => {
    for (const period of ["7d", "30d"]) {
      const { usage } = read("production", period);
      expect(usage.series?.days).toHaveLength(period === "7d" ? 7 : 30);
      expect(seriesEgressGap(usage.series!, usage.lines)).toBe(0);
      expect(usage.previous?.egress_bytes).toBeGreaterThan(0);
    }
  });
});

describe("dense and legacy", () => {
  it("dense keeps the contract and adds silent collectors, identities and every line state", () => {
    const { groups, usage } = read("dense");
    const lines = groups.flatMap((group) => group.lines);
    expect(lines.length).toBeGreaterThan(136);
    expect(new Set(lines.map((line) => line.service_state))).toEqual(new Set(["running", "down", "restarting"]));
    expect(lines.some((line) => line.status === "error")).toBe(true);
    expect(seriesEgressGap(usage.series!, usage.lines)).toBe(0);
    // One chain target serves its own users too; its bytes are egress.
    const shared = usage.lines.filter((row) => row.role === "shared");
    expect(shared).toHaveLength(1);
    expect(roleTotals(usage.lines).egress).toBe(usage.lines.filter((row) => ["exit", "direct", "shared"].includes(row.role)).reduce((sum, row) => sum + row.used_bytes, 0));
    expect(usage.series!.rows.some((row) => row.role === "shared")).toBe(true);
    expect(usage.series!.rows.every((row) => row.role !== "unknown")).toBe(true);
    expect(usage.collectors.filter((row) => row.status !== "ok")).toHaveLength(2);
    expect(attributionSummary(usage.lines).share).toBeGreaterThan(0.1);
  });

  it("legacy is production from a server without series or previous", () => {
    const { usage } = read("legacy");
    expect(usage.series).toBeUndefined();
    expect(usage.previous).toBeUndefined();
    expect(gib(roleTotals(usage.lines).egress)).toBe(313);
  });
});

describe("identities", () => {
  beforeEach(resetUserStores);
  const list = (scenario: "production" | "dense" | "empty") => (handlers(scenario)["users/list"]({}) as { users: VpnUser[] }).users;

  it("production is the 2026-09-30 read: 134 identities, 122 enabled, usage attributed to 1, 2 expiring within 30 days", () => {
    const users = list("production");
    const summary = usersSummary(users, Date.now());
    expect(summary.total).toBe(134);
    expect(summary.enabled).toBe(122);
    expect(users.filter(isAttributed).map((user) => user.email)).toEqual(["probe@lattice.invalid"]);
    expect(summary.expiring).toHaveLength(2);
    expect(users.filter(isBound)).toHaveLength(1);
    expect(summary.unbound).toHaveLength(121);
    // As the server writes them: zero time for no expiry, zero usage for nothing counted.
    expect(users.filter((user) => user.expires_at === NO_EXPIRY).length).toBeGreaterThan(120);
    expect(users.every((user) => user.used_period_bytes !== undefined && Array.isArray(user.allocated_nodes))).toBe(true);
    expect([...users].map((user) => user.email)).toEqual([...users].map((user) => user.email).sort());
  });

  it("dense holds every identity state", () => {
    const summary = usersSummary(list("dense"), Date.now());
    expect(summary.states.map((state) => state.key).sort()).toEqual(["active", "disabled", "expired", "expiring", "over_quota", "unbound"].sort());
    expect(summary.attributed).toBeGreaterThan(3);
  });

  it("empty has none", () => {
    expect(list("empty")).toEqual([]);
  });

  it("keeps an edit until the harness reloads, with the server's rules", () => {
    const table = handlers("production");
    const probe = list("production").find((user) => user.id === "u_probe")!;
    expect(expiryOf(probe, Date.now()).kind).toBe("soon");
    table["users-admin/update"]({ id: "u_probe", email: "", name: "Liveness probe", group: "probe", comment: "", expires_at: NO_EXPIRY });
    expect(expiryOf(list("production").find((user) => user.id === "u_probe")!, Date.now()).kind).toBe("none");
    expect(() => table["users-admin/bind"]({ user_id: "u_cdcd", line_hash_id: "lh_nope" })).toThrow(/not a known line/);
    const hash = (table["lines/list"]({}) as { groups: LineGroup[] }).groups[0].lines[0].line_hash_id;
    table["users-admin/bind"]({ user_id: "u_cdcd", line_hash_id: hash });
    expect(list("production").find((user) => user.id === "u_cdcd")!.bindings).toEqual([{ line_hash_id: hash, enabled: true }]);
    table["users-admin/delete"]({ id: "u_migrated_5" });
    expect(list("production")).toHaveLength(133);
  });
});

describe("identity links answer like the server", () => {
  beforeEach(resetUserStores);
  afterEach(() => vi.useRealTimers());

  type Line = { line_hash_id: string; protocol?: string; reason?: string; fix?: string };
  const status = (id: string) => handlers("dense")["users-admin/link_get"]({ user_id: id }) as { included: Line[]; excluded: Line[]; answer_reason: string };

  it("leaves a rotated protocol's lines out until a plan filed after the rotation lands", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-04T08:00:00Z"));
    expect(status("u_cdcd").excluded.filter((line) => line.reason === "rotation_not_applied")).toEqual([]);
    const vless = status("u_cdcd").included.filter((line) => line.protocol === "vless").map((line) => line.line_hash_id);
    expect(vless.length).toBeGreaterThan(1);

    handlers("dense")["users-admin/rotate"]({ user_id: "u_cdcd", protocol: "vless" });
    const after = status("u_cdcd");
    const rotatedOut = after.excluded.filter((line) => line.reason === "rotation_not_applied").length;
    expect(rotatedOut).toBeGreaterThanOrEqual(vless.length);
    for (const hash of vless) {
      expect(after.excluded.find((line) => line.line_hash_id === hash)).toMatchObject({ reason: "rotation_not_applied", fix: "plan_update" });
    }

    const first = handlers("dense")["users-admin/plan_update"]({ user_id: "u_cdcd", line_hash_id: vless[0] }) as { approval: { id: string } };
    const second = handlers("dense")["users-admin/plan_update"]({ user_id: "u_cdcd", line_hash_id: vless[1] }) as { approval: { id: string } };
    expect(first.approval.id).toMatch(/^apr_upd_[a-z0-9]{8}$/);
    expect(second.approval.id).not.toBe(first.approval.id);

    vi.setSystemTime(Date.parse("2026-10-04T08:00:21Z"));
    const landed = status("u_cdcd");
    expect(landed.included.map((line) => line.line_hash_id)).toEqual(expect.arrayContaining([vless[0], vless[1]]));
    expect(landed.excluded.filter((line) => line.reason === "rotation_not_applied").length).toBe(rotatedOut - 2);
  });

  it("names plan_update for a credential never applied, as the server does", () => {
    const fixes = Object.values(Object.fromEntries(["u_cdcd", "u_lab", "u_team_2"].flatMap((id) => status(id).excluded)
      .filter((line) => line.reason === "credential_not_applied").map((line) => [line.line_hash_id, line.fix])));
    expect(fixes.length).toBeGreaterThan(0);
    expect(new Set(fixes)).toEqual(new Set(["plan_update"]));
  });

  it("serves nothing for an expired link until its expiry is cleared", () => {
    const users = (handlers("dense")["users/list"]({}) as { users: Array<{ id: string; link: { expires_at?: string } | null }> }).users;
    const expired = users.find((user) => user.link?.expires_at);
    expect(expired).toBeDefined();
    expect(status(expired!.id).answer_reason).toBe("link_expired");
    handlers("dense")["users-admin/link_set"]({ user_id: expired!.id, clear_expiry: true });
    expect(status(expired!.id).answer_reason).not.toBe("link_expired");
  });
});
