/**
 * Canned latticenet.vpn-core/probe answers for the Probe layer, shaped like
 * lattice-probe's /v1/health, /v1/targets and /v1/probe as lattice-server
 * forwards them (design 27). One scenario per state the layer draws; the dev
 * harness picks one with `probe=<scenario>` and `deny=probe` drops the
 * service from init the way the console does for a session without
 * vpn:probe.
 *
 * Run answers are built from the request, so the table has the targets and
 * the samples that were asked for. The pasted outbound is read only for the
 * tested server's host and port, which the real probe reports too.
 *
 * Saved targets (the operator's own, kept by the server) live in each
 * handler table's memory, so create, update and delete behave as the server
 * does for one session: versions, the 32-target cap and the 409 a stale
 * version gets. `outdated` answers as a server whose probe cannot run them
 * yet, `oldserver` as a server older than saved targets (built-ins only, no
 * `custom`), and `nosaved` as a current server with an empty list.
 *
 * Never imported by src/; the shipped bundle is built from index.html alone.
 */

import { LinkFixtureError } from "./linkFixtures";
import { canonicalStatus, checkTargetUrl } from "../src/probeTargetForm";

export type ProbeScenario =
  | "ok" | "loss" | "degraded" | "decode" | "create" | "server" | "handshake" | "target" | "timeout"
  | "unavailable" | "limited" | "refused" | "denied" | "garbled" | "outdated" | "oldserver" | "nosaved";
export const PROBE_SCENARIOS: readonly ProbeScenario[] = [
  "ok", "loss", "degraded", "decode", "create", "server", "handshake", "target", "timeout",
  "unavailable", "limited", "refused", "denied", "garbled", "outdated", "oldserver", "nosaved",
];

export const PROBE_TARGETS = [
  { id: "gstatic-204", url: "https://www.gstatic.com/generate_204", expect: 204 },
  { id: "cloudflare-204", url: "https://cp.cloudflare.com/generate_204", expect: 204 },
  { id: "apple-success", url: "https://www.apple.com/library/test/success.html", expect: 200 },
];

interface SavedTarget {
  id: string;
  source: "custom";
  label: string;
  url: string;
  method: "GET" | "HEAD";
  expect_status: string;
  body_contains?: string;
  version: number;
  created_at: string;
  updated_at: string;
}

const SAVED_LIMIT = 32;

function seedSaved(): SavedTarget[] {
  return [
    { id: "custom-home-nas", source: "custom", label: "Home NAS health", url: "https://nas.home-lab.example.net:8443/api/health?probe=lattice",
      method: "GET", expect_status: "200-299", body_contains: "\"status\":\"ok\"", version: 3, created_at: "2026-10-12T08:10:00Z", updated_at: "2026-10-15T21:04:00Z" },
    { id: "custom-cdn-edge", source: "custom", label: "CDN edge (HEAD)", url: "https://edge.cdn-provider.example.org/",
      method: "HEAD", expect_status: "204,301-302", version: 1, created_at: "2026-10-14T02:30:00Z", updated_at: "2026-10-14T02:30:00Z" },
  ];
}

function slug(label: string): string {
  const out = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 33).replace(/-+$/, "");
  return out || "target";
}

const QUIC = new Set(["hysteria", "hysteria2", "tuic"]);
const UDP_RELAY = new Set(["shadowsocks", "vmess", "vless", "trojan", "hysteria", "hysteria2", "tuic", "anytls", "socks"]);

interface RunPayload {
  outbounds?: Array<Record<string, unknown>>;
  test?: string;
  targets?: string[];
  samples?: number;
  udp?: boolean;
  throughput?: boolean;
  throughput_bytes?: number;
}

const round = (value: number) => Math.round(value * 10) / 10;

function spread(base: number, jitter: number) {
  return { min: round(base), p50: round(base + jitter * 0.4), p90: round(base + jitter) };
}

function tested(payload: RunPayload) {
  const list = payload.outbounds ?? [];
  const item = list.find((value) => value.tag === payload.test) ?? list[0] ?? {};
  const type = typeof item.type === "string" ? item.type : "vless";
  const host = typeof item.server === "string" ? item.server : "203.0.113.7";
  const port = typeof item.server_port === "number" ? item.server_port : 443;
  return { type, address: `${host.includes(":") ? `[${host}]` : host}:${port}`, network: QUIC.has(type) ? "udp" : "tcp", hops: list.length };
}

