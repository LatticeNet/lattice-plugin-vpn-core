import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PAGE_STATE,
  PAGE_STATE_MAX_VALUE_LENGTH,
  createStateSender,
  decodePageState,
  encodePageState,
  filterPageState,
  pageStateKey,
  validPageState,
  type PageState,
  type VpnPageState,
} from "./pageState";

const state = (patch: Partial<VpnPageState> = {}): VpnPageState => ({ ...DEFAULT_PAGE_STATE, usersSort: { ...DEFAULT_PAGE_STATE.usersSort }, ...patch });

describe("page state rules", () => {
  it("accepts a state inside the contract and drops the whole state on any bad entry", () => {
    expect(validPageState({ view: "lines", open: "lh_0042" })).toEqual({ view: "lines", open: "lh_0042" });
    expect(validPageState({})).toEqual({});
    expect(validPageState({ view: "lines", Group: "exit" })).toBeUndefined();
    expect(validPageState({ view: "lines", "9lives": "x" })).toBeUndefined();
    expect(validPageState({ ["a".repeat(25)]: "x" })).toBeUndefined();
    expect(validPageState({ ["a".repeat(24)]: "x" })).toEqual({ ["a".repeat(24)]: "x" });
    expect(validPageState({ q: "x".repeat(PAGE_STATE_MAX_VALUE_LENGTH + 1) })).toBeUndefined();
    expect(validPageState({ q: "x".repeat(PAGE_STATE_MAX_VALUE_LENGTH) })).toBeDefined();
    expect(validPageState({ view: 1 })).toBeUndefined();
    expect(validPageState(null)).toBeUndefined();
    expect(validPageState(["view", "lines"])).toBeUndefined();
    expect(validPageState("view=lines")).toBeUndefined();
    const seventeen = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`k${index}`, "v"]));
    expect(validPageState(seventeen)).toBeUndefined();
    delete seventeen.k16;
    expect(validPageState(seventeen)).toBeDefined();
  });

  it("filters an address entry by entry, leaving out repeats and keeping at most 16", () => {
    const query = new URLSearchParams("view=lines&Bad=1&expand=a&expand=b&q=" + "x".repeat(257) + "&group=exit");
    expect(filterPageState(query)).toEqual({ view: "lines", group: "exit" });
    const many = Array.from({ length: 20 }, (_, index) => [`k${index}`, "v"] as const);
    expect(Object.keys(filterPageState(many))).toEqual(many.slice(0, 16).map(([key]) => key));
  });

  it("compares states regardless of key order", () => {
    expect(pageStateKey({ view: "lines", group: "exit" })).toBe(pageStateKey({ group: "exit", view: "lines" }));
    expect(pageStateKey({ view: "lines" })).not.toBe(pageStateKey({ view: "topology" }));
  });
});

describe("encoding this plugin's state", () => {
  const cases: Array<[route: string, value: VpnPageState, encoded: PageState]> = [
    ["lines", state(), {}],
    ["lines", state({ linesView: "lines", group: "exit", q: "DMIT", open: "lh_0042" }), { view: "lines", group: "exit", q: "DMIT", open: "lh_0042" }],
    ["lines", state({ linesView: "topology", group: "none" }), { view: "topology", group: "none" }],
    ["lines", state({ linesView: "attention", open: "lh_0001" }), { view: "attention", open: "lh_0001" }],
    ["usage", state(), {}],
    ["usage", state({ usageView: "node", period: "30d" }), { view: "node", period: "30d" }],
    ["usage", state({ usageView: "overview", stack: "role", period: "today" }), { period: "today", stack: "role" }],
    ["usage", state({ usageView: "user", period: "all" }), { view: "user", period: "all" }],
    ["users", state(), {}],
    ["users", state({ usersView: "expiring", usersGroup: "status", q: "metix", usersSort: { key: "expires", reverse: true }, open: "u_1" }), { show: "expiring", group: "status", q: "metix", sort: "-expires", open: "u_1" }],
    ["users", state({ usersView: "over_quota" }), { show: "over_quota" }],
    ["users", state({ usersGroup: "group", usersSort: { key: "used", reverse: false } }), { group: "group", sort: "used" }],
    ["profiles", state(), {}],
    ["profiles", state({ open: "node-hkg-edge-01" }), { open: "node-hkg-edge-01" }],
  ];

  it.each(cases)("round-trips the %s state %#", (route, value, encoded) => {
    expect(encodePageState(route, value)).toEqual(encoded);
    expect(validPageState(encodePageState(route, value))).toEqual(encoded);
    expect(decodePageState(encoded)).toEqual(value);
  });

  it("keeps view for layers: the Users subset is show, and an older view=unbound link is read, never written", () => {
    expect(decodePageState({ view: "unbound" }).usersView).toBe("unbound");
    expect(decodePageState({ view: "expiring", show: "over_quota" }).usersView).toBe("over_quota");
    expect(decodePageState({ view: "lines" }).usersView).toBe("all");
    const legacy = decodePageState({ view: "unbound", open: "u_1" });
    expect(encodePageState("users", legacy)).toEqual({ show: "unbound", open: "u_1" });
  });

  it("writes only the route's own keys, so another page's state never rides along", () => {
    const busy = state({
      linesView: "lines", usageView: "user", group: "bank", q: "hr", open: "lh_9", period: "30d", stack: "role",
      usersView: "unbound", usersGroup: "status", usersSort: { key: "quota", reverse: false },
    });
    expect(Object.keys(encodePageState("lines", busy))).toEqual(["view", "group", "q", "open"]);
    expect(Object.keys(encodePageState("usage", busy))).toEqual(["view", "period", "stack"]);
    expect(encodePageState("users", busy)).toEqual({ show: "unbound", group: "status", q: "hr", sort: "quota", open: "lh_9" });
    expect(encodePageState("profiles", busy)).toEqual({ open: "lh_9" });
  });

  it("trims the search and leaves out a value too long for the address instead of cutting it", () => {
    expect(encodePageState("lines", state({ q: "  DMIT-1  " }))).toEqual({ q: "DMIT-1" });
    expect(encodePageState("lines", state({ q: "   " }))).toEqual({});
    const long = "x".repeat(PAGE_STATE_MAX_VALUE_LENGTH + 1);
    expect(encodePageState("lines", state({ linesView: "lines", q: long }))).toEqual({ view: "lines" });
    expect(encodePageState("users", state({ q: long }))).toEqual({});
  });

  it("reads stale, hand-edited and legacy addresses as a page it can open", () => {
    expect(decodePageState({ view: "nonsense", group: "planet", period: "90d", stack: "tower" })).toEqual(state());
    expect(decodePageState({ lens: "fleet" }).linesView).toBe("lines");
    expect(decodePageState({ lens: "topology" }).linesView).toBe("topology");
    expect(decodePageState({ view: "attention", lens: "fleet" }).linesView).toBe("attention");
    // One `view` names a Lines layer or a Usage layer; the route decides which counts.
    expect(decodePageState({ view: "node" })).toMatchObject({ linesView: "overview", usageView: "node" });
    // One `group` names a Lines grouping or a Users grouping, the same way.
    expect(decodePageState({ group: "status" })).toMatchObject({ group: "node", usersGroup: "status" });
    expect(decodePageState({ group: "bank" })).toMatchObject({ group: "bank", usersGroup: "none" });
    expect(decodePageState({ view: "expiring", sort: "-nonsense" })).toMatchObject({ linesView: "overview", usersView: "expiring", usersSort: { key: "identity", reverse: false } });
  });

  it("reads the Users page's older expand key once, as the identity whose panel opens", () => {
    expect(decodePageState({ expand: " ,u_1,u_2" }).open).toBe("u_1");
    expect(decodePageState({ expand: "u_1", open: "u_9" }).open).toBe("u_9");
    // Read, never written: the next state the page sends has no expand.
    expect(encodePageState("users", decodePageState({ expand: "u_1,u_2" }))).toEqual({ open: "u_1" });
  });
});

