/**
 * probeModel.ts, the pure half of the Probe layer: reading a pasted sing-box
 * outbound, building the request lattice-probe answers, and saying what its
 * answer means.
 *
 * The pasted text carries credentials (passwords, UUIDs, private keys). No
 * message built here repeats any part of it: an error names a line and a
 * column, an outbound by its number and tag, and a field by its name, never
 * a value. The JSON engine's own parse error is never shown, because V8
 * quotes the text around the fault ("... is not valid JSON") and that text
 * may be a password.
 *
 * The request contract is lattice-probe's POST /v1/probe, forwarded unchanged
 * by lattice-server's latticenet.vpn-core/probe run (design 27).
 */

export const PROBE_SERVICE = "latticenet.vpn-core/probe";
export type ProbeMethod = "health" | "targets" | "run";

/** The outbound types the probe accepts; anything else it refuses before any network use. */
export const PROBE_TYPES = [
  "shadowsocks", "vmess", "vless", "trojan", "hysteria", "hysteria2",
  "tuic", "shadowtls", "anytls", "socks", "http", "ssh",
] as const;
export const MAX_OUTBOUNDS = 8;
/** The request body cap, on the server and in the probe alike. */
export const MAX_REQUEST_BYTES = 64 * 1024;
export const SAMPLES_MIN = 1;
export const SAMPLES_MAX = 10;
export const SAMPLES_DEFAULT = 5;
export const THROUGHPUT_MAX_BYTES = 25_000_000;
export const THROUGHPUT_SIZES: readonly number[] = [1_000_000, 5_000_000, 10_000_000, 25_000_000];
export const THROUGHPUT_DEFAULT_BYTES = 5_000_000;
/*
 * How long the probe may take before it answers with stage "timeout": its
 * default, or its maximum when a download is asked for, since 25 MB on a slow
 * line needs it. lattice-server gives run a 36 s gateway deadline, past its
 * 35 s socket call, and publishes it so the console's bridge waits as long
 * (design 27). The probe service exists only on servers that do both.
 */
export const PROBE_TIMEOUT_MS = 15_000;
export const PROBE_THROUGHPUT_TIMEOUT_MS = 30_000;
/** How long the page waits for the console, past the server's 36 s and the console's grace. */
export const RUN_CALL_TIMEOUT_MS = 40_000;

const TARGET_ID = /^[a-z0-9-]{1,40}$/;
const PRINTABLE_TYPE = /^[a-z0-9_-]{1,32}$/;
const TAG_SHOWN = 40;

export interface Outbound {
  type: string;
  tag: string;
  server: string;
  server_port: number;
  detour?: string;
  [field: string]: unknown;
}

/** Where in the pasted text a fault is, 1-based like an editor's status bar. */
export interface TextSpot {
  offset: number;
  length: number;
  line: number;
  column: number;
}

export interface DraftError {
  message: string;
  at?: TextSpot;
}

export type DraftRead =
  | { kind: "empty" }
  | { kind: "error"; error: DraftError; bytes: number }
  | { kind: "ok"; outbounds: Outbound[]; single: boolean; bytes: number };

// ── reading the paste ─────────────────────────────────────────────────────

/** UTF-8 length without allocating an encoded copy of a secret. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export function spotAt(text: string, offset: number, length = 1): TextSpot {
  const at = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < at; i++) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { offset: at, length: Math.max(0, Math.min(length, text.length - at)), line, column: at - lineStart + 1 };
}

class Fault {
  constructor(readonly message: string, readonly offset: number, readonly length = 1) {}
}

/**
 * The first syntax fault in text that JSON.parse refused, with a message of
 * our own. It runs only after the native parse failed, so the fast path for a
 * valid paste stays native.
 */
