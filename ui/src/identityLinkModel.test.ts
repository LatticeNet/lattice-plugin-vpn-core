import { describe, expect, it } from "vitest";

import {
  clientLinks,
  convertNote,
  excludedReason,
  fetchLine,
  isPermissionError,
  isStepUpError,
  lineTitle,
  linkBadge,
  linkFix,
  leftOutHeading,
  linkHeadline,
  linkPathHint,
  maskedUrl,
  parseLinkReveal,
  parseLinkStatus,
  revealedUrl,
  revealRefusalText,
  servedHeading,
  userinfoText,
  type LinkStatus,
} from "./identityLinkModel";

const NOW = Date.parse("2026-10-03T08:00:00Z");
const MIN = 60_000;

function status(extra: Partial<LinkStatus> = {}): LinkStatus {
  return {
    identity_id: "vu_alice",
    issued: true,
    link: { slug: "u-abcdefghij", enabled: true, issued_at: "2026-09-24T08:00:00Z", update_interval_hours: 2 },
    answer: "nodes",
    answer_reason: "active",
    included: [{ line_hash_id: "lh_1", node_name: "[cd]-DMIT-1", line_name: "VLESS-REALITY-31010", protocol: "vless" }],
    excluded: [],
    formats: { native: ["URI", "V2Ray"], converted: ["ClashMeta", "sing-box"], convert_available: true },
    ...extra,
  };
}

describe("reading the server's link status", () => {
  it("keeps every field the panel uses and never invents a token", () => {
    const parsed = parseLinkStatus({
      identity_id: "vu_alice", issued: true,
      link: { slug: "u-abcdefghij", enabled: false, issued_at: "2026-09-24T08:00:00Z", rotated_at: "0001-01-01T00:00:00Z", expires_at: "2026-12-01T00:00:00Z", update_interval_hours: 6 },
      answer: "decoy", answer_reason: "link_disabled",
      included: [{ line_hash_id: "lh_1", node_name: "n1" }, { nope: true }],
      excluded: [{ line_hash_id: "lh_2", reason: "template_lossy", fix: "wait_for_template", detail: "drops ech" }],
      formats: { native: ["URI"], converted: [], convert_available: false, fallback: "base64_uri" },
      last_fetch: { at: "2026-10-03T07:46:00Z", ua_class: "clashmeta", answer: "nodes" },
      token: "must-not-survive",
    });
    expect(parsed).toBeDefined();
    expect(parsed!.link).toEqual({ slug: "u-abcdefghij", enabled: false, issued_at: "2026-09-24T08:00:00Z", expires_at: "2026-12-01T00:00:00Z", update_interval_hours: 6 });
    expect(parsed!.included).toEqual([{ line_hash_id: "lh_1", node_name: "n1" }]);
    expect(parsed!.excluded[0].detail).toBe("drops ech");
    expect(parsed!.formats.fallback).toBe("base64_uri");
    expect(parsed!.last_fetch?.ua_class).toBe("clashmeta");
    expect(JSON.stringify(parsed)).not.toContain("must-not-survive");
  });

  it("refuses an answer that is not a status rather than reading it as no link", () => {
    expect(parseLinkStatus(undefined)).toBeUndefined();
    expect(parseLinkStatus({ issued: false })).toBeUndefined();
    expect(parseLinkStatus({ identity_id: "x" })).toBeUndefined();
    const bare = parseLinkStatus({ identity_id: "x", issued: false });
    expect(bare).toMatchObject({ answer: "decoy", answer_reason: "not_issued", included: [], excluded: [] });
  });

  it("accepts a reveal only when it carries a served path and a token", () => {
    expect(parseLinkReveal({ kind: "identity", id: "x", slug: "u-a", token: "t0k", path: "/sub/u-a/t0k" })).toMatchObject({ token: "t0k", path: "/sub/u-a/t0k" });
    expect(parseLinkReveal({ path: "/elsewhere", token: "t" })).toBeUndefined();
    expect(parseLinkReveal({ path: "/sub/u-a/t" })).toBeUndefined();
  });
});

