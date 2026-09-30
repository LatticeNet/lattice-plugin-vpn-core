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

const state = (patch: Partial<VpnPageState> = {}): VpnPageState => ({ ...DEFAULT_PAGE_STATE, expand: [], ...patch });

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
    ["users", state({ expand: ["u_1", "u_7"] }), { expand: "u_1,u_7" }],
    ["users", state(), {}],
    ["profiles", state(), {}],
  ];

  it.each(cases)("round-trips the %s state %#", (route, value, encoded) => {
    expect(encodePageState(route, value)).toEqual(encoded);
    expect(validPageState(encodePageState(route, value))).toEqual(encoded);
    expect(decodePageState(encoded)).toEqual(value);
  });

  it("writes only the route's own keys, so another page's state never rides along", () => {
    const busy = state({ linesView: "lines", usageView: "user", group: "bank", q: "hr", open: "lh_9", period: "30d", stack: "role", expand: ["u_2"] });
    expect(Object.keys(encodePageState("lines", busy))).toEqual(["view", "group", "q", "open"]);
    expect(Object.keys(encodePageState("usage", busy))).toEqual(["view", "period", "stack"]);
    expect(Object.keys(encodePageState("users", busy))).toEqual(["expand"]);
    expect(encodePageState("profiles", busy)).toEqual({});
  });

  it("trims the search and leaves out a value too long for the address instead of cutting it", () => {
    expect(encodePageState("lines", state({ q: "  DMIT-1  " }))).toEqual({ q: "DMIT-1" });
    expect(encodePageState("lines", state({ q: "   " }))).toEqual({});
    const long = "x".repeat(PAGE_STATE_MAX_VALUE_LENGTH + 1);
    expect(encodePageState("lines", state({ linesView: "lines", q: long }))).toEqual({ view: "lines" });
    const manyUsers = Array.from({ length: 60 }, (_, index) => `user_${index}`);
    expect(encodePageState("users", state({ expand: manyUsers }))).toEqual({});
  });

  it("reads stale, hand-edited and legacy addresses as a page it can open", () => {
    expect(decodePageState({ view: "nonsense", group: "planet", period: "90d", stack: "tower" })).toEqual(state());
    expect(decodePageState({ lens: "fleet" }).linesView).toBe("lines");
    expect(decodePageState({ lens: "topology" }).linesView).toBe("topology");
    expect(decodePageState({ view: "attention", lens: "fleet" }).linesView).toBe("attention");
    // One `view` names a Lines layer or a Usage layer; the route decides which counts.
    expect(decodePageState({ view: "node" })).toMatchObject({ linesView: "overview", usageView: "node" });
    expect(decodePageState({ expand: "u_1,,u_2, u_1" }).expand).toEqual(["u_1", "u_2"]);
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
    const busy = state({ linesView: "lines", usageView: "user", group: "bank", q: "hr", open: "lh_9", period: "30d", stack: "role", expand: ["u_2"] });
    for (const route of ["lines", "usage", "users", "profiles"]) {
      expect(validPageState(encodePageState(route, busy)), route).toEqual(encodePageState(route, busy));
    }
  });
});
