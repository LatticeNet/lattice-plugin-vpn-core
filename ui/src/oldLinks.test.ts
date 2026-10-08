/**
 * A `?q=` link written for the old search boxes still finds what it found.
 *
 * Lines and Users had a plain search before the query bar: Lines matched the
 * whole text as one substring of any of fourteen fields, Users matched every
 * word somewhere in six. Those rules are frozen below as they shipped in
 * 0.11.0-alpha.2 (vpnModel.filterLineGroups, usersModel.searchUsers). The
 * query reads a bare word against the same fields and matches a substring at
 * the least, so for every plain word the new result holds the old one; it
 * may hold more, ranked below, because a bare word also matches a
 * subsequence of a field that names a row. It never matches the fleet whole
 * through a value every row shares, which the last case holds. A word the grammar reads as syntax (`a:b`, a leading `-`,
 * quotes, parentheses, `|`, `*`, upper-case AND, OR, NOT) is a query now,
 * not a plain word, and is out of this promise.
 */
import { describe, expect, it } from "vitest";
import { applyQuery, compileQuery, type QuerySchema } from "@latticenet/plugin-bridge/query";

import { handlers, type Scenario } from "../dev/fixtures";
import { decodePageState } from "./pageState";
import { LINE_QUERY_SCHEMA, lineQueryRows, usersQuerySchema } from "./querySchemas";
import type { LineGroup, VpnUser } from "./vpnModel";

/* ── the old rules, as they shipped ───────────────────────────────────── */

