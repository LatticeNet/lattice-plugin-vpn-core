import { describe, expect, it } from "vitest";

import { canonicalStatus, checkTargetDraft, checkTargetUrl, draftFrom, emptyDraft, type TargetDraft } from "./probeTargetForm";

const good: TargetDraft = { label: "Edge", url: "https://edge.example.net/health", method: "GET", expectStatus: "204", bodyContains: "" };

describe("the saved-target form's checks, which follow lattice-probe's", () => {
  it("accepts what the probe accepts", () => {
    for (const url of [
      "https://edge.example.net/", "HTTPS://Edge.Example.NET/", "https://edge.example.net:443/", "https://edge.example.net:8443/a?b=c&d=%20",
      "https://1.1.1.1/", "https://[2606:4700:4700::1111]:8443/", "https://xn--bcher-kva.ch/", "https://123.example.net/", "https://example.com/",
      "https://[2001:4860:4860::8888]/",
    ]) {
      expect(checkTargetUrl(url), url).toBeUndefined();
    }
    expect(checkTargetDraft(good)).toEqual({ ok: true, input: { label: "Edge", url: good.url, method: "GET", expect_status: "204", body_contains: "" } });
    expect(checkTargetDraft({ ...good, label: "  家里的 NAS  " })).toMatchObject({ ok: true, input: { label: "家里的 NAS" } });
  });

  // One row per URL rule; each must be refused and say why.
  const refused: Array<[string, string, RegExp]> = [
    ["empty", "", /Enter the URL/],
    ["scheme only", "https://", /Enter the URL/],
    ["space", "https://edge.example.net/a b", /printable ASCII/],
    ["non-ascii", "https://bücher.ch/", /printable ASCII/],
    ["too long", `https://edge.example.net/${"a".repeat(2048)}`, /At most 2048/],
    ["fragment", "https://edge.example.net/#top", /fragment/],
    ["http", "http://edge.example.net/", /use https/],
    ["ftp", "ftp://edge.example.net/", /Start the URL with the https scheme/],
    ["no scheme", "edge.example.net/", /Start the URL with the https scheme/],
    ["opaque", "https:edge.example.net", /needs a host after the scheme/],
    ["no host", "https:///path", /needs a host after the scheme/],
    ["credentials", "https://user:pass@edge.example.net/", /credentials/],
    ["empty port", "https://edge.example.net:/", /port after the colon is empty/],
    ["port word", "https://edge.example.net:abc/", /must be a number/],
    ["port zero", "https://edge.example.net:0/", /from 1 to 65535/],
    ["port too high", "https://edge.example.net:65536/", /from 1 to 65535/],
    ["leading zero", "https://edge.example.net:0443/", /leading zero/],
    ["low port", "https://edge.example.net:22/", /Port 22 is not allowed/],
    ["port 80", "https://edge.example.net:80/", /Port 80 is not allowed/],
    ["loopback", "https://127.0.0.1/", /not a public address/],
    ["private", "https://192.168.1.1/", /not a public address/],
    ["metadata", "https://169.254.169.254/", /not a public address/],
    ["cgnat", "https://100.64.0.1/", /not a public address/],
    ["this network", "https://0.1.2.3/", /not a public address/],
    ["reserved", "https://240.0.0.1/", /not a public address/],
    ["documentation", "https://203.0.113.9/", /not a public address/],
    ["v6 loopback", "https://[::1]/", /not a public address/],
    ["v6 unspecified", "https://[::]/", /not a public address/],
    ["v6 unique local", "https://[fd00::1]/", /not a public address/],
    ["v6 link-local", "https://[fe80::1]/", /not a public address/],
    ["v6 zone", "https://[fe80::1%25eth0]/", /not a public address/],
    ["mapped loopback", "https://[::ffff:127.0.0.1]/", /not a public address/],
    ["nat64 private", "https://[64:ff9b::a00:1]/", /not a public address/],
    ["6to4 private", "https://[2002:a00:1::1]/", /not a public address/],
    ["v6 documentation", "https://[2001:db8::1]/", /not a public address/],
    ["bad v6", "https://[example.net]/", /not an IPv6 address/],
    ["localhost", "https://localhost/", /single-label/],
    ["single label", "https://nas/", /single-label/],
    ["trailing dot", "https://edge.example.net./", /dot at the end/],
    ["underscore", "https://a_b.example.net/", /invalid label/],
    ["leading hyphen", "https://-a.example.net/", /invalid label/],
    ["short v4", "https://127.1/", /ends in a number/],
    ["hex v4", "https://0x7f.0x1/", /ends in a number/],
    ["leading-zero v4", "https://01.1.1.1/", /ends in a number/],
    ["local", "https://printer.local/", /under \.local/],
    ["internal", "https://metadata.google.internal/", /under \.internal/],
    ["localhost subdomain", "https://api.localhost/", /under \.localhost/],
    ["home arpa", "https://nas.home.arpa/", /under \.arpa/],
  ];
  for (const [name, url, reason] of refused) {
    it(`refuses ${name}`, () => {
      expect(checkTargetUrl(url)).toMatch(reason);
    });
  }

  it("reads statuses the way the server stores them", () => {
    expect(canonicalStatus("204")).toEqual({ ok: true, value: "204" });
    expect(canonicalStatus(" 301 , 200-250,251-299, 204 ")).toEqual({ ok: true, value: "200-299,301" });
    expect(canonicalStatus("204-204")).toEqual({ ok: true, value: "204" });
    for (const [text, reason] of [
      ["", /Enter the statuses/], ["ok", /not a status/], ["99", /not a status/], ["600", /not an HTTP status/],
      ["299-200", /backwards/], ["200,", /empty item; remove the extra comma/], ["200-250-299", /not a status/],
      [Array(17).fill("200").join(","), /At most 16/],
    ] as const) {
      const result = canonicalStatus(text);
      expect(result.ok, text).toBe(false);
      if (!result.ok) expect(result.message).toMatch(reason);
    }
  });

  it("marks every field's problem at once", () => {
    const result = checkTargetDraft({ label: " ", url: "http://x", method: "HEAD", expectStatus: "2xx", bodyContains: "ok" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // HEAD keeps the body text in the form but neither checks nor sends it.
    expect(Object.keys(result.errors).sort()).toEqual(["expectStatus", "label", "url"]);
    expect(checkTargetDraft({ ...good, method: "HEAD", bodyContains: "a\nb" })).toMatchObject({ ok: true, input: { method: "HEAD", body_contains: "" } });
    expect(checkTargetDraft({ ...good, label: "x".repeat(73) })).toMatchObject({ ok: false, errors: { label: "At most 64 characters; this name has 73." } });
    expect(checkTargetDraft({ ...good, bodyContains: "é".repeat(129) })).toMatchObject({ ok: false, errors: { bodyContains: expect.stringMatching(/256 bytes/) } });
    expect(checkTargetDraft({ ...good, bodyContains: "a\nb" })).toMatchObject({ ok: false, errors: { bodyContains: expect.stringMatching(/one line/) } });
  });

  it("starts a new target at https and a saved one where it was", () => {
    expect(emptyDraft()).toEqual({ label: "", url: "https://", method: "GET", expectStatus: "200-299", bodyContains: "" });
    expect(draftFrom({ id: "custom-a", source: "custom", label: "A", url: "https://a.example.net/", method: "HEAD", expect: 0, expectStatus: "204", bodyContains: "", version: 2 }))
      .toEqual({ label: "A", url: "https://a.example.net/", method: "HEAD", expectStatus: "204", bodyContains: "" });
  });
});
