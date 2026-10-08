/**
 * The four query schemas: what each field reads, that every example on the
 * help card runs, and that the bar's grammar (OR, negation, comparisons,
 * sort) reaches this page's rows the way the console's lists do.
 */
import { describe, expect, it } from "vitest";
import { applyQuery, compileQuery, describeFields, quoteQueryValue, type QuerySchema } from "@latticenet/plugin-bridge/query";

import { handlers } from "../dev/fixtures";
import { lineBytes, type LineTrafficIndex } from "./lineGroups";
import type { Profile } from "./profilesModel";
import {
  LINE_QUERY_EXAMPLES,
  LINE_QUERY_SCHEMA,
  PROFILE_QUERY_EXAMPLES,
  PROFILE_QUERY_SCHEMA,
  USAGE_QUERY_EXAMPLES,
  USAGE_QUERY_SCHEMA,
  USER_QUERY_EXAMPLES,
  lineQueryRows,
  usageQueryRows,
  usersQuerySchema,
  type QueryExample,
} from "./querySchemas";
import { bytesByLine, egressByLine } from "./trafficModel";
import type { UsageLineRow } from "./usageModel";
import { NO_EXPIRY } from "./usersModel";
import type { LineGroup, VpnUser } from "./vpnModel";

const NOW = Date.parse("2026-09-30T08:00:00Z");
const DAY = 86_400_000;
const GiB = 1024 ** 3;

function run<T>(rows: readonly T[], text: string, schema: QuerySchema<T>, now = NOW): T[] {
  const compiled = compileQuery(text, schema);
  if (!compiled.ok) throw new Error(`${text}: ${compiled.error.code} at ${compiled.error.start}`);
  return applyQuery(rows, compiled.query, now);
}

function errorOf<T>(text: string, schema: QuerySchema<T>) {
  const compiled = compileQuery(text, schema);
  return compiled.ok ? undefined : compiled.error;
}

const dense = handlers("dense");
const groups = (dense["lines/list"]({}) as { groups: LineGroup[] }).groups;
const usageLines = (dense["usage/query"]({ period: "7d" }) as { lines: UsageLineRow[] }).lines;
const traffic: LineTrafficIndex = {
  known: true,
  byLine: bytesByLine(usageLines),
  egressByLine: egressByLine(usageLines),
  reportingNodes: new Set(groups.map((group) => group.node_id)),
};
const lines = lineQueryRows(groups, traffic);

describe.each<[string, QuerySchema<never>, QueryExample[], readonly unknown[]]>([
  ["Lines", LINE_QUERY_SCHEMA as QuerySchema<never>, LINE_QUERY_EXAMPLES, lines],
  ["Users", usersQuerySchema(() => NOW) as QuerySchema<never>, USER_QUERY_EXAMPLES, []],
  ["Node Profiles", PROFILE_QUERY_SCHEMA as QuerySchema<never>, PROFILE_QUERY_EXAMPLES, []],
  ["Usage", USAGE_QUERY_SCHEMA as QuerySchema<never>, USAGE_QUERY_EXAMPLES, []],
])("the %s schema", (_page, schema, examples, rows) => {
  it("gives every field names of its own, so none is shadowed by a field listed before it", () => {
    const declared = schema.fields.flatMap((field) => [field.key, ...(field.aliases ?? [])]);
    expect(new Set(declared).size).toBe(declared.length);
    const offered = describeFields(schema, rows as never[]);
    expect(offered.length).toBe(schema.fields.length);
    for (const field of offered) expect(field.hint, field.key).toBeTruthy();
  });

  it("runs every example it shows on the help card", () => {
    expect(examples.length).toBeGreaterThanOrEqual(2);
    for (const example of examples) expect(errorOf(example.query, schema), example.query).toBeUndefined();
  });
});