export function jsonFault(text: string): { message: string; offset: number; length: number } | undefined {
  let i = 0;
  const n = text.length;
  const fail = (message: string, offset = i, length = 1): never => {
    throw new Fault(message, offset, length);
  };
  const space = (): void => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i += 1;
      else if (c === 47 && (text[i + 1] === "/" || text[i + 1] === "*")) fail("Comments are not JSON. Remove them: the probe reads strict JSON.", i, 2);
      else return;
    }
  };
  const string = (): void => {
    const start = i;
    i += 1;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 34) {
        i += 1;
        return;
      }
      if (c === 92) {
        const next = text[i + 1];
        if (next === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail("A \\u escape needs four hex digits.", i, 2);
          i += 6;
        } else if (next !== undefined && '"\\/bfnrt'.includes(next)) i += 2;
        else fail("This backslash starts an escape JSON does not have. Write a literal backslash as \\\\.", i, 2);
        continue;
      }
      if (c === 10) fail("A string runs past the end of its line: its closing quote is missing.", start, 1);
      if (c < 32) fail("A control character inside a string must be escaped.", i);
      i += 1;
    }
    fail("A string is not closed: its closing quote is missing.", start, 1);
  };
  const number = (): void => {
    const pattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    pattern.lastIndex = i;
    const match = pattern.exec(text);
    if (!match) fail("This is not a valid number.");
    i += match![0].length;
  };
  const value = (depth: number): void => {
    if (depth > 64) fail("The JSON nests too deeply to be an outbound.");
    space();
    if (i >= n) fail("The JSON stops before it is complete.", n, 0);
    const c = text[i];
    if (c === "{") return container(depth, "}");
    if (c === "[") return container(depth, "]");
    if (c === '"') return string();
    if (c === "-" || (c! >= "0" && c! <= "9")) return number();
    for (const word of ["true", "false", "null"]) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return;
      }
    }
    if (c === "'") fail("Strings and names need double quotes, not single quotes.");
    if (c === "}" || c === "]") fail("Expected a value before this closing bracket.");
    fail("Expected a value here: an object, array, string, number, true, false or null.");
  };
  const container = (depth: number, close: "}" | "]"): void => {
    const object = close === "}";
    const what = object ? "brace" : "bracket";
    i += 1;
    space();
    if (text[i] === close) {
      i += 1;
      return;
    }
    for (;;) {
      space();
      if (object) {
        if (i >= n) fail(`The JSON stops inside an object: a closing ${what} is missing.`, n, 0);
        if (text[i] !== '"') fail(text[i] === "'" ? "Names need double quotes, not single quotes." : "Expected a property name in double quotes.");
        string();
        space();
        if (text[i] !== ":") fail("Expected a colon after the property name.");
        i += 1;
      }
      value(depth + 1);
      space();
      if (text[i] === ",") {
        const comma = i;
        i += 1;
        space();
        if (text[i] === close) fail(`A trailing comma before the closing ${what} is not JSON.`, comma);
        continue;
      }
      if (text[i] === close) {
        i += 1;
        return;
      }
      if (i >= n) fail(`The JSON stops inside ${object ? "an object" : "an array"}: a closing ${what} is missing.`, n, 0);
      fail(`Expected a comma or a closing ${what}.`);
    }
  };
  try {
    value(0);
    space();
    if (i < n) fail("Text continues after the JSON value. Several outbounds go inside one array: [ {...}, {...} ].");
    return undefined;
  } catch (cause) {
    if (cause instanceof Fault) return { message: cause.message, offset: cause.offset, length: cause.length };
    throw cause;
  }
}

/** Where each outbound starts and where its own top-level fields are, in valid JSON. */
interface OutboundSpan {
  start: number;
  fields: Record<string, number>;
}

/**
 * One pass over text JSON.parse accepted, recording where every top-level
 * element begins (each array element, or the one object) and, for objects,
 * where each of their own keys is, so a field error can point at its key.
 */
export function outboundSpans(text: string): OutboundSpan[] {
  const spans: OutboundSpan[] = [];
  const stack: string[] = [];
  let expectKey = false;
  let awaitElement = false;
  let rootArray = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === " " || c === "\n" || c === "\r" || c === "\t") continue;
    if (stack.length === 0 && spans.length === 0 && !rootArray) {
      if (c === "[") {
        rootArray = true;
        awaitElement = true;
        stack.push("[");
        continue;
      }
      spans.push({ start: i, fields: {} });
    } else if (awaitElement && rootArray && stack.length === 1) {
      spans.push({ start: i, fields: {} });
      awaitElement = false;
    }
    const memberLevel = rootArray ? stack.length === 2 && stack[0] === "[" : stack.length === 1;
    switch (c) {
      case '"': {
        const start = i;
        i += 1;
        while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
        if (expectKey && memberLevel && spans.length) {
          try {
            const key = JSON.parse(text.slice(start, i + 1)) as string;
            spans[spans.length - 1]!.fields[key] ??= start;
          } catch {
            // Valid JSON by contract; a key that will not decode simply has no position.
          }
        }
        expectKey = false;
        break;
      }
      case "{":
        stack.push("{");
        expectKey = true;
        break;
      case "[":
        stack.push("[");
        expectKey = false;
        break;
      case "}":
      case "]":
        stack.pop();
        expectKey = false;
        break;
      case ",":
        expectKey = stack[stack.length - 1] === "{";
        if (rootArray && stack.length === 1) awaitElement = true;
        break;
      case ":":
        expectKey = false;
        break;
    }
  }
  return spans;
}

