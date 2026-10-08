import { describe, expect, it } from "vitest";

import {
  buildProbeRequest,
  chainHeads,
  chainPath,
  classifyRunError,
  defaultTestTag,
  formatKB,
  formatMB,
  formatMs,
  formatTook,
  formatUptime,
  jsonFault,
  keepTestTag,
  MAX_OUTBOUNDS,
  MAX_REQUEST_BYTES,
  outboundLabel,
  parseHealth,
  parseProbeResult,
  parseTargets,
  PROBE_THROUGHPUT_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  readDraft,
  resultFacts,
  RUN_CALL_TIMEOUT_MS,
  spotAt,
  stageTrack,
  utf8Length,
  verdictOf,
  type DraftRead,
  type Outbound,
  type ProbeOptions,
  type ProbeResult,
} from "./probeModel";

const SECRET = "hunter2-Zq7-not-for-any-message";
const UUID = "4b1f2c9e-8a3d-4e5f-9b6a-7c8d9e0f1a2b";

const exit = { type: "vless", tag: "exit", server: "198.51.100.24", server_port: 34656, uuid: UUID, detour: "relay", flow: "xtls-rprx-vision" };
const relay = { type: "shadowsocks", tag: "relay", server: "203.0.113.7", server_port: 8388, method: "2022-blake3-aes-128-gcm", password: SECRET };
const TARGETS = ["gstatic-204", "cloudflare-204", "apple-success"];

function options(over: Partial<ProbeOptions> = {}): ProbeOptions {
  return { test: "", targets: ["gstatic-204"], samples: 5, udp: true, throughput: false, throughputBytes: 5_000_000, ...over };
}

function ok(read: DraftRead): Extract<DraftRead, { kind: "ok" }> {
  if (read.kind !== "ok") throw new Error(`expected a read, got ${JSON.stringify(read)}`);
  return read;
}

function fault(text: string) {
  const read = readDraft(text);
  if (read.kind !== "error") throw new Error(`expected an error for ${text}`);
  return read.error;
}

