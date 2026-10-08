/**
 * querySchemas.ts, what the query bar on each page can ask about its rows.
 *
 * Lines, Users, Node Profiles and Usage take the console's list query
 * (plugin-bridge `@latticenet/plugin-bridge/query`): bare words search, and
 * `field:value`, comparisons, `OR`, negation and `sort:` work on the fields
 * declared here. Each field reads the row model the page already renders, so
 * a field can never disagree with the cell beside it.
 *
 * A bare word searches exactly the fields the page's old search box searched
 * (oldLinks.test.ts holds the old rules), by substring at the least, so a
 * `?q=` link written for the old box still finds every row it found before.
 * The fields that name a row (`text`) also match a word as a subsequence,
 * the console's fuzzy search, ranked below the substring matches. A small
 * vocabulary repeated on nearly every row (a core, a source, a protocol, a
 * status) is matched by substring only (`bare`): as a subsequence, the
 * `sing-box` on every line would let `sg` match the whole fleet.
 *
 * The node facts vpn-core holds are a node's id and name, nothing else, so
 * the shared node fields are `name` and `id` and only where a row is a node
 * (Node Profiles). Lines and Usage rows are lines and slices of traffic on a
 * node; they say `node:` instead, over the same id and name.
 *
 * Every schema is built once per page: the engine indexes fields by schema.
 */

import { nodeQueryFields, type QueryField, type QuerySchema } from "@latticenet/plugin-bridge/query";

import { buildNodeRows, type LineRole } from "./fleetRows";
import { egressOf, fleetIndex, flatLines, type LineEntry, type LineTrafficIndex } from "./lineGroups";
import { profileIssues, profileRank, type Profile } from "./profilesModel";
import { attributionLabel, roleLabel, type UsageLineRow } from "./usageModel";
import { expiryDate, hasQuota, identityConditions, identityState, isBound } from "./usersModel";
import type { LineGroup, VpnUser } from "./vpnModel";

export interface QueryExample {
  query: string;
  note: string;
}

/** Distinct, non-empty values in first-seen order, for a field's menu. */
function distinct(values: Iterable<string | undefined>): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const text = value?.trim();
    if (text) out.add(text);
  }
  return [...out];
}

function present(...values: Array<string | undefined>): string[] {
  return values.map((value) => value?.trim() ?? "").filter(Boolean);
}

/** A bare word found by substring in one of these, never as a subsequence. The engine hands the word lowercased. */
function containsWord(values: ReadonlyArray<string | undefined>, word: string): boolean {
  return values.some((value) => !!value && value.toLowerCase().includes(word));
}

// ── Lines ────────────────────────────────────────────────────────────────

/** A line as the Lines query reads it: the table's own entry, plus where its traffic leaves and whether it is in a bank. */
export interface LineQueryRow extends LineEntry {
  /** The node or endpoint where this line's traffic leaves the fleet, as the exit grouping names it. */
  leavesAt: string;
  /** One of three or more relays of one protocol on a node, as the bank grouping counts it. */
  banked: boolean;
}

/** Every line, flat, heaviest first: the order the table lists a search in. */
export function lineQueryRows(groups: readonly LineGroup[], traffic?: LineTrafficIndex): LineQueryRow[] {
  const index = fleetIndex(groups);
  const banked = new Set<string>();
  for (const row of buildNodeRows(groups)) for (const bank of row.banks) for (const line of bank.lines) banked.add(line.line_hash_id);
  return flatLines(groups, traffic, groups).map((entry) => ({
    ...entry,
    leavesAt: egressOf(index, entry.group, entry.line).label,
    banked: banked.has(entry.line.line_hash_id),
  }));
}

const LINE_ROLES: readonly LineRole[] = ["exit", "relay", "orphan"];
/* Worst first, as `lineStateOf` ranks them. */
const LINE_STATES = ["down", "config error", "restarting", "pending", "stale", "unproven", "config ok", "running"] as const;

function nodeOfLine(row: LineQueryRow): string {
  return row.group.node_name || row.group.node_id;
}