function tagLabel(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  return value.length > TAG_SHOWN ? `${value.slice(0, TAG_SHOWN)}...` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The pasted text read as outbounds, or the first thing wrong with it and
 * where. One object is one outbound; an array is a chain or a set, with
 * `detour` naming another outbound in the same paste.
 */
export function readDraft(text: string): DraftRead {
  if (!text.trim()) return { kind: "empty" };
  const bytes = utf8Length(text);
  const error = (message: string, offset?: number, length = 1): DraftRead => ({
    kind: "error",
    bytes,
    error: offset === undefined ? { message } : { message, at: spotAt(text, offset, length) },
  });
  if (bytes > MAX_REQUEST_BYTES) {
    return error(`The paste is ${formatKB(bytes)}; a test request takes at most ${formatKB(MAX_REQUEST_BYTES)}.`);
  }
  const first = text.search(/\S/);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text.slice(first, first + 24))) {
    return error("This is a share link, not an outbound. Paste the sing-box outbound object (JSON) instead.", first, 1);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    const fault = jsonFault(text);
    return fault ? error(fault.message, fault.offset, fault.length) : error("This is not valid JSON.", first, 1);
  }
  const spans = outboundSpans(text);
  const single = isRecord(value);
  if (!single && !Array.isArray(value)) {
    return error("Paste one outbound object, or an array of outbounds for a chain.", first, 1);
  }
  const list: unknown[] = single ? [value] : (value as unknown[]);
  if (!list.length) return error("The array is empty. Put at least one outbound in it.", first, 1);
  if (single && Array.isArray((value as Record<string, unknown>).outbounds) && (value as Record<string, unknown>).type === undefined) {
    return error("This looks like a whole sing-box config. Paste the outbound objects from its outbounds array instead.", first, 1);
  }
  if (list.length > MAX_OUTBOUNDS) {
    return error(`A test takes at most ${MAX_OUTBOUNDS} outbounds; this has ${list.length}.`, spans[MAX_OUTBOUNDS]?.start ?? first, 1);
  }
  const at = (index: number, field?: string): number => {
    const span = spans[index];
    if (!span) return first;
    return field !== undefined && span.fields[field] !== undefined ? span.fields[field]! : span.start;
  };
  const tags = new Map<string, number>();
  for (const [index, item] of list.entries()) {
    const number = index + 1;
    if (!isRecord(item)) return error(`Outbound ${number} is not an object.`, at(index));
    const tag = tagLabel(item.tag);
    const name = tag ? `Outbound ${number} ("${tag}")` : `Outbound ${number}`;
    if (item.type === undefined) return error(`${name} has no type.`, at(index));
    if (typeof item.type !== "string") return error(`${name}: type must be a string.`, at(index, "type"));
    if (!(PROBE_TYPES as readonly string[]).includes(item.type)) {
      const shown = PRINTABLE_TYPE.test(item.type) ? ` "${item.type}"` : "";
      return error(`${name}: the probe does not test type${shown}. It tests ${PROBE_TYPES.join(", ")}.`, at(index, "type"));
    }
    if (item.tag === undefined || item.tag === "") return error(`${name} has no tag. Every outbound needs one so the test can name it.`, at(index));
    if (typeof item.tag !== "string") return error(`${name}: tag must be a string.`, at(index, "tag"));
    if (tags.has(item.tag)) return error(`${name} repeats the tag of outbound ${tags.get(item.tag)! + 1}. Tags must be unique.`, at(index, "tag"));
    tags.set(item.tag, index);
    if (item.server === undefined || item.server === "") return error(`${name} has no server.`, at(index));
    if (typeof item.server !== "string") return error(`${name}: server must be a host name or an address in a string.`, at(index, "server"));
    if (item.server_port === undefined) return error(`${name} has no server_port.`, at(index));
    const port = item.server_port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      return error(`${name}: server_port must be a whole number from 1 to 65535.`, at(index, "server_port"));
    }
  }
  for (const [index, item] of (list as Record<string, unknown>[]).entries()) {
    const detour = item.detour;
    if (detour === undefined || detour === "") continue;
    const name = `Outbound ${index + 1} ("${tagLabel(item.tag)}")`;
    if (typeof detour !== "string") return error(`${name}: detour must be the tag of another outbound.`, at(index, "detour"));
    if (detour === item.tag) return error(`${name} detours through itself.`, at(index, "detour"));
    if (!tags.has(detour)) {
      return error(`${name} detours through "${tagLabel(detour)}", which is not in this paste. A chain must include every outbound it passes through.`, at(index, "detour"));
    }
  }
  const outbounds = list as Outbound[];
  for (const [index, item] of outbounds.entries()) {
    if (chainPath(outbounds, item.tag).loop) {
      return error(`The detours starting at outbound ${index + 1} ("${tagLabel(item.tag)}") loop back on themselves.`, at(index, "detour"));
    }
  }
  return { kind: "ok", outbounds, single, bytes };
}