describe("reading the paste", () => {
  it("reads nothing as empty, one object as one outbound, and an array as a chain", () => {
    expect(readDraft("")).toEqual({ kind: "empty" });
    expect(readDraft("  \n\t ")).toEqual({ kind: "empty" });
    const one = ok(readDraft(JSON.stringify(relay)));
    expect(one.single).toBe(true);
    expect(one.outbounds).toEqual([relay]);
    const chain = ok(readDraft(JSON.stringify([exit, relay], null, 2)));
    expect(chain.single).toBe(false);
    expect(chain.outbounds.map((item) => item.tag)).toEqual(["exit", "relay"]);
    expect(chain.bytes).toBe(utf8Length(JSON.stringify([exit, relay], null, 2)));
  });

  it("names each missing or malformed required field by outbound and field, pointing at the key", () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ tag: "a", server: "x", server_port: 1 }, /Outbound 1 \("a"\) has no type/],
      [{ type: 7, tag: "a", server: "x", server_port: 1 }, /type must be a string/],
      [{ type: "vless", server: "x", server_port: 1 }, /Outbound 1 has no tag/],
      [{ type: "vless", tag: 3, server: "x", server_port: 1 }, /tag must be a string/],
      [{ type: "vless", tag: "a", server_port: 1 }, /has no server\./],
      [{ type: "vless", tag: "a", server: "", server_port: 1 }, /has no server\./],
      [{ type: "vless", tag: "a", server: 9, server_port: 1 }, /server must be a host name/],
      [{ type: "vless", tag: "a", server: "x" }, /has no server_port/],
      [{ type: "vless", tag: "a", server: "x", server_port: "443" }, /server_port must be a whole number from 1 to 65535/],
      [{ type: "vless", tag: "a", server: "x", server_port: 0 }, /server_port must be/],
      [{ type: "vless", tag: "a", server: "x", server_port: 65536 }, /server_port must be/],
      [{ type: "vless", tag: "a", server: "x", server_port: 443.5 }, /server_port must be/],
    ];
    for (const [value, message] of cases) {
      const text = JSON.stringify(value, null, 2);
      const error = fault(text);
      expect(error.message, text).toMatch(message);
      expect(error.at, text).toBeDefined();
    }
    // A malformed field points at its own key, on its own line.
    const text = JSON.stringify({ type: "vless", tag: "a", server: "x", server_port: "443" }, null, 2);
    expect(fault(text).at).toMatchObject({ line: 5, column: 3, offset: text.indexOf('"server_port"') });
    // A missing one points at the object it is missing from.
    const chain = JSON.stringify([relay, { type: "vless", tag: "b", server: "y" }], null, 2);
    expect(fault(chain)).toMatchObject({ message: expect.stringMatching(/^Outbound 2 \("b"\) has no server_port/), at: { line: 10, column: 3 } });
  });

  it("refuses types the probe does not test, without echoing a type that could be anything", () => {
    expect(fault(JSON.stringify({ type: "direct", tag: "d", server: "x", server_port: 1 })).message).toMatch(/does not test type "direct"\. It tests shadowsocks, vmess/);
    expect(fault(JSON.stringify({ type: SECRET, tag: "d", server: "x", server_port: 1 })).message).not.toContain(SECRET);
  });

  it("refuses repeated tags, unknown detours, self detours and detour loops", () => {
    expect(fault(JSON.stringify([relay, { ...relay }])).message).toMatch(/Outbound 2 \("relay"\) repeats the tag of outbound 1/);
    expect(fault(JSON.stringify([exit])).message).toMatch(/detours through "relay", which is not in this paste/);
    expect(fault(JSON.stringify([{ ...relay, detour: "relay" }])).message).toMatch(/detours through itself/);
    expect(fault(JSON.stringify([{ ...relay, detour: 4 }])).message).toMatch(/detour must be the tag of another outbound/);
    const loop = JSON.stringify([{ ...exit, detour: "relay" }, { ...relay, detour: "exit" }], null, 2);
    expect(fault(loop).message).toMatch(/loop back on themselves/);
    // An empty detour is no detour.
    expect(ok(readDraft(JSON.stringify([{ ...relay, detour: "" }]))).outbounds).toHaveLength(1);
  });

  it("takes at most eight outbounds and points at the ninth", () => {
    const many = Array.from({ length: MAX_OUTBOUNDS + 1 }, (_, index) => ({ ...relay, tag: `r${index}` }));
    const text = JSON.stringify(many, null, 2);
    const error = fault(text);
    expect(error.message).toBe(`A test takes at most ${MAX_OUTBOUNDS} outbounds; this has ${MAX_OUTBOUNDS + 1}.`);
    expect(error.at?.offset).toBe(text.lastIndexOf("{"));
    expect(ok(readDraft(JSON.stringify(many.slice(0, MAX_OUTBOUNDS)))).outbounds).toHaveLength(MAX_OUTBOUNDS);
  });

  it("says what a share link, a whole config, an empty array and a bare value are", () => {
    expect(fault("  vless://uuid@host:443?security=reality#exit").message).toMatch(/share link, not an outbound/);
    expect(fault(JSON.stringify({ log: {}, outbounds: [relay] })).message).toMatch(/whole sing-box config/);
    expect(fault("[]").message).toMatch(/array is empty/);
    expect(fault('"vless"').message).toMatch(/Paste one outbound object/);
    expect(fault("[1]").message).toMatch(/Outbound 1 is not an object/);
  });

  it("caps the paste at the request limit before parsing it", () => {
    const filler = "x".repeat(MAX_REQUEST_BYTES);
    const error = fault(JSON.stringify({ ...relay, note: filler }));
    expect(error.message).toMatch(/a test request takes at most 64 KB/);
    expect(error.at).toBeUndefined();
  });

  it("parses a pasted eight-outbound chain quickly", () => {
    const chain = Array.from({ length: MAX_OUTBOUNDS }, (_, index) => ({
      ...exit, tag: `hop${index}`, detour: index < MAX_OUTBOUNDS - 1 ? `hop${index + 1}` : undefined,
      tls: { enabled: true, server_name: "www.microsoft.com", reality: { enabled: true, public_key: "k".repeat(43), short_id: "0123abcd" } },
    }));
    const text = JSON.stringify(chain, null, 2);
    const started = performance.now();
    for (let i = 0; i < 200; i++) readDraft(text);
    const perRead = (performance.now() - started) / 200;
    expect(ok(readDraft(text)).outbounds).toHaveLength(MAX_OUTBOUNDS);
    expect(perRead).toBeLessThan(5);
  });
});