describe("what a fetch gets now", () => {
  it("says the route facts before the identity's state", () => {
    expect(linkHeadline(status({ issued: false, link: undefined, answer: "decoy", answer_reason: "not_issued" }))).toMatchObject({ key: "none", title: "No link" });
    expect(linkHeadline(status({ answer: "decoy", answer_reason: "link_disabled" }))).toMatchObject({ key: "paused", tone: "warning" });
    const expired = linkHeadline(status({ answer: "decoy", answer_reason: "link_expired", link: { ...status().link!, expires_at: "2026-10-01T00:00:00Z" } }));
    expect(expired).toMatchObject({ key: "expired", tone: "error" });
    expect(expired.detail).toMatch(/expired on/);
    expect(expired.detail).toMatch(/Removing its expiry serves it again/);
  });

  it("names the placeholder and why for each reason the server gives", () => {
    const cases: Array<[string, RegExp]> = [
      ["disabled", /turned off.*Identity enabled in Edit/],
      ["operator", /suspended.*suspension is lifted/],
      ["expiry", /expired.*Expires at in Edit/],
      ["quota", /over its quota.*Raising the quota in Edit/],
      ["no_lines", /bound to no line.*Binding a line in Lines below/],
    ];
    for (const [reason, pattern] of cases) {
      const line = linkHeadline(status({ answer: "placeholder", answer_reason: reason, placeholder: "Quota used: 21.0 GiB of 20.0 GiB" }));
      expect(line.key).toBe("placeholder");
      expect(line.detail).toMatch(pattern);
      expect(line.detail).toContain('"Quota used: 21.0 GiB of 20.0 GiB"');
    }
  });

  it("calls an empty answer an error and an active link with left-out lines a warning", () => {
    expect(linkHeadline(status({ answer: "decoy", answer_reason: "transient_empty", included: [], excluded: [{ line_hash_id: "lh_9", reason: "service_down" }] }))).toMatchObject({ key: "empty", tone: "error" });
    expect(linkHeadline(status())).toMatchObject({ key: "active", tone: "healthy", detail: "Serves 1 line, every line this identity is bound to." });
    expect(linkHeadline(status({ excluded: [{ line_hash_id: "lh_2", reason: "credential_not_applied", fix: "plan_add" }] }))).toMatchObject({ tone: "warning" });
  });
});

describe("the last fetch", () => {
  it("is fresh within twice the advertised refresh, stale past it, and honest about a restart", () => {
    const fresh = fetchLine(status({ last_fetch: { at: new Date(NOW - 14 * MIN).toISOString(), ua_class: "clashmeta", answer: "nodes" } }), NOW);
    expect(fresh).toMatchObject({ freshness: "fresh", tone: "healthy", text: "Fetched 14m ago by mihomo (Clash Verge, FlClash), got the servers" });
    const stale = fetchLine(status({ last_fetch: { at: new Date(NOW - 5 * 60 * MIN).toISOString(), ua_class: "shadowrocket", answer: "placeholder" } }), NOW);
    expect(stale).toMatchObject({ freshness: "stale", tone: "warning", text: "Fetched 5h ago by Shadowrocket, got the placeholder" });
    // Recent, but it got the placeholder: not shown as healthy.
    expect(fetchLine(status({ last_fetch: { at: new Date(NOW - MIN).toISOString(), ua_class: "clashmeta", answer: "placeholder" } }), NOW).tone).toBe("warning");
    expect(fetchLine(status(), NOW)).toMatchObject({ freshness: "never", text: "Not fetched since the server last started" });
    expect(fetchLine(status({ last_fetch: { at: new Date(NOW - MIN).toISOString(), ua_class: "curl-ish", answer: "decoy" } }), NOW).text).toBe("Fetched 1m ago by an unrecognised client, got nothing");
  });
});

describe("lines left out", () => {
  it("says each reason and offers a plan only where the fix is a plan", () => {
    expect(excludedReason({ line_hash_id: "a", reason: "template_lossy", detail: "drops ech" })).toBe("the client template would drop parameters (drops ech)");
    expect(excludedReason({ line_hash_id: "a", reason: "brand_new_reason" })).toBe("brand new reason");
    expect(linkFix({ line_hash_id: "a", fix: "plan_add" })).toEqual({ action: "plan_add", label: "Queue add" });
    expect(linkFix({ line_hash_id: "a", fix: "plan_update" })).toEqual({ action: "plan_update", label: "Queue update" });
    expect(linkFix({ line_hash_id: "a", fix: "wait_for_template" })?.action).toBeUndefined();
    expect(linkFix({ line_hash_id: "a" })).toBeUndefined();
    expect(linkFix({ line_hash_id: "a", reason: "binding_disabled" })).toEqual({ label: "turn the binding on in Lines below" });
    expect(lineTitle({ line_hash_id: "lh_1", node_name: "n1", line_name: "VLESS" })).toBe("n1 / VLESS");
    expect(lineTitle({ line_hash_id: "lh_1" })).toBe("lh_1");
  });
});

describe("the revealed link", () => {
  const reveal = { kind: "identity" as const, id: "vu_alice", slug: "u-abcdefghij", token: "Xk2abcdefghijklmnop9fQ", path: "/sub/u-abcdefghij/Xk2abcdefghijklmnop9fQ" };

  it("uses the server's public URL, else the console origin", () => {
    expect(revealedUrl({ ...reveal, url: "https://lattice.example/sub/u-abcdefghij/Xk2abcdefghijklmnop9fQ" }, "https://console.example")).toBe("https://lattice.example/sub/u-abcdefghij/Xk2abcdefghijklmnop9fQ");
    expect(revealedUrl(reveal, "https://console.example")).toBe("https://console.example/sub/u-abcdefghij/Xk2abcdefghijklmnop9fQ");
    expect(revealedUrl(reveal, null)).toBe(reveal.path);
  });

  it("cuts the token to its ends for display and lists no token in the path hint", () => {
    expect(maskedUrl("https://c.example/sub/u-a/Xk2abcdefghijklmnop9fQ")).toBe("https://c.example/sub/u-a/Xk2a…p9fQ");
    expect(linkPathHint({ slug: "u-a" })).toBe("/sub/u-a/…");
  });

  it("offers converted clients only when the server has a converter, and says so otherwise", () => {
    const url = "https://c.example/sub/u-a/T";
    const withConverter = clientLinks(url, status().formats);
    expect(withConverter.map((link) => link.url)).toEqual([url, `${url}?format=plain`, `${url}?target=ClashMeta`, `${url}?target=sing-box`]);
    const without = clientLinks(url, { native: ["URI"], converted: ["ClashMeta"], convert_available: false, fallback: "base64_uri" });
    expect(without).toHaveLength(2);
    expect(convertNote({ native: [], converted: [], convert_available: false })).toMatch(/base64 URI list instead/);
    expect(convertNote(status().formats)).toBe("");
  });
});