// ── what to test ──────────────────────────────────────────────────────────

/** The tested outbound and the outbounds its traffic passes through, nearest the probe last. */
export function chainPath(outbounds: readonly Outbound[], tag: string): { tags: string[]; loop: boolean } {
  const byTag = new Map(outbounds.map((item) => [item.tag, item]));
  const tags: string[] = [];
  const seen = new Set<string>();
  let current = byTag.get(tag);
  while (current) {
    if (seen.has(current.tag)) return { tags, loop: true };
    seen.add(current.tag);
    tags.push(current.tag);
    current = typeof current.detour === "string" && current.detour ? byTag.get(current.detour) : undefined;
  }
  return { tags, loop: false };
}

/** Outbounds no other outbound detours through: the ends of the chains. */
export function chainHeads(outbounds: readonly Outbound[]): string[] {
  const used = new Set(outbounds.map((item) => item.detour).filter((value): value is string => typeof value === "string" && value !== ""));
  return outbounds.map((item) => item.tag).filter((tag) => !used.has(tag));
}

/**
 * What to test when the operator has not chosen: the end of the chain, so a
 * pasted relay and exit test the whole path. With several independent
 * outbounds it is the first; the picker names the rest.
 */
export function defaultTestTag(outbounds: readonly Outbound[]): string {
  return chainHeads(outbounds)[0] ?? outbounds[outbounds.length - 1]?.tag ?? "";
}

/** Keep the operator's choice while the paste still has it; otherwise the default. */
export function keepTestTag(outbounds: readonly Outbound[], current: string): string {
  return current && outbounds.some((item) => item.tag === current) ? current : defaultTestTag(outbounds);
}

/** "exit (vless) via relay", for the picker and the result's heading. */
export function outboundLabel(outbounds: readonly Outbound[], tag: string): string {
  const item = outbounds.find((value) => value.tag === tag);
  if (!item) return tagLabel(tag);
  const path = chainPath(outbounds, tag).tags.slice(1);
  return `${tagLabel(tag)} (${item.type})${path.length ? ` via ${path.map(tagLabel).join(", then ")}` : ""}`;
}

// ── the request ───────────────────────────────────────────────────────────

export interface ProbeOptions {
  test: string;
  targets: readonly string[];
  samples: number;
  udp: boolean;
  throughput: boolean;
  throughputBytes: number;
}

export interface ProbeRequest {
  outbounds: Outbound[];
  test: string;
  targets: string[];
  samples: number;
  udp: boolean;
  throughput: boolean;
  throughput_bytes: number;
  timeout_ms: number;
}

export type BuildResult =
  | { ok: true; request: ProbeRequest; bytes: number }
  | { ok: false; field: "outbound" | "test" | "targets" | "samples" | "throughput" | "size"; message: string };

/**
 * The run payload, exactly what the probe reads. Only the tested outbound
 * and the hops it detours through are sent, in paste order; the rest of the
 * paste stays in the editor. The probe decodes, creates and checks every
 * outbound it is sent, so one that is not under test could decide the
 * verdict, and its credentials have no reason to leave the frame. What is
 * sent goes field for field: the probe decodes it with sing-box's own option
 * registry, and anything this page rewrote would test something else.
 */