function targetRows(payload: RunPayload, answered: (index: number, of: number) => number, status = 0, error = "") {
  const of = payload.samples ?? 5;
  return (payload.targets ?? ["gstatic-204"]).map((id, index) => {
    const ok = answered(index, of);
    const expect = PROBE_TARGETS.find((target) => target.id === id)?.expect ?? 200;
    const hop = 38 * (tested(payload).hops - 1);
    return {
      id,
      ok,
      of,
      cold_ms: ok ? spread(212.4 + index * 31.7 + hop, 56.2) : { min: 0, p50: 0, p90: 0 },
      warm_ms: ok ? spread(74.1 + index * 9.3 + hop / 2, 15.8) : { min: 0, p50: 0, p90: 0 },
      status: ok ? expect : status,
      error: ok === of ? "" : error || `${of - ok} of ${of} samples did not answer within 5 s`,
    };
  });
}

function base(payload: RunPayload) {
  return { engine: { name: "sing-box", version: "1.13.19" }, exit: null, udp: null, throughput: null, targets: [] as unknown[], server: { ...server(payload, true) } };
}

function server(payload: RunPayload, reachable: boolean) {
  const t = tested(payload);
  return { address: t.address, reachable, rtt_ms: reachable ? 41.2 : 0, network: t.network };
}

function runAnswer(scenario: ProbeScenario, payload: RunPayload): unknown {
  const t = tested(payload);
  switch (scenario) {
    case "limited":
      throw new LinkFixtureError(429, "rate_limited", "Probe runs are limited to 120 per hour for each principal, and this one has used them. The next run is allowed in 14 minutes.");
    case "refused":
      throw new LinkFixtureError(400, "bad_request", "policy: server 10.20.0.5 is a private address (RFC 1918); the probe tests global unicast addresses only.");
    case "denied":
      throw new LinkFixtureError(403, "capability_denied", "vpn-core/probe run requires vpn:probe");
    case "garbled":
      return { ok: true };
    case "decode":
      return { ...base(payload), valid: false, stage: "decode", error: "outbounds[0].transport: unknown transport type: grpcc", server: null, took_ms: 2.1 };
    case "create":
      return { ...base(payload), valid: false, stage: "create", error: "initialize outbound/vless[exit]: reality: decode public_key: illegal base64 data at input byte 42", server: null, took_ms: 3.4 };
    case "server":
      return { ...base(payload), valid: true, stage: "server", error: `dial ${t.network} ${t.address}: i/o timeout`, server: server(payload, false), took_ms: 5004.6 };
    case "handshake":
      return { ...base(payload), valid: true, stage: "handshake", error: "EOF", took_ms: 61.8 };
    case "target":
      return {
        ...base(payload), valid: true, stage: "target", error: "every target answered 403 through the proxy",
        targets: targetRows(payload, () => 0, 403, "unexpected status 403"), took_ms: 2410.2,
      };
    case "timeout":
      return {
        ...base(payload), valid: true, stage: "timeout", error: "probe deadline of 15000 ms exceeded",
        targets: targetRows(payload, (index, of) => (index === 0 ? Math.min(2, of) : 0)), took_ms: 15000.4,
      };
    default: {
      // degraded: every HTTP request answers, but the UDP query and the download fail, and the stage stays ok.
      const loss = scenario === "loss";
      const degraded = scenario === "degraded";
      const bytes = payload.throughput && !degraded ? payload.throughput_bytes ?? 5_000_000 : 0;
      return {
        valid: true,
        stage: "ok",
        error: "",
        server: server(payload, true),
        targets: targetRows(payload, (index, of) => (loss && index === 0 ? Math.max(0, of - 2) : of)),
        exit: { ip: "162.196.9.138", loc: "US", colo: "LAX" },
        udp: payload.udp && UDP_RELAY.has(t.type) ? (degraded ? { ok: false, rtt_ms: 0, error: "read udp: i/o timeout" } : { ok: true, rtt_ms: 80.3, error: "" }) : null,
        throughput: bytes ? { bytes, seconds: round((bytes * 8) / 48.3e6), mbps: 48.3 } : null,
        engine: { name: "sing-box", version: "1.13.19" },
        took_ms: 1843.7,
      };
    }
  }
}

