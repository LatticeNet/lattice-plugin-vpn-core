/**
 * probeTargetForm.ts, the checks behind the Probe layer's "Add target" form.
 *
 * An operator saves targets of their own beside lattice-probe's built-in
 * ones (design 27). lattice-server checks every save, and lattice-probe
 * checks every definition again before a run, so nothing here is a guard.
 * These are the same rules said early, beside the field they concern, so a
 * URL the probe would refuse is fixed while it is being typed rather than
 * after a round trip. When this file and the probe disagree, the probe wins.
 */

import type { ProbeTarget } from "./probeModel";

export const TARGET_LABEL_MAX = 64;
export const TARGET_URL_MAX = 2048;
export const TARGET_BODY_MAX = 256;
export const TARGET_STATUS_ITEMS_MAX = 16;
/** The lowest explicit port a target may name besides 443. */
export const TARGET_MIN_HIGH_PORT = 1024;

export type TargetMethod = "GET" | "HEAD";

export interface TargetDraft {
  label: string;
  url: string;
  method: TargetMethod;
  expectStatus: string;
  bodyContains: string;
}

export type DraftField = keyof TargetDraft;

/** The payload target_create and target_update take, besides id and version. */
export interface TargetInput {
  label: string;
  url: string;
  method: TargetMethod;
  expect_status: string;
  body_contains: string;
}

export type DraftCheck =
  | { ok: true; input: TargetInput }
  | { ok: false; errors: Partial<Record<DraftField, string>> };

export function emptyDraft(): TargetDraft {
  return { label: "", url: "https://", method: "GET", expectStatus: "200-299", bodyContains: "" };
}

export function draftFrom(target: ProbeTarget): TargetDraft {
  return { label: target.label, url: target.url, method: target.method, expectStatus: target.expectStatus, bodyContains: target.bodyContains };
}

/** Every field's problem at once, so the form can mark them all. */
export function checkTargetDraft(draft: TargetDraft): DraftCheck {
  const errors: Partial<Record<DraftField, string>> = {};
  const label = draft.label.trim();
  if (!label) errors.label = "Give the target a name.";
  else if ([...label].length > TARGET_LABEL_MAX) errors.label = `At most ${TARGET_LABEL_MAX} characters; this name has ${[...label].length}.`;
  else if (CONTROL.test(label)) errors.label = "Use printable text.";

  const urlProblem = checkTargetUrl(draft.url);
  if (urlProblem) errors.url = urlProblem;

  if (draft.method !== "GET" && draft.method !== "HEAD") errors.method = "GET or HEAD.";

  const status = canonicalStatus(draft.expectStatus);
  if (!status.ok) errors.expectStatus = status.message;

  // HEAD has no body: the text is kept in the form for a switch back to GET, but not checked or sent.
  const body = draft.method === "HEAD" ? "" : draft.bodyContains;
  if (body) {
    if (new TextEncoder().encode(body).length > TARGET_BODY_MAX) errors.bodyContains = `At most ${TARGET_BODY_MAX} bytes.`;
    else if (CONTROL.test(body)) errors.bodyContains = "Use text on one line.";
  }
  if (Object.keys(errors).length || !status.ok) return { ok: false, errors };
  return { ok: true, input: { label, url: draft.url, method: draft.method, expect_status: status.value, body_contains: body } };
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * "204" or "200-299, 301" as the sorted, merged set the server stores. Spaces
 * are allowed; each status is three digits from 100 to 599.
 */
export function canonicalStatus(text: string): { ok: true; value: string } | { ok: false; message: string } {
  const compact = text.replace(/ /g, "");
  if (!compact) return { ok: false, message: "Enter the statuses that pass, for example 204 or 200-299,301." };
  const items = compact.split(",");
  if (items.length > TARGET_STATUS_ITEMS_MAX) return { ok: false, message: `At most ${TARGET_STATUS_ITEMS_MAX} statuses or ranges.` };
  const spans: Array<[number, number]> = [];
  for (const item of items) {
    if (!item) return { ok: false, message: "There is an empty item; remove the extra comma." };
    const parts = item.split("-");
    if (parts.length > 2) return { ok: false, message: `"${item.slice(0, 12)}" is not a status or a range; write 204 or 200-299.` };
    const ends: number[] = [];
    for (const part of parts) {
      if (!/^\d{3}$/.test(part)) return { ok: false, message: `"${item.slice(0, 12)}" is not a status or a range; write 204 or 200-299.` };
      const n = Number(part);
      if (n < 100 || n > 599) return { ok: false, message: `${n} is not an HTTP status (100 to 599).` };
      ends.push(n);
    }
    const [lo, hi = lo] = ends as [number, number?];
    if (hi! < lo) return { ok: false, message: `${lo}-${hi} runs backwards.` };
    spans.push([lo, hi!]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1] + 1) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return { ok: true, value: merged.map(([lo, hi]) => (lo === hi ? `${lo}` : `${lo}-${hi}`)).join(",") };
}

const SPECIAL_SUFFIXES = ["localhost", "local", "internal", "test", "invalid", "example", "onion", "alt", "arpa", "lan", "home", "corp", "intranet", "localdomain"];

/** Why the probe would refuse this URL, or undefined when it would not. */
export function checkTargetUrl(raw: string): string | undefined {
  if (!raw || /^https?:\/\/$/i.test(raw)) return "Enter the URL to request.";
  if (!/^[\x21-\x7e]+$/.test(raw)) return "Use printable ASCII without spaces; percent-encode anything else.";
  if (raw.length > TARGET_URL_MAX) return `At most ${TARGET_URL_MAX} characters.`;
  if (raw.includes("#")) return "Leave out the #fragment; it is never sent.";
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
  if (scheme === "http") return "Saved targets use https.";
  if (scheme !== "https") return "Start the URL with the https scheme.";
  if (!/^https:\/\//i.test(raw)) return "The URL needs a host after the scheme.";
  const authority = raw.slice(8).split(/[/?]/, 1)[0] ?? "";
  if (!authority) return "The URL needs a host after the scheme.";
  if (authority.includes("@")) return "Leave credentials out of the URL.";
  let host = authority;
  let port: string | undefined;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close < 0) return "The bracketed address is not closed.";
    host = authority.slice(1, close);
    const rest = authority.slice(close + 1);
    if (rest && !rest.startsWith(":")) return "The URL does not parse.";
    if (rest) port = rest.slice(1);
    if (host.includes("%")) return `${host} is not a public address.`;
    const v6 = parseIPv6(host);
    if (!v6) return "The bracketed host is not an IPv6 address.";
    const portProblem = checkPort(port);
    if (portProblem) return portProblem;
    return publicV6(v6) ? undefined : `${host} is not a public address.`;
  }
  const colon = authority.lastIndexOf(":");
  if (colon >= 0) {
    host = authority.slice(0, colon);
    port = authority.slice(colon + 1);
  }
  const portProblem = checkPort(port);
  if (portProblem) return portProblem;
  host = host.toLowerCase();
  const v4 = parseIPv4(host);
  if (v4) return publicV4(v4) ? undefined : `${host} is not a public address.`;
  return checkHostName(host);
}