export function buildProbeRequest(read: DraftRead, options: ProbeOptions, knownTargets: readonly string[]): BuildResult {
  if (read.kind === "empty") return { ok: false, field: "outbound", message: "Paste an outbound to test." };
  if (read.kind === "error") return { ok: false, field: "outbound", message: read.error.message };
  const test = read.single ? read.outbounds[0]!.tag : options.test;
  if (!read.outbounds.some((item) => item.tag === test)) return { ok: false, field: "test", message: "Choose which outbound to test." };
  const sent = new Set(chainPath(read.outbounds, test).tags);
  const outbounds = read.outbounds.filter((item) => sent.has(item.tag));
  const chosen = new Set(options.targets);
  const targets = knownTargets.filter((id) => chosen.has(id) && TARGET_ID.test(id));
  if (!targets.length) return { ok: false, field: "targets", message: "Choose at least one target." };
  const samples = options.samples;
  if (!Number.isInteger(samples) || samples < SAMPLES_MIN || samples > SAMPLES_MAX) {
    return { ok: false, field: "samples", message: `Samples must be a whole number from ${SAMPLES_MIN} to ${SAMPLES_MAX}.` };
  }
  const throughputBytes = options.throughput ? options.throughputBytes : 0;
  if (options.throughput && (!Number.isInteger(throughputBytes) || throughputBytes <= 0 || throughputBytes > THROUGHPUT_MAX_BYTES)) {
    return { ok: false, field: "throughput", message: `A throughput test downloads at most ${formatMB(THROUGHPUT_MAX_BYTES)}.` };
  }
  const request: ProbeRequest = {
    outbounds,
    test,
    targets,
    samples,
    udp: options.udp,
    throughput: options.throughput,
    throughput_bytes: throughputBytes,
    timeout_ms: options.throughput ? PROBE_THROUGHPUT_TIMEOUT_MS : PROBE_TIMEOUT_MS,
  };
  const bytes = utf8Length(JSON.stringify(request));
  if (bytes > MAX_REQUEST_BYTES) {
    return { ok: false, field: "size", message: `The request is ${formatKB(bytes)}; the probe takes at most ${formatKB(MAX_REQUEST_BYTES)}.` };
  }
  return { ok: true, request, bytes };
}

// ── what the probe answers ────────────────────────────────────────────────

export interface ProbeTarget {
  id: string;
  url: string;
  expect: number;
}

export interface ProbeHealth {
  available: boolean;
  reason: string;
  probeVersion: string;
  engine: string;
  coreVersion: string;
  uptimeS?: number;
  inflight?: number;
  maxInflight?: number;
}

export interface Spread {
  min: number;
  p50: number;
  p90: number;
}

export interface TargetResult {
  id: string;
  ok: number;
  of: number;
  cold?: Spread;
  warm?: Spread;
  status?: number;
  error: string;
}

export interface ProbeResult {
  valid: boolean;
  stage: string;
  error: string;
  server?: { address: string; reachable: boolean; rttMs?: number; network: string };
  targets: TargetResult[];
  exit?: { ip: string; loc: string; colo: string };
  udp?: { ok: boolean; rttMs?: number; error: string };
  throughput?: { bytes: number; seconds: number; mbps: number };
  engine: string;
  tookMs?: number;
}

const finite = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const text = (value: unknown, max = 400): string => (typeof value === "string" ? value.slice(0, max) : "");

export function parseTargets(value: unknown): ProbeTarget[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.targets)) return undefined;
  const out: ProbeTarget[] = [];
  for (const item of value.targets) {
    if (!isRecord(item) || typeof item.id !== "string" || !TARGET_ID.test(item.id)) continue;
    if (out.some((target) => target.id === item.id)) continue;
    out.push({ id: item.id, url: text(item.url, 300), expect: finite(item.expect) ?? 0 });
  }
  return out;
}

export function parseHealth(value: unknown): ProbeHealth | undefined {
  if (!isRecord(value) || typeof value.available !== "boolean") return undefined;
  return {
    available: value.available,
    reason: text(value.reason),
    probeVersion: text(value.probe_version, 40),
    engine: text(value.engine, 40),
    coreVersion: text(value.core_version, 40),
    uptimeS: finite(value.uptime_s),
    inflight: finite(value.inflight),
    maxInflight: finite(value.max_inflight),
  };
}

function spread(value: unknown): Spread | undefined {
  if (!isRecord(value)) return undefined;
  const min = finite(value.min);
  const p50 = finite(value.p50);
  const p90 = finite(value.p90);
  return min === undefined || p50 === undefined || p90 === undefined ? undefined : { min, p50, p90 };
}