export const LINE_QUERY_SCHEMA: QuerySchema<LineQueryRow> = {
  fields: [
    { key: "node", type: "string", hint: "Node the line is on, by name or id", get: (row) => present(row.group.node_name, row.group.node_id), sort: nodeOfLine, suggest: (rows) => distinct(rows.map(nodeOfLine)) },
    { key: "line", aliases: ["tag", "name"], type: "string", hint: "Line name, the inbound's tag", get: (row) => row.line.name, suggest: (rows) => distinct(rows.map((row) => row.line.name)) },
    { key: "type", aliases: ["protocol", "proto"], type: "string", hint: "Protocol: vless, trojan, hysteria2", get: (row) => row.line.type, suggest: (rows) => distinct(rows.map((row) => row.line.type)) },
    { key: "port", type: "number", hint: "Listen port", get: (row) => row.line.listen_port },
    { key: "role", type: "enum", values: LINE_ROLES, valueAliases: { none: "orphan" }, hint: "exit, relay, or orphan (no outbound)", get: (row) => row.role },
    { key: "outbound", aliases: ["server", "upstream"], type: "string", hint: "Outbound server or reference the line dials", get: (row) => present(row.line.outbound_server, row.line.outbound_ref), suggest: (rows) => distinct(rows.map((row) => row.line.outbound_server)) },
    { key: "target", type: "string", hint: "Node a relay dials, an endpoint off the fleet, direct, or none", get: (row) => row.target.label, suggest: (rows) => distinct(rows.map((row) => row.target.label)) },
    { key: "egress", type: "string", hint: "Where its traffic leaves the fleet, as Group by exit names it", get: (row) => row.leavesAt, suggest: (rows) => distinct(rows.map((row) => row.leavesAt)) },
    { key: "bank", type: "bool", flag: true, hint: "One of three or more relays of one protocol on a node", get: (row) => row.banked },
    { key: "managed", type: "bool", flag: true, hint: "Rolled out by Lattice", get: (row) => row.line.managed },
    { key: "users", type: "number", hint: "Users the node reports on the line", get: (row) => (row.line.user_known ? row.line.user_count : undefined) },
    { key: "traffic", aliases: ["usage", "bytes"], type: "number", unit: "bytes", hint: "Bytes in the last 7 days; unknown matches nothing", get: (row) => row.bytes },
    { key: "state", type: "enum", values: LINE_STATES, hint: "Config and service together, worst first", get: (row) => row.state.label, sort: (row) => -row.state.rank },
    { key: "host", aliases: ["domain"], type: "string", hint: "Public host, listen host or domain", get: (row) => present(row.line.public_host, row.line.listen_host, row.line.domain) },
    { key: "error", type: "string", hint: "The config error or the probe's note", get: (row) => present(row.line.last_error, row.line.service_note) },
    { key: "id", aliases: ["hash"], type: "string", hint: "Line hash id", get: (row) => row.line.line_hash_id },
  ] satisfies QueryField<LineQueryRow>[],
  // The old search box's fields, one for one (oldLinks.test.ts), split by what they say about a line.
  text: ({ group, line }) => [
    group.node_name, group.node_id, line.name, line.public_host, line.listen_host, line.domain,
    line.outbound_server, line.last_error, line.line_hash_id,
  ],
  bare: ({ line }, word) => containsWord([line.type, line.core, line.source, line.status, line.outbound_ref], word),
};

export const LINE_QUERY_EXAMPLES: QueryExample[] = [
  { query: "role:exit sort:-traffic", note: "Exit lines, busiest first" },
  { query: "-state:running OR is:managed", note: "Lines not running, and every managed line" },
  { query: "type:vless port:443 node:hkg", note: "VLESS on 443 on the hkg nodes" },
];

// ── Users ────────────────────────────────────────────────────────────────

/* Worst first, the order the Status column sorts. */
const USER_STATES = ["expired", "over_quota", "expiring", "unbound", "active", "disabled"] as const;