describe("JSON syntax faults", () => {
  const cases: Array<[text: string, message: RegExp, line: number, column: number]> = [
    ['{\n  "type": "vless",\n}', /trailing comma before the closing brace/i, 2, 18],
    ["[\n  {},\n]", /trailing comma before the closing bracket/i, 2, 5],
    ["{\n  'type': 'vless'\n}", /double quotes, not single quotes/, 2, 3],
    ['{\n  "type": "vless" // the protocol\n}', /Comments are not JSON/, 2, 19],
    ['{\n  "type": "vless"\n  "tag": "a"\n}', /Expected a comma or a closing brace/, 3, 3],
    ['{\n  "type" "vless"\n}', /Expected a colon/, 2, 10],
    ['{\n  "password": "abc\n}', /closing quote is missing/, 2, 15],
    ['{ "type": "vless" } { "type": "vmess" }', /Several outbounds go inside one array/, 1, 21],
    ['{ "type": "vless",', /stops inside an object/, 1, 19],
    ['{ "a": 01 }', /Expected a comma or a closing brace/, 1, 9],
    ['{ "a": tru }', /Expected a value here/, 1, 8],
    ['{ "a": "\\q" }', /escape JSON does not have/, 1, 9],
    ['{ "a": "\\u12" }', /four hex digits/, 1, 9],
  ];

  it("finds the fault, says it in its own words, and gives the line and column", () => {
    for (const [text, message, line, column] of cases) {
      const error = fault(text);
      expect(error.message, text).toMatch(message);
      expect(error.at, text).toMatchObject({ line, column });
    }
  });

  it("never quotes the paste in a message, whatever the fault", () => {
    const broken = [
      `{"password": "${SECRET}" "uuid": "${UUID}"}`,
      `{"password": '${SECRET}'}`,
      `{"password": "${SECRET}",}`,
      `{"password": "${SECRET}`,
      `{"uuid": ${UUID}}`,
      `vless://${UUID}@host:443?pbk=${SECRET}`,
      // A field's value is never repeated, only its name. (Tags and types are
      // names, and the page shows those by design.)
      JSON.stringify({ type: "vless", tag: "a", server: "x", server_port: SECRET }),
      JSON.stringify({ type: "vless", tag: "a", server: 7, uuid: UUID, password: SECRET }),
      JSON.stringify([{ type: "vless", tag: "a", server: "x", server_port: 1, detour: 5, password: SECRET }]),
    ];
    for (const text of broken) {
      const error = fault(text);
      expect(error.message, text).not.toContain(SECRET.slice(0, 12));
      expect(error.message, text).not.toContain(UUID.slice(0, 8));
    }
  });

  it("agrees with the native parser on what is valid", () => {
    expect(jsonFault(JSON.stringify([exit, relay], null, 2))).toBeUndefined();
    expect(jsonFault('{"a":"\\u00e9\\n","b":-1.5e+3,"c":[true,false,null]}')).toBeUndefined();
    expect(jsonFault("[".repeat(80) + "]".repeat(80))?.message).toMatch(/nests too deeply/);
  });

  it("counts lines and columns like an editor", () => {
    expect(spotAt("ab\ncd", 4)).toEqual({ offset: 4, length: 1, line: 2, column: 2 });
    expect(spotAt("ab", 99, 3)).toEqual({ offset: 2, length: 0, line: 1, column: 3 });
  });

  it("measures UTF-8 the way the server counts the body", () => {
    for (const text of ["plain", "café", "中文", "\u{1f600} pair", "lone \ud800 half"]) {
      expect(utf8Length(text), text).toBe(new TextEncoder().encode(text).length);
    }
  });
});