/** The probe's answer, or undefined when it is not one: nothing is drawn from a guess. */
export function parseProbeResult(value: unknown): ProbeResult | undefined {
  if (!isRecord(value) || typeof value.valid !== "boolean" || typeof value.stage !== "string" || !/^[a-z_]{1,24}$/.test(value.stage)) return undefined;
  const server = isRecord(value.server)
    ? { address: text(value.server.address, 300), reachable: value.server.reachable === true, rttMs: finite(value.server.rtt_ms), network: text(value.server.network, 8) }
    : undefined;
  const targets: TargetResult[] = Array.isArray(value.targets)
    ? value.targets.filter(isRecord).map((item) => ({
        id: text(item.id, 40),
        ok: finite(item.ok) ?? 0,
        of: finite(item.of) ?? 0,
        cold: spread(item.cold_ms),
        warm: spread(item.warm_ms),
        status: finite(item.status),
        error: text(item.error),
      }))
    : [];
  const exit = isRecord(value.exit) ? { ip: text(value.exit.ip, 64), loc: text(value.exit.loc, 8), colo: text(value.exit.colo, 16) } : undefined;
  const udp = isRecord(value.udp) ? { ok: value.udp.ok === true, rttMs: finite(value.udp.rtt_ms), error: text(value.udp.error) } : undefined;
  const throughput = isRecord(value.throughput)
    ? { bytes: finite(value.throughput.bytes) ?? 0, seconds: finite(value.throughput.seconds) ?? 0, mbps: finite(value.throughput.mbps) ?? 0 }
    : undefined;
  const engine = isRecord(value.engine) ? [text(value.engine.name, 40), text(value.engine.version, 40)].filter(Boolean).join(" ") : "";
  return {
    valid: value.valid,
    stage: value.stage,
    error: text(value.error),
    server,
    targets,
    exit,
    udp,
    throughput,
    engine,
    tookMs: finite(value.took_ms),
  };
}

// ── saying what it means ──────────────────────────────────────────────────

export type Tone = "success" | "warning" | "error";

/** One plain sentence per failing stage, said the way an operator would fix it. */
const STAGES: Record<string, { title: string; detail: string }> = {
  decode: {
    title: "sing-box cannot read this outbound",
    detail: "The probe decoded it with sing-box's own option reader and it refused a field or a value. Nothing was sent to the server.",
  },
  create: {
    title: "sing-box refused to create this outbound",
    detail: "The JSON reads, but sing-box would not build the outbound from it, usually a value it does not accept for that option. Nothing was sent to the server.",
  },
  server: {
    title: "The server does not answer",
    detail: "The server address and port did not accept a connection. The host may be down, the port wrong, or the path blocked. No credentials were tried.",
  },
  handshake: {
    title: "The proxy handshake failed",
    detail: "The server answers, but it did not accept this outbound. Check the password or UUID, the transport, and the TLS or Reality settings.",
  },
  target: {
    title: "No target answered through the proxy",
    detail: "The proxy connected, but requests through it did not reach the targets. The server may block egress or route it where the targets cannot be reached.",
  },
  timeout: {
    title: "The test ran out of time",
    detail: "The probe reached its deadline before every measurement finished. What it measured before then is below.",
  },
};

export interface Verdict {
  tone: Tone;
  title: string;
  detail: string;
}

/** What the run asked for, so the verdict can hold the answer to it. */
export interface Asked {
  udp?: boolean;
  throughput?: boolean;
  /** The deadline the run gave the probe, so a timeout can say how long it was. */
  timeoutMs?: number;
}

/**
 * The probe keeps stage "ok" when the HTTP requests passed and an asked-for
 * UDP query or download did not, so a passing stage alone is not "works": a
 * line that answers HTTP and drops UDP still fails every game, call and QUIC
 * client, and that is what UDP is measured for.
 */