describe("sending state to the host", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends once the page has been quiet for the debounce, and only the latest state", () => {
    vi.useFakeTimers();
    const sent: PageState[] = [];
    const sender = createStateSender((value) => sent.push(value));
    sender.push({ view: "lines" });
    vi.advanceTimersByTime(200);
    sender.push({ view: "lines", q: "D" });
    vi.advanceTimersByTime(200);
    sender.push({ view: "lines", q: "DMIT" });
    vi.advanceTimersByTime(249);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([{ view: "lines", q: "DMIT" }]);
  });

  it("sends nothing when the state is what the host already has", () => {
    vi.useFakeTimers();
    const sent: PageState[] = [];
    const sender = createStateSender((value) => sent.push(value), { baseline: { view: "lines", group: "exit" } });
    sender.push({ group: "exit", view: "lines" });
    vi.advanceTimersByTime(2_000);
    expect(sent).toEqual([]);
    sender.push({ view: "topology" });
    sender.push({ group: "exit", view: "lines" });
    vi.advanceTimersByTime(2_000);
    expect(sent).toEqual([]);
    sender.push({});
    vi.advanceTimersByTime(2_000);
    expect(sent).toEqual([{}]);
  });

  it("spaces sends so a minute never holds more than the host's 60, and the last state lands", () => {
    vi.useFakeTimers();
    const sent: Array<{ at: number; state: PageState }> = [];
    const start = Date.now();
    const sender = createStateSender((value) => sent.push({ at: Date.now() - start, state: value }));
    // An operator clicking a layer every 300ms for two minutes.
    for (let index = 0; index < 400; index += 1) {
      sender.push({ view: index % 2 ? "lines" : "topology", q: String(index) });
      vi.advanceTimersByTime(300);
    }
    vi.advanceTimersByTime(5_000);
    for (const { at } of sent) {
      expect(sent.filter((other) => other.at > at - 60_000 && other.at <= at).length).toBeLessThanOrEqual(60);
    }
    expect(sent.at(-1)?.state).toEqual({ view: "lines", q: "399" });
  });

  it("stops after dispose", () => {
    vi.useFakeTimers();
    const sent: PageState[] = [];
    const sender = createStateSender((value) => sent.push(value));
    sender.push({ view: "lines" });
    sender.dispose();
    sender.push({ view: "topology" });
    vi.advanceTimersByTime(2_000);
    expect(sent).toEqual([]);
  });
});

describe("the console's reserved keys", () => {
  it("never cross in either direction", () => {
    for (const key of ["redirect", "next", "code", "state", "token", "sso_error", "totp_challenge", "mfa"]) {
      expect(validPageState({ view: "lines", [key]: "x" }), key).toBeUndefined();
      expect(filterPageState([["view", "lines"], [key, "x"]]), key).toEqual({ view: "lines" });
    }
  });

  it("are never keys this plugin writes", () => {
    const busy = state({ linesView: "lines", usageView: "user", group: "bank", q: "hr", open: "lh_9", period: "30d", stack: "role", usersView: "unbound", usersGroup: "status", usersSort: { key: "used", reverse: true } });
    for (const route of ["lines", "usage", "users", "profiles"]) {
      expect(validPageState(encodePageState(route, busy)), route).toEqual(encodePageState(route, busy));
    }
  });
});