/** `now` is the table's clock, so a status here is the status on the row. */
export function usersQuerySchema(now: () => number): QuerySchema<VpnUser> {
  return {
    fields: [
      { key: "email", aliases: ["identity", "user"], type: "string", hint: "Sign-in email", get: (user) => user.email },
      { key: "name", type: "string", hint: "Display name", get: (user) => user.name },
      { key: "group", type: "string", hint: "Identity group", get: (user) => user.group, suggest: (users) => distinct(users.map((user) => user.group)) },
      {
        key: "status", type: "enum", values: USER_STATES, valueAliases: { "no line": "unbound", "over quota": "over_quota" },
        hint: "Every condition: expired, over_quota, expiring, unbound, active, disabled",
        get: (user) => identityConditions(user, now()).map((state) => state.key),
        sort: (user) => -identityState(user, now()).rank,
      },
      { key: "enabled", type: "bool", flag: true, hint: "May sign in", get: (user) => user.enabled },
      { key: "expires", aliases: ["expiry"], type: "time", hint: "Expiry; none matches nothing", get: (user) => expiryDate(user.expires_at)?.getTime() },
      { key: "traffic", aliases: ["used", "usage"], type: "number", unit: "bytes", hint: "Bytes counted this quota period", get: (user) => user.used_period_bytes },
      {
        key: "quota", type: "number", unit: "percent", hint: "Share of the quota used; none matches nothing",
        get: (user) => (hasQuota(user) ? Math.round(((user.used_period_bytes ?? 0) / (user.quota_bytes ?? 1)) * 100) : undefined),
      },
      { key: "lines", type: "number", hint: "Lines bound and enabled", get: (user) => (user.bindings ?? []).filter((binding) => binding.enabled).length },
      { key: "bound", type: "bool", flag: true, hint: "Bound to at least one line", get: (user) => isBound(user) },
      { key: "protocol", aliases: ["proto", "credential"], type: "list", hint: "Credential protocols", get: (user) => (user.credentials ?? []).map((credential) => credential.protocol), suggest: (users) => distinct(users.flatMap((user) => (user.credentials ?? []).map((credential) => credential.protocol))) },
      { key: "last_seen", aliases: ["seen"], type: "time", hint: "Last traffic seen", get: (user) => user.last_seen_at || undefined },
      { key: "comment", type: "string", hint: "Comment", get: (user) => user.comment },
      { key: "id", type: "string", hint: "Identity id", get: (user) => user.id },
    ] satisfies QueryField<VpnUser>[],
    // The old search box's fields, one for one (oldLinks.test.ts); the protocols every identity shares match by substring.
    text: (user) => [user.email, user.name, user.id, user.group, user.comment],
    bare: (user, word) => containsWord((user.credentials ?? []).map((credential) => credential.protocol), word),
  };
}

export const USER_QUERY_EXAMPLES: QueryExample[] = [
  { query: "status:expiring sort:expires", note: "Expiring within 30 days, soonest first" },
  { query: "quota>=80%", note: "Near or over quota" },
  { query: "is:enabled -is:bound", note: "Enabled and bound to no line" },
];

// ── Node Profiles ────────────────────────────────────────────────────────

export const PROFILE_QUERY_SCHEMA: QuerySchema<Profile> = {
  fields: [
    { key: "core", type: "string", hint: "sing-box or Xray", get: (profile) => profile.core, suggest: (profiles) => distinct(profiles.map((profile) => profile.core)) },
    { key: "version", type: "version", hint: "Core version", get: (profile) => profile.core_version, suggest: (profiles) => distinct(profiles.map((profile) => profile.core_version)) },
    { key: "managed", type: "bool", flag: true, hint: "Lattice owns the config", get: (profile) => profile.managed },
    { key: "applied", type: "bool", flag: true, hint: "The managed config is applied", get: (profile) => profile.applied },
    { key: "collector", type: "string", hint: "Collector status: ok, error; none matches nothing", get: (profile) => profile.collector?.status, suggest: (profiles) => distinct(profiles.map((profile) => profile.collector?.status)) },
    { key: "source", type: "string", hint: "Where the collector reads usage", get: (profile) => profile.collector?.source, suggest: (profiles) => distinct(profiles.map((profile) => profile.collector?.source)) },
    { key: "inbounds", type: "number", hint: "Inbounds in the config", get: (profile) => profile.inbound_count },
    { key: "discovered", type: "number", hint: "Inbounds discovery found", get: (profile) => profile.discovered_count },
    { key: "path", type: "string", hint: "Config path", get: (profile) => profile.config_path },
    { key: "issue", aliases: ["needs"], type: "string", hint: "What needs a look, as the Needs column says it", get: (profile) => profileIssues(profile).map((issue) => issue.text), sort: (profile) => -profileRank(profile) },
    { key: "capability", type: "list", hint: "Capabilities the node reports", get: (profile) => profile.capabilities, suggest: (profiles) => distinct(profiles.flatMap((profile) => profile.capabilities ?? [])) },
    ...nodeQueryFields<Profile>((profile) => ({ id: profile.node_id, name: profile.node_name }), { only: ["name", "id"] }),
  ],
  text: (profile) => [profile.node_name, profile.node_id, ...profileIssues(profile).map((issue) => issue.text)],
  bare: (profile, word) => containsWord([profile.core, profile.core_version, profile.config_path, profile.collector?.status, profile.collector?.source], word),
};