function checkPort(port: string | undefined): string | undefined {
  if (port === undefined) return undefined;
  if (port === "") return "The port after the colon is empty.";
  if (!/^\d+$/.test(port)) return "The port must be a number.";
  if (port.length > 1 && port.startsWith("0")) return "Write the port without a leading zero.";
  const n = Number(port);
  if (n < 1 || n > 65535) return "The port must be from 1 to 65535.";
  if (n !== 443 && n < TARGET_MIN_HIGH_PORT) return `Port ${n} is not allowed; use 443 or a port from ${TARGET_MIN_HIGH_PORT} to 65535.`;
  return undefined;
}

function checkHostName(host: string): string | undefined {
  if (!host) return "The URL needs a host after the scheme.";
  if (host.length > 253) return "The host name is longer than 253 characters.";
  if (host.endsWith(".")) return "Leave out the dot at the end of the host name.";
  const labels = host.split(".");
  if (labels.length < 2) return `${host} is a single-label name, which resolves only on a local network; use a fully qualified name.`;
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    return `${host} has an invalid label; labels are 1 to 63 letters, digits and inner hyphens.`;
  }
  const last = labels[labels.length - 1]!;
  if (/^\d+$/.test(last) || last.startsWith("0x")) return `${host} ends in a number, which some resolvers read as an address.`;
  const suffix = SPECIAL_SUFFIXES.find((value) => host === value || host.endsWith(`.${value}`));
  if (suffix) return `${host} is under .${suffix}, which resolves only on a local network or nowhere.`;
  return undefined;
}

function parseIPv4(text: string): number[] | undefined {
  const parts = text.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return undefined;
  return parts.map(Number);
}

/** The probe's refused IPv4 ranges: everything special-purpose and not globally reachable. */
const V4_REFUSED: Array<[number[], number]> = [
  [[0, 0, 0, 0], 8], [[10, 0, 0, 0], 8], [[100, 64, 0, 0], 10], [[127, 0, 0, 0], 8], [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12], [[192, 0, 0, 0], 24], [[192, 0, 2, 0], 24], [[192, 88, 99, 0], 24], [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15], [[198, 51, 100, 0], 24], [[203, 0, 113, 0], 24], [[224, 0, 0, 0], 4], [[240, 0, 0, 0], 4],
];

function v4Number(a: number[]): number {
  return ((a[0]! << 24) >>> 0) + (a[1]! << 16) + (a[2]! << 8) + a[3]!;
}

function publicV4(a: number[]): boolean {
  const n = v4Number(a);
  return !V4_REFUSED.some(([base, bits]) => (n >>> (32 - bits)) === (v4Number(base) >>> (32 - bits)));
}

/** Eight 16-bit groups, or undefined when the text is not an IPv6 address. */
function parseIPv6(text: string): number[] | undefined {
  let head = text;
  let tail4: number[] | undefined;
  const lastColon = text.lastIndexOf(":");
  if (text.includes(".")) {
    tail4 = parseIPv4(text.slice(lastColon + 1));
    if (!tail4) return undefined;
    head = text.slice(0, lastColon + 1) + "0:0";
  }
  const halves = head.split("::");
  if (halves.length > 2) return undefined;
  const group = (part: string) => (part ? part.split(":") : []);
  const left = group(halves[0]!);
  const right = halves.length === 2 ? group(halves[1]!) : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const all = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...right];
  if (all.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return undefined;
  const groups = all.map((g) => parseInt(g, 16));
  if (tail4) {
    groups[6] = (tail4[0]! << 8) + tail4[1]!;
    groups[7] = (tail4[2]! << 8) + tail4[3]!;
  }
  return groups;
}

function publicV6(g: number[]): boolean {
  const embedded = [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255];
  const zeroTo = (n: number) => g.slice(0, n).every((value) => value === 0);
  if (zeroTo(5) && g[5] === 0xffff) return publicV4(embedded);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((value) => value === 0)) return publicV4(embedded);
  if (g[0] === 0x2002) return publicV4([g[1]! >> 8, g[1]! & 255, g[2]! >> 8, g[2]! & 255]);
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false;
  if (g[0] === 0x3fff && g[1]! < 0x1000) return false;
  if (g[0] === 0x2001 && g[1]! < 0x0200) return false;
  return (g[0]! & 0xe000) === 0x2000;
}