describe("which outbound to test", () => {
  const chain = [exit, relay] as Outbound[];

  it("tests the end of the chain by default, so traffic passes every hop", () => {
    expect(chainHeads(chain)).toEqual(["exit"]);
    expect(defaultTestTag(chain)).toBe("exit");
    expect(defaultTestTag([relay, exit] as Outbound[])).toBe("exit");
    expect(chainPath(chain, "exit")).toEqual({ tags: ["exit", "relay"], loop: false });
    expect(outboundLabel(chain, "exit")).toBe("exit (vless) via relay");
    expect(outboundLabel(chain, "relay")).toBe("relay (shadowsocks)");
  });

  it("takes the first of several independent outbounds", () => {
    const set = [relay, { ...relay, tag: "relay-2" }] as Outbound[];
    expect(chainHeads(set)).toEqual(["relay", "relay-2"]);
    expect(defaultTestTag(set)).toBe("relay");
  });

  it("keeps the operator's pick while the paste still has it, and falls back when it goes", () => {
    expect(keepTestTag(chain, "relay")).toBe("relay");
    expect(keepTestTag([exit, { ...relay, tag: "relay" }] as Outbound[], "relay")).toBe("relay");
    expect(keepTestTag([{ ...relay, tag: "other" }] as Outbound[], "relay")).toBe("other");
    expect(keepTestTag(chain, "")).toBe("exit");
    expect(keepTestTag([], "relay")).toBe("");
  });
});