export const PROFILE_QUERY_EXAMPLES: QueryExample[] = [
  { query: "-collector:ok", note: "Nodes whose collector does not report" },
  { query: "is:managed -is:applied", note: "Managed, config not applied yet" },
  { query: "version<1.12 sort:name", note: "Cores older than 1.12, by name" },
];

// ── Usage, By line ───────────────────────────────────────────────────────

/** A slice of traffic as the Usage query reads it, with the names the table prints. */
export interface UsageQueryRow extends UsageLineRow {
  /** The row's place in the read, a key that survives filtering. */
  index: number;
  /** The line's name where a fleet line carries the hash, else the inbound tag. */
  lineName: string;
  /** The identity's email, or "" when the row has none. */
  userName: string;
}

export function usageQueryRows(rows: readonly UsageLineRow[], lineName: (row: UsageLineRow) => string, userName: (row: UsageLineRow) => string): UsageQueryRow[] {
  return rows.map((row, index) => ({ ...row, index, lineName: lineName(row), userName: userName(row) }));
}

function nodeOfUsage(row: UsageQueryRow): string {
  return row.node_name || row.node_id;
}

export const USAGE_QUERY_SCHEMA: QuerySchema<UsageQueryRow> = {
  fields: [
    { key: "node", type: "string", hint: "Node that reported the bytes, by name or id", get: (row) => present(row.node_name, row.node_id), sort: nodeOfUsage, suggest: (rows) => distinct(rows.map(nodeOfUsage)) },
    { key: "user", aliases: ["identity", "email"], type: "string", hint: "Identity the bytes are placed on; none matches nothing", get: (row) => present(row.userName, row.email, row.user_id), sort: (row) => row.userName || undefined, suggest: (rows) => distinct(rows.map((row) => row.userName)) },
    { key: "line", aliases: ["tag"], type: "string", hint: "Line name, hash or inbound tag", get: (row) => present(row.lineName, row.line_hash_id, row.tag), sort: (row) => row.lineName, suggest: (rows) => distinct(rows.map((row) => row.lineName)) },
    { key: "role", type: "string", hint: "exit, direct, shared, entry or relay", get: (row) => row.role, suggest: (rows) => distinct(rows.map((row) => row.role)) },
    { key: "attribution", type: "string", hint: "How the server placed the bytes", get: (row) => present(attributionLabel(row), row.attribution), suggest: (rows) => distinct(rows.map(attributionLabel)) },
    { key: "bytes", aliases: ["traffic", "used"], type: "number", unit: "bytes", hint: "Bytes in the period", get: (row) => row.used_bytes },
    { key: "up", type: "number", unit: "bytes", hint: "Uplink bytes", get: (row) => row.uplink },
    { key: "down", type: "number", unit: "bytes", hint: "Downlink bytes", get: (row) => row.downlink },
    { key: "estimated", type: "bool", flag: true, hint: "A subtraction, not a counter the box reported", get: (row) => !!row.estimate },
    { key: "counted", type: "bool", flag: true, hint: "Counts to the identity's quota", get: (row) => row.counted },
  ] satisfies QueryField<UsageQueryRow>[],
  text: (row) => [row.node_name, row.node_id, row.lineName, row.line_hash_id, row.tag, row.userName, row.user_id],
  bare: (row, word) => containsWord([roleLabel(row.role), attributionLabel(row)], word),
};

export const USAGE_QUERY_EXAMPLES: QueryExample[] = [
  { query: "role:exit sort:-bytes", note: "Traffic leaving the fleet, largest first" },
  { query: "-user:* bytes>1GiB", note: "Over 1 GiB with no known owner" },
  { query: "is:estimated", note: "Rows the server estimated" },
];