describe("the Lines query", () => {
  it("reads every line once, heaviest first, with where it leaves and whether it is banked", () => {
    expect(lines).toHaveLength(groups.reduce((sum, group) => sum + group.lines.length, 0));
    const bytes = lines.map((row) => row.bytes ?? -1);
    expect(bytes).toEqual([...bytes].sort((a, b) => b - a));
    expect(lines.some((row) => row.banked)).toBe(true);
    expect(lines.some((row) => !row.banked)).toBe(true);
    // An exit line leaves from its own node.
    const exit = lines.find((row) => row.role === "exit")!;
    expect(exit.leavesAt).toBe(exit.group.node_name || exit.group.node_id);
  });

  it("filters on the line's own fields", () => {
    const exits = run(lines, "role:exit", LINE_QUERY_SCHEMA);
    expect(exits.length).toBe(lines.filter((row) => row.role === "exit").length);
    expect(exits.length).toBeGreaterThan(0);
    expect(run(lines, "port:443", LINE_QUERY_SCHEMA).every((row) => row.line.listen_port === 443)).toBe(true);
    expect(run(lines, "port>=30000", LINE_QUERY_SCHEMA).every((row) => (row.line.listen_port ?? 0) >= 30000)).toBe(true);
    expect(run(lines, "protocol:vless", LINE_QUERY_SCHEMA)).toEqual(run(lines, "type:vless", LINE_QUERY_SCHEMA));
    expect(run(lines, "is:bank", LINE_QUERY_SCHEMA)).toEqual(lines.filter((row) => row.banked));
    // `state:error` reaches "config error" by containment, as an enum word does.
    expect(run(lines, "state:error", LINE_QUERY_SCHEMA)).toEqual(lines.filter((row) => row.state.label === "config error"));
  });

  it("finds a node by exact name the way the overview's node link writes it", () => {
    const node = groups.find((group) => /[\s[\]]/.test(group.node_name ?? ""))?.node_name ?? groups[0].node_name!;
    const found = run(lines, `node:=${quoteQueryValue(node)}`, LINE_QUERY_SCHEMA);
    expect(found.length).toBe(groups.find((group) => group.node_name === node)!.lines.length);
    expect(found.every((row) => row.group.node_name === node)).toBe(true);
  });

  it("takes OR and negation, binding OR tighter than the space", () => {
    const relayOrOrphan = run(lines, "role:relay OR role:orphan", LINE_QUERY_SCHEMA);
    expect(relayOrOrphan).toEqual(run(lines, "-role:exit", LINE_QUERY_SCHEMA));
    const vless = run(lines, "type:vless (role:exit OR -is:bank)", LINE_QUERY_SCHEMA);
    expect(vless.every((row) => row.line.type === "vless" && (row.role === "exit" || !row.banked))).toBe(true);
  });

  it("sorts by traffic with unknown last either way, and by state worst first", () => {
    const withUnknown = lineQueryRows(groups, { ...traffic, reportingNodes: new Set([groups[0].node_id]), byLine: new Map(), egressByLine: new Map() });
    const asc = run(withUnknown, "sort:traffic", LINE_QUERY_SCHEMA);
    expect(asc.at(-1)?.bytes).toBeUndefined();
    expect(run(withUnknown, "sort:-traffic", LINE_QUERY_SCHEMA).at(-1)?.bytes).toBeUndefined();
    const busiest = run(lines, "sort:-traffic", LINE_QUERY_SCHEMA).map((row) => row.bytes ?? 0);
    expect(busiest).toEqual([...busiest].sort((a, b) => b - a));
    const ranks = run(lines, "sort:state", LINE_QUERY_SCHEMA).map((row) => row.state.rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
    expect(lineBytes(traffic, lines[0].line)).toBe(lines[0].bytes);
  });

  it("names the field and offers the near one when a term does not read", () => {
    expect(errorOf("stat:down", LINE_QUERY_SCHEMA)).toMatchObject({ code: "unknownField", start: 0, end: 4, params: { suggestion: "state" } });
    expect(errorOf("port>many", LINE_QUERY_SCHEMA)).toMatchObject({ code: "badNumber" });
    expect(errorOf("role:hub", LINE_QUERY_SCHEMA)).toMatchObject({ code: "unknownValue" });
  });
});

describe("the Users query", () => {
  const user = (id: string, extra: Partial<VpnUser> = {}): VpnUser => ({
    id, email: `${id}@example.invalid`, name: id, enabled: true,
    credentials: [{ protocol: "vless", has_secret: true }], bindings: [{ line_hash_id: "lh_1", enabled: true }],
    migrated: true, created_at: "2026-05-02T09:12:00Z", updated_at: "2026-05-02T09:12:00Z",
    expires_at: NO_EXPIRY, used_total_bytes: 0, used_period_bytes: 0, ...extra,
  });
  const users = [
    user("zed", { group: "metix", credentials: [{ protocol: "trojan", has_secret: true }] }),
    user("amy", { group: "openjobs", expires_at: new Date(NOW + 40 * DAY).toISOString(), bindings: [] }),
    user("bob", { expires_at: new Date(NOW + 5 * DAY).toISOString(), quota_bytes: 10 * GiB, used_period_bytes: 9 * GiB }),
    user("cat", { group: "metix", enabled: false }),
    user("dan", { expires_at: new Date(NOW - 2 * DAY).toISOString(), quota_bytes: 10 * GiB, used_period_bytes: 25 * GiB, last_seen_at: new Date(NOW - 3 * DAY).toISOString() }),
  ];
  const schema = usersQuerySchema(() => NOW);
  const ids = (text: string) => run(users, text, schema).map((value) => value.id);

  it("matches every bare word across email, group and protocol, as the old search did", () => {
    expect(ids("metix trojan")).toEqual(["zed"]);
    expect(ids("  ")).toHaveLength(5);
  });

  it("reads status, quota, expiry and binding on the table's clock", () => {
    expect(ids("status:expiring")).toEqual(["bob"]);
    expect(ids("status:expired")).toEqual(["dan"]);
    // Every condition counts: dan is expired and over quota at once.
    expect(ids('status:"over quota"')).toEqual(["dan"]);
    expect(ids("quota>=80%")).toEqual(["bob", "dan"]);
    expect(ids("quota>100%")).toEqual(["dan"]);
    expect(ids("is:enabled -is:bound")).toEqual(["amy"]);
    expect(ids("-is:enabled")).toEqual(["cat"]);
    expect(ids("expires<2026-10-15")).toEqual(["bob", "dan"]);
    expect(ids("traffic>10GiB")).toEqual(["dan"]);
    expect(ids("last_seen>1d")).toEqual(["dan"]);
  });

  it("sorts soonest expiry first with no expiry last, and status worst first", () => {
    expect(ids("sort:expires")).toEqual(["dan", "bob", "amy", "zed", "cat"]);
    expect(ids("sort:status")[0]).toBe("dan");
    expect(ids("sort:status").at(-1)).toBe("cat");
  });
});

describe("the Node Profiles query", () => {
  const profiles = (dense["profiles/query"]({}) as { profiles: Profile[] }).profiles;

  it("takes the shared node fields, name and id, and only those", () => {
    const keys = describeFields(PROFILE_QUERY_SCHEMA, profiles).map((field) => field.key);
    expect(keys).toContain("name");
    expect(keys).toContain("id");
    expect(keys).not.toContain("status");
    expect(keys).not.toContain("tag");
    const first = profiles[0];
    expect(run(profiles, `id:=${first.node_id}`, PROFILE_QUERY_SCHEMA)).toEqual([first]);
    const names = run(profiles, "sort:name", PROFILE_QUERY_SCHEMA).map((profile) => profile.node_name ?? "");
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })));
  });

  it("finds the nodes that need a look by their own fields", () => {
    const silent = run(profiles, "-collector:ok", PROFILE_QUERY_SCHEMA);
    expect(silent.length).toBeGreaterThan(0);
    expect(silent.every((profile) => profile.collector?.status !== "ok")).toBe(true);
    const pending = run(profiles, "is:managed -is:applied", PROFILE_QUERY_SCHEMA);
    expect(pending).toEqual(profiles.filter((profile) => profile.managed && !profile.applied));
    expect(pending.map((profile) => profile.node_name)).toContain("[cd]-DMIT-eb-wee");
    expect(run(profiles, "version>1.12.4", PROFILE_QUERY_SCHEMA).map((profile) => profile.core_version)).toEqual(["1.12.9"]);
    expect(run(profiles, "issue:discovery", PROFILE_QUERY_SCHEMA).map((profile) => profile.node_name)).toEqual(["[Metix]-DMIT-3"]);
  });
});