function oldLineSearch(groups: readonly LineGroup[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  return groups.flatMap((group) => group.lines.filter((line) => !needle || [
    group.node_name, group.node_id, line.name, line.type, line.core,
    line.source, line.public_host, line.listen_host, line.domain, line.status,
    line.outbound_ref, line.outbound_server, line.last_error, line.line_hash_id,
  ].some((value) => value?.toLowerCase().includes(needle))).map((line) => line.line_hash_id));
}

function oldUserSearch(users: readonly VpnUser[], query: string): string[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return users.filter((user) => {
    const haystack = [
      user.email, user.name, user.id, user.group, user.comment,
      ...(user.credentials ?? []).map((credential) => credential.protocol),
    ].filter(Boolean).join(" ").toLowerCase();
    return words.every((word) => haystack.includes(word));
  }).map((user) => user.id);
}

/* ── what counts as a plain word ──────────────────────────────────────── */

const KEYWORDS = new Set(["AND", "OR", "NOT"]);
/** No space and nothing the grammar reads: a word an operator typed into a search box. */
function plainWord(word: string): boolean {
  return word.length > 0 && !/[\s:()|,"*\\]/.test(word) && !word.startsWith("-") && !KEYWORDS.has(word);
}
/** Plain words separated by single spaces: the old box's multi-word searches. */
function plainWords(text: string): boolean {
  const words = text.trim().split(/\s+/);
  return words.length > 0 && words.every(plainWord);
}

/** The whole value, each run between separators, and a slice from its middle: what people type. */
function needlesOf(value: string | undefined): string[] {
  const text = value?.trim() ?? "";
  if (!text) return [];
  const out = new Set<string>([text, ...text.split(/[^A-Za-z0-9.@_-]+/)]);
  if (text.length > 6) out.add(text.slice(2, Math.min(text.length - 1, 8)));
  return [...out].filter((needle) => needle.trim().length >= 2);
}

function newResult<T>(rows: readonly T[], schema: QuerySchema<T>, text: string, key: (row: T) => string): string[] {
  const compiled = compileQuery(text, schema);
  if (!compiled.ok) throw new Error(`the old link q=${text} does not read as a query: ${compiled.error.code}`);
  return applyQuery(rows, compiled.query, Date.now()).map(key);
}

const SCENARIOS: Scenario[] = ["production", "dense", "rich", "offfleet", "hubs"];

describe("an old Lines link", () => {
  it.each(SCENARIOS)("finds every line it found before, in the %s fleet", (scenario) => {
    const groups = (handlers(scenario)["lines/list"]({}) as { groups: LineGroup[] }).groups;
    const rows = lineQueryRows(groups);
    const needles = new Set<string>();
    for (const group of groups) {
      for (const value of [group.node_name, group.node_id]) for (const needle of needlesOf(value)) needles.add(needle);
      for (const line of group.lines) {
        for (const value of [line.name, line.type, line.core, line.source, line.public_host, line.listen_host, line.domain,
          line.status, line.outbound_ref, line.outbound_server, line.last_error, line.line_hash_id]) {
          for (const needle of needlesOf(value)) needles.add(needle);
        }
      }
    }
    let checked = 0;
    for (const needle of needles) {
      if (!plainWords(needle)) continue;
      const before = oldLineSearch(groups, needle);
      const after = new Set(newResult(rows, LINE_QUERY_SCHEMA, needle, (row) => row.line.line_hash_id));
      const lost = before.filter((hash) => !after.has(hash));
      expect(lost, `q=${needle}`).toEqual([]);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("reads the links this page's own overview used to write and the ones in its tests", () => {
    const groups = (handlers("dense")["lines/list"]({}) as { groups: LineGroup[] }).groups;
    const rows = lineQueryRows(groups);
    for (const q of ["DMIT", "edge-07", "reality", "vless", "443", "hysteria2", "sing-box", "discovery", "Metix", "DMIT-1", "running"]) {
      const before = oldLineSearch(groups, q);
      const after = new Set(newResult(rows, LINE_QUERY_SCHEMA, q, (row) => row.line.line_hash_id));
      expect(before.filter((hash) => !after.has(hash)), `q=${q}`).toEqual([]);
    }
    // The address hands the old text to the page unchanged.
    expect(decodePageState({ view: "lines", q: "DMIT-1" }).q).toBe("DMIT-1");
  });

  it("still finds an error by its words, which the old box matched as one run", () => {
    const groups: LineGroup[] = [{
      node_id: "node-a", node_name: "edge-a",
      lines: [
        { id: "a", line_hash_id: "a", node_id: "node-a", core: "sing-box", source: "discovery", managed: false, name: "VLESS-1",
          user_count: 0, user_known: true, last_error: "listen tcp :443: bind: address already in use" },
        { id: "b", line_hash_id: "b", node_id: "node-a", core: "sing-box", source: "discovery", managed: false, name: "VLESS-2",
          user_count: 0, user_known: true, outbound_ref: "direct", last_error: "certificate mismatch" },
      ],
    }];
    const rows = lineQueryRows(groups);
    for (const q of ["address already in use", "certificate mismatch", "already"]) {
      const before = oldLineSearch(groups, q);
      expect(before.length, q).toBeGreaterThan(0);
      const after = newResult(rows, LINE_QUERY_SCHEMA, q, (row) => row.line.line_hash_id);
      expect(after, q).toEqual(expect.arrayContaining(before));
    }
  });
});

describe("an old Lines link holding an address or a port", () => {
  it("reads it as text and finds what it found, except a word ending in a colon", () => {
    const line = (id: string, extra: Partial<LineGroup["lines"][number]>) => ({
      id, line_hash_id: id, node_id: "node-a", core: "sing-box", source: "discovery", managed: false, name: `VLESS-${id}`,
      user_count: 0, user_known: true, ...extra,
    });
    const groups: LineGroup[] = [{
      node_id: "node-a", node_name: "edge-a",
      lines: [
        line("v6", { public_host: "2001:db8::1", listen_host: "::" }),
        line("ep", { public_host: "vpn.example.com", outbound_server: "12.22.163.232", last_error: "listen tcp :443: bind: address already in use" }),
      ],
    }];
    const rows = lineQueryRows(groups);
    for (const q of ["2001:db8::1", "2001:db8", "listen tcp :443", ":443", "12.22.163.232", "vpn.example.com"]) {
      const before = oldLineSearch(groups, q);
      expect(before.length, q).toBeGreaterThan(0);
      expect(newResult(rows, LINE_QUERY_SCHEMA, q, (row) => row.line.line_hash_id), q).toEqual(expect.arrayContaining(before));
    }
    // A word that ends in a colon reads as a field now: the bar names it and offers the near one.
    const pasted = compileQuery("bind: address", LINE_QUERY_SCHEMA);
    expect(pasted.ok).toBe(false);
  });
});

describe("a short word", () => {
  it("narrows the fleet instead of matching every line through a value they all share", () => {
    const groups = (handlers("dense")["lines/list"]({}) as { groups: LineGroup[] }).groups;
    const rows = lineQueryRows(groups);
    // Every line runs sing-box, which holds s then g; the old box found the SG nodes only.
    for (const q of ["sg", "hk", "sb"]) {
      const before = oldLineSearch(groups, q);
      const after = newResult(rows, LINE_QUERY_SCHEMA, q, (row) => row.line.line_hash_id);
      expect(after.length, q).toBeLessThan(rows.length / 2);
      expect(after.slice(0, before.length).sort(), `${q} ranks the old matches first`).toEqual([...before].sort());
    }
  });
});

describe("an old Users link", () => {
  it.each(["production", "dense", "rich"] as Scenario[])("finds every identity it found before, in the %s scenario", (scenario) => {
    const users = (handlers(scenario)["users/list"]({}) as { users: VpnUser[] }).users;
    expect(users.length).toBeGreaterThan(0);
    const schema = usersQuerySchema(() => Date.now());
    const needles = new Set<string>();
    for (const user of users) {
      for (const value of [user.email, user.name, user.id, user.group, user.comment, ...(user.credentials ?? []).map((c) => c.protocol)]) {
        for (const needle of needlesOf(value)) needles.add(needle);
      }
    }
    // Two words from different fields, which the old box matched across the joined text.
    needles.add(`${users[0].group ?? users[0].name ?? "x"} ${users[0].credentials?.[0]?.protocol ?? "vless"}`);
    let checked = 0;
    for (const needle of needles) {
      if (!plainWords(needle)) continue;
      const before = oldUserSearch(users, needle);
      const after = new Set(newResult(users, schema, needle, (user) => user.id));
      expect(before.filter((id) => !after.has(id)), `q=${needle}`).toEqual([]);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(10);
  });
});