describe("refusals", () => {
  it("tells a missing scope from a failure, from the forwarded code or the message", () => {
    expect(isPermissionError({ message: "x", apiCode: "capability_denied" })).toBe(true);
    expect(isPermissionError({ message: "x", httpStatus: 403 })).toBe(true);
    expect(isPermissionError(new Error("vpn-core/users-admin link_get requires vpncore:admin with an unrestricted node allowlist"))).toBe(true);
    expect(isPermissionError(new Error("upstream refused users-admin/link_get: 503 service unavailable"))).toBe(false);
    expect(isStepUpError({ message: "x", apiCode: "step_up_required" })).toBe(true);
    expect(isStepUpError(new Error("step_up_required: a fresh second factor is needed"))).toBe(true);
    expect(isStepUpError(new Error("not found"))).toBe(false);
  });
});

describe("the list's view of a link", () => {
  it("shows issued, paused and expired, and nothing without a link", () => {
    expect(linkBadge(undefined, NOW)).toBeUndefined();
    expect(linkBadge(null, NOW)).toBeUndefined();
    expect(linkBadge({ enabled: true }, NOW)).toEqual({ text: "link" });
    expect(linkBadge({ enabled: false }, NOW)).toEqual({ text: "link paused", tone: "warning" });
    expect(linkBadge({ enabled: true, expires_at: "2026-10-01T00:00:00Z" }, NOW)).toEqual({ text: "link expired", tone: "error" });
  });

  it("says the quota header in words", () => {
    expect(userinfoText("upload=0; download=1073741824; total=21474836480; expire=0", "nodes")).toBe("1.0 GiB of 20.0 GiB");
    expect(userinfoText("upload=0; download=22548578304; total=21474836480; expire=0", "placeholder")).toBe("21.0 GiB of 20.0 GiB, shown as used up");
    expect(userinfoText("upload=0; download=5242880; total=0; expire=0", "nodes")).toBe("5.0 MiB used, no limit");
    expect(userinfoText(undefined, "nodes")).toBe("");
  });
});

describe("revealRefusalText", () => {
  it("invites a retry only when the console ran its step-up", () => {
    expect(revealRefusalText({ code: "step_up_required", apiCode: "step_up_required", message: "Step-up was cancelled" })).toMatch(/Reveal again/);
    expect(revealRefusalText({ code: "call_failed", apiCode: "step_up_required", message: "second-factor step-up required" })).toMatch(/Reveal again/);
    expect(revealRefusalText({ code: "call_failed", message: "step_up_required: revealing a secret needs a fresh second-factor step-up" })).toMatch(/cannot run the step-up/);
    expect(revealRefusalText(new Error("upstream refused users-admin/link_reveal: 503"))).toBeUndefined();
  });
});

describe("the line list headings", () => {
  const issuedOff = { link: { slug: "u-a", enabled: false, issued_at: "2026-09-24T08:00:00Z", update_interval_hours: 2 } };
  it("say serves and leaves out only while the link answers", () => {
    const one = { included: [{ line_hash_id: "a" }], excluded: [{ line_hash_id: "b", reason: "service_down" }] };
    expect(servedHeading(status(one))).toBe("Serves 1 line");
    expect(leftOutHeading(status(one))).toBe("Leaves out 1 bound line");
    const none = status({ ...one, issued: false, link: undefined, answer: "decoy", answer_reason: "not_issued" });
    expect(servedHeading(none)).toBe("Would serve 1 line once a link is issued");
    expect(leftOutHeading(none)).toBe("Would leave out 1 bound line");
    expect(servedHeading(status({ ...one, ...issuedOff, answer: "decoy", answer_reason: "link_disabled" }))).toBe("Would serve 1 line once the link is resumed");
    expect(servedHeading(status({ ...one, answer: "decoy", answer_reason: "link_expired" }))).toBe("Would serve 1 line once the link's expiry is removed");
    expect(servedHeading(status({ ...one, answer: "placeholder", answer_reason: "expiry" }))).toBe("Would serve 1 line once the identity is back in service");
    // Every line left out: the link answers, with nothing.
    expect(leftOutHeading(status({ included: [], excluded: one.excluded, answer: "decoy", answer_reason: "transient_empty" }))).toBe("Leaves out 1 bound line");
  });
});