export function verdictOf(result: ProbeResult, asked: Asked = {}): Verdict {
  if (result.stage === "ok") {
    const ok = result.targets.reduce((sum, item) => sum + item.ok, 0);
    const of = result.targets.reduce((sum, item) => sum + item.of, 0);
    const udpFailed = !!asked.udp && result.udp?.ok === false;
    const downloadFailed = !!asked.throughput && !result.throughput;
    const missed = [udpFailed ? "UDP" : "", downloadFailed ? "the download" : ""].filter(Boolean).join(" and ");
    const why = [
      udpFailed ? "The DNS query over UDP did not answer, so games, voice calls and QUIC clients will not work through it." : "",
      downloadFailed ? "The throughput download did not finish, so its speed is unknown." : "",
    ].filter(Boolean).join(" ");
    if (of > 0 && ok < of) {
      return {
        tone: "warning",
        title: missed ? `Works with losses, and ${missed} failed` : "Works, with losses",
        detail: `${ok} of ${of} requests through it answered. The ones that did not are in the table.${why ? ` ${why}` : ""}`,
      };
    }
    if (missed) return { tone: "warning", title: `Works for HTTP, ${missed} failed`, detail: `Every request through it answered. ${why}` };
    return { tone: "success", title: "Works", detail: "The outbound connected and every request through it answered." };
  }
  const known = STAGES[result.stage];
  const timeoutMs = asked.timeoutMs;
  if (result.stage === "timeout" && timeoutMs) {
    return { tone: "warning", title: known!.title, detail: `The probe stopped after ${timeoutMs / 1000} s, before every measurement finished. What it measured before then is below.` };
  }
  if (known) return { tone: result.stage === "timeout" ? "warning" : "error", ...known };
  return { tone: "error", title: `The test failed at stage ${result.stage}`, detail: "This probe names a stage this page does not know. Its own message is below." };
}

export type StepState = "pass" | "partial" | "fail" | "timeout" | "skip";

export interface Step {
  key: "valid" | "server" | "handshake" | "targets";
  label: string;
  state: StepState;
  note: string;
}

/**
 * The four questions a test answers, in the order a connection asks them,
 * each passed, failed or not reached. The failing stage is the first that
 * did not pass, so the operator sees where it broke and what it got past.
 */
export function stageTrack(result: ProbeResult): Step[] {
  const answered = result.targets.reduce((sum, item) => sum + item.ok, 0);
  const asked = result.targets.reduce((sum, item) => sum + item.of, 0);
  const order: Step["key"][] = ["valid", "server", "handshake", "targets"];
  const failAt: Record<string, Step["key"]> = { decode: "valid", create: "valid", server: "server", handshake: "handshake", target: "targets" };
  let stop: Step["key"] | undefined = failAt[result.stage];
  let stopState: StepState = "fail";
  if (result.stage === "timeout") {
    stopState = "timeout";
    stop = !result.valid ? "valid" : result.server && !result.server.reachable ? "server" : answered > 0 ? "targets" : "handshake";
  } else if (result.stage !== "ok" && !stop) {
    stop = "targets";
  }
  const stopIndex = stop ? order.indexOf(stop) : order.length;
  const serverNote = result.server
    ? [result.server.rttMs !== undefined ? `${formatMs(result.server.rttMs)} ms` : "", result.server.network].filter(Boolean).join(" ")
    : "";
  const counted = `${answered} of ${asked} answered`;
  const passed: Record<Step["key"], string> = {
    valid: "sing-box accepts it",
    server: serverNote || "answers",
    handshake: "accepted",
    targets: asked ? counted : "answered",
  };
  const failed: Record<Step["key"], string> = {
    valid: "refused",
    server: "no answer",
    handshake: "refused",
    targets: asked ? counted : "no answer",
  };
  const labels: Record<Step["key"], string> = { valid: "Valid", server: "Server", handshake: "Handshake", targets: "Targets" };
  return order.map((key, index) => {
    let state: StepState;
    if (index < stopIndex) state = "pass";
    else if (index === stopIndex) state = stopState;
    else state = "skip";
    if (key === "targets" && state === "pass" && asked > 0 && answered < asked) state = "partial";
    // A server that answered its own check passed it even when the test stopped later.
    if (key === "server" && state === "skip" && result.server?.reachable) state = "pass";
    let note: string;
    if (state === "skip") note = "not reached";
    else if (state === "timeout") note = key === "targets" && asked ? `timed out, ${counted}` : "timed out";
    else if (state === "fail") note = failed[key];
    else note = passed[key];
    return { key, label: labels[key], state, note };
  });
}

export interface Fact {
  key: "server" | "exit" | "udp" | "throughput";
  label: string;
  value: string;
  /** A value read character by character (an address), drawn in the mono face. */
  mono: boolean;
  note: string;
  /** Set when the fact is a failure or a missing figure, so it does not read like a measured value. */
  tone?: "error" | "warning";
}

/**
 * The figures beside the verdict. Only what the test reached and what was
 * asked for is listed: a handshake failure has a server and nothing past it,
 * and UDP or throughput left off is not a finding.
 */