describe("the run request", () => {
  const chainRead = readDraft(JSON.stringify([exit, relay]));

  it("sends one object as a one-outbound list tested by its own tag", () => {
    const built = buildProbeRequest(readDraft(JSON.stringify(relay)), options({ test: "ignored" }), TARGETS);
    expect(built).toMatchObject({ ok: true, request: { outbounds: [relay], test: "relay" } });
  });

  it("sends the outbounds field for field, with every option the probe reads", () => {
    const built = buildProbeRequest(chainRead, options({ test: "exit", targets: ["apple-success", "gstatic-204"], samples: 3, udp: false }), TARGETS);
    if (!built.ok) throw new Error(built.message);
    expect(built.request).toEqual({
      outbounds: [exit, relay],
      test: "exit",
      // In the probe's order, not the click order.
      targets: ["gstatic-204", "apple-success"],
      samples: 3,
      udp: false,
      throughput: false,
      throughput_bytes: 0,
      timeout_ms: PROBE_TIMEOUT_MS,
    });
    expect(built.bytes).toBe(utf8Length(JSON.stringify(built.request)));
  });

  it("sends only the tested outbound and the hops it passes through, in paste order", () => {
    const ids = (built: ReturnType<typeof buildProbeRequest>) => (built.ok ? built.request.outbounds.map((item) => item.tag) : built.message);
    // Testing the first hop alone leaves the exit behind, whatever is wrong with it.
    expect(ids(buildProbeRequest(chainRead, options({ test: "relay" }), TARGETS))).toEqual(["relay"]);
    expect(ids(buildProbeRequest(chainRead, options({ test: "exit" }), TARGETS))).toEqual(["exit", "relay"]);
    expect(ids(buildProbeRequest(readDraft(JSON.stringify([relay, exit])), options({ test: "exit" }), TARGETS))).toEqual(["relay", "exit"]);
    // Independent exits: one tested, the others neither sent nor checked by the probe.
    const hk = { type: "trojan", tag: "hk-exit", server: "198.51.100.10", server_port: 443, password: "hk-only-secret" };
    const jp = { type: "trojan", tag: "jp-exit", server: "198.51.100.11", server_port: 443, password: "jp-only-secret" };
    const lab = { type: "shadowsocks", tag: "lab-box", server: "10.0.0.5", server_port: 8388, method: "aes-128-gcm", password: "lab-only-secret" };
    const set = buildProbeRequest(readDraft(JSON.stringify([hk, jp, lab])), options({ test: "hk-exit" }), TARGETS);
    expect(ids(set)).toEqual(["hk-exit"]);
    const body = set.ok ? JSON.stringify(set.request) : "";
    expect(body).toContain("hk-only-secret");
    expect(body).not.toMatch(/jp-only-secret|lab-only-secret|10\.0\.0\.5/);
    expect(set.ok && set.bytes).toBe(utf8Length(body));
  });

  it("gives the probe its default deadline, its maximum for a download, and waits past the server's 36 s", () => {
    const plain = buildProbeRequest(chainRead, options({ test: "exit" }), TARGETS);
    const download = buildProbeRequest(chainRead, options({ test: "exit", throughput: true }), TARGETS);
    expect(plain).toMatchObject({ ok: true, request: { timeout_ms: PROBE_TIMEOUT_MS } });
    expect(download).toMatchObject({ ok: true, request: { timeout_ms: PROBE_THROUGHPUT_TIMEOUT_MS } });
    // Inside the probe's 1 to 30 s; the page outwaits the server's gateway (36 s) and the console's grace.
    expect(PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
    expect(PROBE_THROUGHPUT_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    expect(RUN_CALL_TIMEOUT_MS).toBeGreaterThan(36_000);
  });

  it("says what stops a run, by field", () => {
    expect(buildProbeRequest({ kind: "empty" }, options(), TARGETS)).toMatchObject({ ok: false, field: "outbound" });
    expect(buildProbeRequest(readDraft("{"), options(), TARGETS)).toMatchObject({ ok: false, field: "outbound" });
    expect(buildProbeRequest(chainRead, options({ test: "gone" }), TARGETS)).toMatchObject({ ok: false, field: "test" });
    expect(buildProbeRequest(chainRead, options({ test: "exit", targets: [] }), TARGETS)).toMatchObject({ ok: false, field: "targets" });
    expect(buildProbeRequest(chainRead, options({ test: "exit", targets: ["free-url"] }), TARGETS)).toMatchObject({ ok: false, field: "targets" });
    for (const samples of [0, 11, 2.5, Number.NaN]) {
      expect(buildProbeRequest(chainRead, options({ test: "exit", samples }), TARGETS), String(samples)).toMatchObject({ ok: false, field: "samples" });
    }
    expect(buildProbeRequest(chainRead, options({ test: "exit", throughput: true, throughputBytes: 25_000_001 }), TARGETS)).toMatchObject({ ok: false, field: "throughput" });
    expect(buildProbeRequest(chainRead, options({ test: "exit", throughput: true, throughputBytes: 25_000_000 }), TARGETS))
      .toMatchObject({ ok: true, request: { throughput: true, throughput_bytes: 25_000_000 } });
  });

  it("caps the whole request, not only the paste, at 64 KiB", () => {
    // A paste just under the cap still reads; the fields the page adds tip it over.
    const pad = "p".repeat(MAX_REQUEST_BYTES - 140);
    const text = JSON.stringify({ ...relay, password: "" , note: pad });
    expect(utf8Length(text)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    const read = readDraft(text);
    expect(read.kind).toBe("ok");
    expect(buildProbeRequest(read, options({ targets: TARGETS }), TARGETS)).toMatchObject({ ok: false, field: "size" });
  });
});

describe("the probe's answers", () => {
  it("reads health, and treats anything else as no answer", () => {
    expect(parseHealth({ available: true, probe_version: "0.1.0", engine: "sing-box", core_version: "1.13.19", uptime_s: 60, inflight: 2, max_inflight: 32 }))
      .toEqual({ available: true, reason: "", probeVersion: "0.1.0", engine: "sing-box", coreVersion: "1.13.19", uptimeS: 60, inflight: 2, maxInflight: 32 });
    expect(parseHealth({ available: false, reason: "socket missing" })).toMatchObject({ available: false, reason: "socket missing" });
    expect(parseHealth({ ok: true })).toBeUndefined();
    expect(parseHealth(null)).toBeUndefined();
  });

  it("reads targets, keeping only ids the contract allows", () => {
    expect(parseTargets({ targets: [{ id: "gstatic-204", url: "https://www.gstatic.com/generate_204", expect: 204 }, { id: "Bad Id" }, { id: "gstatic-204" }] }))
      .toEqual([{ id: "gstatic-204", url: "https://www.gstatic.com/generate_204", expect: 204 }]);
    expect(parseTargets([])).toBeUndefined();
  });

  it("reads a result and refuses a shape that is not one", () => {
    const parsed = parseProbeResult({
      valid: true, stage: "ok", error: "",
      server: { address: "203.0.113.7:8388", reachable: true, rtt_ms: 41.2, network: "tcp" },
      targets: [{ id: "gstatic-204", ok: 5, of: 5, cold_ms: { min: 212.4, p50: 230.1, p90: 268 }, warm_ms: { min: 74, p50: 78.2, p90: 90 }, status: 204, error: "" }],
      exit: { ip: "162.196.9.138", loc: "US", colo: "LAX" }, udp: { ok: true, rtt_ms: 80, error: "" }, throughput: null,
      engine: { name: "sing-box", version: "1.13.19" }, took_ms: 1840,
    });
    expect(parsed).toMatchObject({
      valid: true, stage: "ok", engine: "sing-box 1.13.19", tookMs: 1840, throughput: undefined,
      server: { reachable: true, rttMs: 41.2 }, exit: { colo: "LAX" }, udp: { ok: true, rttMs: 80 },
      targets: [{ id: "gstatic-204", ok: 5, of: 5, cold: { p50: 230.1 }, warm: { p90: 90 }, status: 204 }],
    });
    expect(parseProbeResult({ ok: true })).toBeUndefined();
    expect(parseProbeResult({ valid: true, stage: "<script>" })).toBeUndefined();
  });
});

function result(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    valid: true, stage: "ok", error: "", targets: [{ id: "gstatic-204", ok: 5, of: 5, error: "" }],
    server: { address: "203.0.113.7:443", reachable: true, rttMs: 41.2, network: "tcp" }, engine: "sing-box 1.13.19",
    ...over,
  };
}

describe("what an answer means", () => {
  it("says works, works with losses, or the failing stage in plain words", () => {
    expect(verdictOf(result())).toMatchObject({ tone: "success", title: "Works" });
    expect(verdictOf(result({ targets: [{ id: "a", ok: 3, of: 5, error: "" }, { id: "b", ok: 5, of: 5, error: "" }] })))
      .toMatchObject({ tone: "warning", title: "Works, with losses", detail: expect.stringContaining("8 of 10") });
    const titles: Record<string, RegExp> = {
      decode: /cannot read/, create: /refused to create/, server: /does not answer/,
      handshake: /handshake failed/, target: /No target answered/, timeout: /ran out of time/,
    };
    for (const [stage, title] of Object.entries(titles)) {
      expect(verdictOf(result({ stage, valid: stage !== "decode" && stage !== "create" })).title, stage).toMatch(title);
    }
    expect(verdictOf(result({ stage: "timeout" })).tone).toBe("warning");
    expect(verdictOf(result({ stage: "timeout" }), { timeoutMs: 30_000 }).detail).toMatch(/^The probe stopped after 30 s,/);
    expect(verdictOf(result({ stage: "handshake" })).tone).toBe("error");
    expect(verdictOf(result({ stage: "quic_retry" })).title).toMatch(/stage quic_retry/);
  });

  it("does not say works when an asked-for UDP query or download failed", () => {
    const udpDown = result({ udp: { ok: false, error: "read udp: i/o timeout" } });
    expect(verdictOf(udpDown, { udp: true })).toMatchObject({ tone: "warning", title: "Works for HTTP, UDP failed", detail: expect.stringMatching(/^Every request through it answered\. The DNS query over UDP did not answer/) });
    expect(verdictOf(result(), { throughput: true })).toMatchObject({ tone: "warning", title: "Works for HTTP, the download failed" });
    expect(verdictOf(udpDown, { udp: true, throughput: true }).title).toBe("Works for HTTP, UDP and the download failed");
    expect(verdictOf(result({ udp: { ok: false, error: "" }, targets: [{ id: "a", ok: 3, of: 5, error: "" }] }), { udp: true }))
      .toMatchObject({ tone: "warning", title: "Works with losses, and UDP failed", detail: expect.stringContaining("3 of 5 requests") });
    // Not asked, or not relayed by the protocol (no udp answer at all), is no failure.
    expect(verdictOf(udpDown).tone).toBe("success");
    expect(verdictOf(result(), { udp: true })).toMatchObject({ tone: "success", title: "Works" });
    expect(verdictOf(result({ throughput: { bytes: 1_000_000, seconds: 0.2, mbps: 40 } }), { throughput: true }).tone).toBe("success");
  });

  const states = (value: ProbeResult) => stageTrack(value).map((step) => step.state);

  it("tracks how far a test got, stage by stage", () => {
    expect(states(result())).toEqual(["pass", "pass", "pass", "pass"]);
    expect(states(result({ targets: [{ id: "a", ok: 2, of: 5, error: "" }] }))).toEqual(["pass", "pass", "pass", "partial"]);
    expect(states(result({ stage: "decode", valid: false, server: undefined, targets: [] }))).toEqual(["fail", "skip", "skip", "skip"]);
    expect(states(result({ stage: "create", valid: false, server: undefined, targets: [] }))).toEqual(["fail", "skip", "skip", "skip"]);
    expect(states(result({ stage: "server", server: { address: "x:1", reachable: false, network: "tcp" }, targets: [] }))).toEqual(["pass", "fail", "skip", "skip"]);
    expect(states(result({ stage: "handshake", targets: [] }))).toEqual(["pass", "pass", "fail", "skip"]);
    expect(states(result({ stage: "target", targets: [{ id: "a", ok: 0, of: 5, error: "403" }] }))).toEqual(["pass", "pass", "pass", "fail"]);
  });

  it("marks where a timeout caught the test from what it had proved", () => {
    expect(states(result({ stage: "timeout", targets: [{ id: "a", ok: 2, of: 5, error: "" }] }))).toEqual(["pass", "pass", "pass", "timeout"]);
    expect(states(result({ stage: "timeout", targets: [] }))).toEqual(["pass", "pass", "timeout", "skip"]);
    expect(states(result({ stage: "timeout", server: { address: "x:1", reachable: false, network: "udp" }, targets: [] }))).toEqual(["pass", "timeout", "skip", "skip"]);
    expect(stageTrack(result({ stage: "timeout", targets: [{ id: "a", ok: 2, of: 5, error: "" }] }))[3]?.note).toBe("timed out, 2 of 5 answered");
  });

  it("notes the server's round trip and the targets' count", () => {
    const track = stageTrack(result());
    expect(track.map((step) => step.label)).toEqual(["Valid", "Server", "Handshake", "Targets"]);
    expect(track[1]?.note).toBe("41.2 ms tcp");
    expect(track[3]?.note).toBe("5 of 5 answered");
    expect(stageTrack(result({ stage: "handshake", targets: [] }))[3]?.note).toBe("not reached");
  });
});

describe("the figures beside the verdict", () => {
  const keys = (facts: ReturnType<typeof resultFacts>) => facts.map((fact) => fact.key);
  const full = result({
    exit: { ip: "162.196.9.138", loc: "US", colo: "LAX" },
    udp: { ok: true, rttMs: 80.3, error: "" },
    throughput: { bytes: 5_000_000, seconds: 0.83, mbps: 48.3 },
  });

  it("lists what a finished test measured and was asked for", () => {
    expect(resultFacts(full, { udp: true, throughput: true })).toEqual([
      { key: "server", label: "Server", value: "203.0.113.7:443", mono: true, note: "answers in 41.2 ms over tcp" },
      { key: "exit", label: "Exit", value: "162.196.9.138", mono: true, note: "US · LAX" },
      { key: "udp", label: "UDP", value: "80.3 ms", mono: false, note: "DNS over UDP answered" },
      { key: "throughput", label: "Throughput", value: "48.3 Mbit/s", mono: false, note: "5 MB in 0.83 s" },
    ]);
    expect(keys(resultFacts(full, { udp: false, throughput: false }))).toEqual(["server", "exit"]);
  });

  it("says UDP was not tested when the protocol relays none, and failed when it failed", () => {
    expect(resultFacts(result(), { udp: true, throughput: false }).find((fact) => fact.key === "udp"))
      .toMatchObject({ value: "Not tested", note: "this protocol does not relay UDP" });
    expect(resultFacts(result({ udp: { ok: false, error: "i/o timeout" } }), { udp: true, throughput: false }).find((fact) => fact.key === "udp"))
      .toMatchObject({ value: "Failed", note: "i/o timeout" });
  });

  it("marks a failed or missing figure with a tone, and leaves measured ones plain", () => {
    const tones = (value: ProbeResult, asked = { udp: true, throughput: true }) =>
      Object.fromEntries(resultFacts(value, asked).map((fact) => [fact.key, fact.tone]));
    expect(tones(full)).toEqual({ server: undefined, exit: undefined, udp: undefined, throughput: undefined });
    expect(tones(result({ udp: { ok: false, error: "read udp: i/o timeout" } }))).toEqual({ server: undefined, exit: "warning", udp: "error", throughput: "error" });
    expect(resultFacts(result(), { udp: false, throughput: true }).find((fact) => fact.key === "throughput"))
      .toMatchObject({ value: "Failed", note: "the download did not finish", tone: "error" });
    // A protocol that relays no UDP was not failed by the line.
    expect(tones(result(), { udp: true, throughput: false }).udp).toBeUndefined();
    expect(tones(result({ stage: "timeout" }), { udp: true, throughput: true })).toMatchObject({ udp: "warning", throughput: "warning" });
    expect(tones(result({ stage: "server", server: { address: "x:1", reachable: false, network: "tcp" } })).server).toBe("error");
  });

  it("lists nothing past the failing stage", () => {
    expect(keys(resultFacts(result({ stage: "handshake", targets: [] }), { udp: true, throughput: true }))).toEqual(["server"]);
    expect(resultFacts(result({ stage: "server", server: { address: "203.0.113.7:443", reachable: false, network: "tcp" } }), { udp: true, throughput: true }))
      .toEqual([{ key: "server", label: "Server", value: "203.0.113.7:443", mono: true, note: "no answer over tcp", tone: "error" }]);
    expect(resultFacts(result({ stage: "decode", valid: false, server: undefined }), { udp: true, throughput: true })).toEqual([]);
    expect(resultFacts(result({ stage: "timeout" }), { udp: true, throughput: false }).find((fact) => fact.key === "udp")?.note).toBe("the test ran out of time first");
  });
});

describe("a failed run call", () => {
  it("is classified from the console's code and the server's status", () => {
    expect(classifyRunError({ message: "retry in 14 minutes", httpStatus: 429, apiCode: "rate_limited" })).toEqual({ kind: "rate_limited", message: "retry in 14 minutes" });
    expect(classifyRunError({ message: "too many", code: "too_many_requests" }).kind).toBe("rate_limited");
    expect(classifyRunError({ message: "bridge budget", code: "rate_limited" }).kind).toBe("rate_limited");
    expect(classifyRunError({ message: "forbidden", httpStatus: 403, apiCode: "capability_denied" }).kind).toBe("denied");
    expect(classifyRunError({ message: "policy: private address", httpStatus: 400 }).kind).toBe("refused");
    expect(classifyRunError({ message: "plugin request timed out", code: "timeout" }).kind).toBe("timeout");
    expect(classifyRunError(new Error("upstream 502")).kind).toBe("failed");
    expect(classifyRunError(undefined)).toEqual({ kind: "failed", message: "The run failed and the console gave no reason." });
  });
});

describe("numbers", () => {
  it("formats milliseconds, durations, uptime and sizes", () => {
    expect(formatMs(212.44)).toBe("212.4");
    expect(formatMs(undefined)).toBe("");
    expect(formatTook(840.4)).toBe("840 ms");
    expect(formatTook(1843.7)).toBe("1.84 s");
    expect(formatUptime(45)).toBe("45 s");
    expect(formatUptime(11_520)).toBe("3 h 12 m");
    expect(formatUptime(3 * 86_400 + 4 * 3_600)).toBe("3 d 4 h");
    expect(formatKB(3_200)).toBe("3.1 KB");
    expect(formatKB(MAX_REQUEST_BYTES)).toBe("64 KB");
    expect(formatMB(25_000_000)).toBe("25 MB");
    expect(formatMB(1_500_000)).toBe("1.5 MB");
  });
});