describe("the Usage query", () => {
  const rows = usageQueryRows(
    [...usageLines].sort((a, b) => b.used_bytes - a.used_bytes),
    (row) => row.tag || row.line_hash_id || "",
    (row) => row.email || row.user_id || "",
  );

  it("keeps each row's place in the read, so an open row survives a narrower query", () => {
    expect(rows.map((row) => row.index)).toEqual(rows.map((_, index) => index));
    const exits = run(rows, "role:exit", USAGE_QUERY_SCHEMA);
    expect(exits.length).toBeGreaterThan(0);
    expect(exits.every((row) => rows[row.index] === row)).toBe(true);
  });

  it("finds traffic with no owner, by size, and sorts by bytes", () => {
    const ownerless = run(rows, "-user:*", USAGE_QUERY_SCHEMA);
    expect(ownerless.length).toBe(rows.filter((row) => !row.user_id && !row.email).length);
    expect(run(rows, "bytes>1GiB", USAGE_QUERY_SCHEMA).every((row) => row.used_bytes > GiB)).toBe(true);
    const ascending = run(rows, "sort:bytes", USAGE_QUERY_SCHEMA).map((row) => row.used_bytes);
    expect(ascending).toEqual([...ascending].sort((a, b) => a - b));
    expect(run(rows, "is:estimated", USAGE_QUERY_SCHEMA).every((row) => row.estimate)).toBe(true);
  });
});