export function resultFacts(result: ProbeResult, asked: { udp: boolean; throughput: boolean }): Fact[] {
  const finished = result.stage === "ok";
  const reached = finished || result.stage === "timeout";
  const facts: Fact[] = [];
  const server = result.server;
  if (server) {
    const rtt = server.rttMs !== undefined ? ` in ${formatMs(server.rttMs)} ms` : "";
    const fact: Fact = {
      key: "server",
      label: "Server",
      value: server.address || "Not reported",
      mono: !!server.address,
      note: `${server.reachable ? `answers${rtt}` : "no answer"}${server.network ? ` over ${server.network}` : ""}`,
    };
    if (!server.reachable) fact.tone = "error";
    facts.push(fact);
  }
  if (result.exit) {
    facts.push({ key: "exit", label: "Exit", value: result.exit.ip || "Unknown", mono: !!result.exit.ip, note: [result.exit.loc, result.exit.colo].filter(Boolean).join(" · ") || "no location" });
  } else if (finished) {
    facts.push({ key: "exit", label: "Exit", value: "Not measured", mono: false, note: "the trace did not answer", tone: "warning" });
  }
  if (asked.udp && (result.udp || reached)) {
    const udp = result.udp;
    if (udp?.ok) facts.push({ key: "udp", label: "UDP", value: udp.rttMs !== undefined ? `${formatMs(udp.rttMs)} ms` : "Answered", mono: false, note: "DNS over UDP answered" });
    else if (udp) facts.push({ key: "udp", label: "UDP", value: "Failed", mono: false, note: udp.error || "no answer over UDP", tone: "error" });
    else if (finished) facts.push({ key: "udp", label: "UDP", value: "Not tested", mono: false, note: "this protocol does not relay UDP" });
    else facts.push({ key: "udp", label: "UDP", value: "Not tested", mono: false, note: "the test ran out of time first", tone: "warning" });
  }
  if (asked.throughput && (result.throughput || reached)) {
    const value = result.throughput;
    facts.push(value
      ? { key: "throughput", label: "Throughput", value: `${value.mbps.toFixed(1)} Mbit/s`, mono: false, note: `${formatMB(value.bytes)} in ${value.seconds.toFixed(2)} s` }
      : finished
        ? { key: "throughput", label: "Throughput", value: "Failed", mono: false, note: "the download did not finish", tone: "error" }
        : { key: "throughput", label: "Throughput", value: "Not measured", mono: false, note: "the test ran out of time first", tone: "warning" });
  }
  return facts;
}

export type RunFailureKind ="denied" | "rate_limited" | "refused" | "timeout" | "failed";

export interface RunFailure {
  kind: RunFailureKind;
  message: string;
}

interface CallErrorLike {
  message?: string;
  code?: string;
  apiCode?: string;
  httpStatus?: number;
}

/** What a failed run call was, from the console's code and the server's status and code. */
export function classifyRunError(error: unknown): RunFailure {
  const value = (typeof error === "object" && error !== null ? error : {}) as CallErrorLike;
  const message = typeof value.message === "string" && value.message.trim() ? value.message.trim() : "The run failed and the console gave no reason.";
  if (value.httpStatus === 429 || value.apiCode === "rate_limited" || value.code === "rate_limited" || value.code === "too_many_requests") {
    return { kind: "rate_limited", message };
  }
  if (value.apiCode === "capability_denied" || (value.httpStatus === 403 && value.apiCode !== "step_up_required")) return { kind: "denied", message };
  if (value.httpStatus === 400 || value.apiCode === "bad_request") return { kind: "refused", message };
  if (value.code === "timeout" || /timed out/i.test(message)) return { kind: "timeout", message };
  return { kind: "failed", message };
}

// ── numbers ───────────────────────────────────────────────────────────────

/** Milliseconds with the one decimal the probe measures to. */
export function formatMs(value: number | undefined): string {
  return value === undefined ? "" : value.toFixed(1);
}

export function formatTook(ms: number | undefined): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function formatUptime(seconds: number | undefined): string {
  if (seconds === undefined || seconds < 0) return "";
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} m`;
  if (m) return `${m} m`;
  return `${s} s`;
}

export function formatKB(bytes: number): string {
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

/** Decimal megabytes, as the probe's 25 MB cap is written. */
export function formatMB(bytes: number): string {
  return `${Number((bytes / 1_000_000).toFixed(1))} MB`;
}