export function probeHandlers(scenario: ProbeScenario): Record<string, (payload: any) => unknown> {
  let saved = scenario === "nosaved" ? [] : seedSaved();
  const builtins = () => PROBE_TARGETS.map((target) => ({ ...target, source: "builtin", method: "GET", expect_status: String(target.expect) }));
  const refuse = (message: string) => new LinkFixtureError(400, "bad_request", message);
  const checked = (payload: Record<string, unknown>) => {
    const label = typeof payload.label === "string" ? payload.label.trim() : "";
    const url = typeof payload.url === "string" ? payload.url : "";
    const method = payload.method === "HEAD" ? "HEAD" : "GET";
    const status = canonicalStatus(typeof payload.expect_status === "string" ? payload.expect_status : "");
    const body = typeof payload.body_contains === "string" ? payload.body_contains : "";
    if (!label) throw refuse("label is required");
    const urlProblem = checkTargetUrl(url);
    if (urlProblem) throw refuse(urlProblem);
    if (!status.ok) throw refuse(status.message);
    // A rule the form does not know, so the server's own refusal can be seen.
    if (url.includes("refuse-me")) throw refuse("url is refused by this server: the host is on the operator's block list");
    return { label, url, method: method as "GET" | "HEAD", expect_status: status.value, ...(body ? { body_contains: body } : {}) };
  };
  return {
    "probe/targets": () => {
      if (scenario === "oldserver") return { targets: PROBE_TARGETS };
      return {
        targets: [...builtins(), ...saved],
        custom: scenario === "outdated"
          ? { supported: false, reason: "lattice-probe 0.1.0-alpha.2 does not run saved targets; a newer lattice-probe does", limit: SAVED_LIMIT }
          : { supported: true, limit: SAVED_LIMIT },
      };
    },
    "probe/target_create": (payload: Record<string, unknown>) => {
      if (saved.length >= SAVED_LIMIT) throw new LinkFixtureError(409, "conflict", `the list holds at most ${SAVED_LIMIT} saved targets; delete one first`);
      const fields = checked(payload);
      const base = `custom-${slug(fields.label)}`;
      let id = base;
      for (let n = 2; saved.some((target) => target.id === id); n++) id = `${base}-${n}`;
      const now = new Date().toISOString();
      const target: SavedTarget = { id, source: "custom", ...fields, version: 1, created_at: now, updated_at: now };
      saved = [...saved, target];
      return target;
    },
    "probe/target_update": (payload: Record<string, unknown>) => {
      const current = saved.find((target) => target.id === payload.id);
      if (!current) throw new LinkFixtureError(404, "not_found", "no saved probe target has this id; it may have been deleted");
      if (current.version !== payload.version) throw new LinkFixtureError(409, "conflict", "someone changed this target since it was read; reload the list and try again");
      const next: SavedTarget = { ...current, ...checked(payload), version: current.version + 1, updated_at: new Date().toISOString() };
      if (!("body_contains" in checked(payload))) delete next.body_contains;
      saved = saved.map((target) => (target.id === current.id ? next : target));
      return next;
    },
    "probe/target_delete": (payload: Record<string, unknown>) => {
      const current = saved.find((target) => target.id === payload.id);
      if (!current) throw new LinkFixtureError(404, "not_found", "no saved probe target has this id; it may have been deleted");
      if (current.version !== payload.version) throw new LinkFixtureError(409, "conflict", "someone changed this target since it was read; reload the list and try again");
      saved = saved.filter((target) => target.id !== current.id);
      return { id: current.id, deleted: true };
    },
    "probe/health": () => {
      if (scenario === "denied") throw new LinkFixtureError(403, "capability_denied", "vpn-core/probe health requires vpn:probe");
      if (scenario === "unavailable") {
        return { available: false, reason: "lattice-probe does not answer on /run/lattice-probe/probe.sock (connect: no such file or directory)." };
      }
      return { available: true, probe_version: "0.1.0", engine: "sing-box", core_version: "1.13.19", uptime_s: 11_520, inflight: 1, max_inflight: 32, targets: PROBE_TARGETS.length };
    },
    "probe/run": (payload: RunPayload) => withBodyMatch(runAnswer(scenario, payload ?? {}), saved),
  };
}

/** A saved target with body text reports whether a passing answer held it, as the probe does. */
function withBodyMatch(answer: unknown, saved: SavedTarget[]): unknown {
  if (!answer || typeof answer !== "object" || !Array.isArray((answer as { targets?: unknown }).targets)) return answer;
  const rows = (answer as { targets: Array<Record<string, unknown>> }).targets.map((row) => {
    const target = saved.find((item) => item.id === row.id);
    return target?.body_contains && typeof row.ok === "number" && row.ok > 0 ? { ...row, body_match: true } : row;
  });
  return { ...(answer as object), targets: rows };
}

/** A chain to paste: a relay and the exit that detours through it. The credentials are made up. */
export const SAMPLE_CHAIN = [
  {
    type: "vless", tag: "exit", server: "198.51.100.24", server_port: 34656,
    uuid: "4b1f2c9e-8a3d-4e5f-9b6a-7c8d9e0f1a2b", flow: "xtls-rprx-vision",
    tls: { enabled: true, server_name: "www.microsoft.com", utls: { enabled: true, fingerprint: "chrome" },
      reality: { enabled: true, public_key: "jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0", short_id: "0123abcd" } },
    detour: "relay",
  },
  { type: "shadowsocks", tag: "relay", server: "203.0.113.7", server_port: 8388, method: "2022-blake3-aes-128-gcm", password: "c2FtcGxlLW9ubHktbm90LXJlYWw=" },
];
