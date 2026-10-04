import { createSSRApp, h, ref, shallowRef } from "vue";
import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vitest";

import IdentityLinkPanel from "./IdentityLinkPanel.vue";
import type { IdentityLinkState, LinkOutcome } from "./identityLink";
import { parseLinkStatus, type LinkReveal } from "./identityLinkModel";

const NOW = Date.parse("2026-10-03T08:00:00Z");

function fakeLink(over: { load?: string; status?: unknown; revealed?: LinkReveal; can?: (method: string) => boolean; outcome?: LinkOutcome } = {}): IdentityLinkState {
  const noop = async () => true;
  return {
    userId: ref("vu_a"),
    load: ref(over.load ?? "ready"),
    status: shallowRef(over.status === undefined ? undefined : parseLinkStatus(over.status)),
    error: ref(""),
    busy: ref(""),
    outcome: ref(over.outcome),
    revealed: shallowRef(over.revealed),
    plans: shallowRef([]),
    open: async () => {},
    refresh: async () => {},
    issue: noop, setEnabled: noop, rotate: noop, revoke: noop, reveal: noop,
    forgetReveal: () => {},
    copy: noop,
    fix: async () => {},
    dismiss: () => {},
    canFix: () => (over.can ?? (() => true))("plan_update"),
    pendingPlan: () => undefined,
    can: over.can ?? (() => true),
  } as unknown as IdentityLinkState;
}

const ACTIVE = {
  identity_id: "vu_a", issued: true,
  link: { slug: "u-abcdefghij", enabled: true, issued_at: "2026-09-24T08:00:00Z", update_interval_hours: 2 },
  answer: "nodes", answer_reason: "active",
  included: [{ line_hash_id: "lh_1", node_name: "[cd]-DMIT-1", line_name: "VLESS-REALITY-31010", protocol: "vless" }],
  excluded: [{ line_hash_id: "lh_2", node_name: "[cd]-DMIT-4", line_name: "VLESS-REALITY-31001", reason: "credential_not_applied", fix: "plan_add" }],
  formats: { native: ["URI", "V2Ray"], converted: [], convert_available: false },
  last_fetch: { at: "2026-10-03T07:46:00Z", ua_class: "clashmeta", answer: "nodes" },
};

function render(link: IdentityLinkState): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(IdentityLinkPanel, { link, email: "alice@example.invalid", now: NOW, hostOrigin: "https://console.example" }) }));
}

describe("the identity's link section", () => {
  it("says why a session without the scope sees no link", async () => {
    const html = await render(fakeLink({ load: "denied" }));
    expect(html).toContain('data-testid="link-denied"');
    expect(html).toContain("vpncore:admin with no node restriction");
  });

  it("shows what the link serves, the last fetch and the fix, and no token before a reveal", async () => {
    const html = await render(fakeLink({ status: ACTIVE }));
    expect(html).toContain("Serves 1 line; 1 bound line is left out");
    expect(html).toContain("/sub/u-abcdefghij/…");
    expect(html).toContain("Fetched 14m ago by mihomo (Clash Verge, FlClash), got the servers");
    expect(html).toContain("Queue add");
    expect(html).toContain('data-testid="link-reveal"');
    expect(html).not.toContain('data-testid="link-url"');
  });

  it("offers only what the session may call", async () => {
    const html = await render(fakeLink({ status: ACTIVE, can: (method) => method === "link_get" }));
    expect(html).not.toContain('data-testid="link-reveal"');
    expect(html).toContain("This session cannot reveal links.");
    expect(html).not.toContain('data-testid="link-rotate"');
    expect(html).not.toContain('data-testid="link-revoke"');
    expect(html).not.toContain("Queue add");
  });

  it("shows a revealed link cut to its ends beside Copy and puts the whole token nowhere until asked", async () => {
    const token = "Xk2abcdefghijklmnopqrstuvwxyz9fQ";
    const html = await render(fakeLink({ status: ACTIVE, revealed: { kind: "identity", id: "vu_a", slug: "u-abcdefghij", token, path: `/sub/u-abcdefghij/${token}` } }));
    expect(html).toContain("https://console.example/sub/u-abcdefghij/Xk2a…z9fQ");
    expect(html).toContain('data-testid="link-copy"');
    // Not in a field, a title, or a client button: only behind Show the full link.
    expect(html).not.toContain(token);
    expect(html).toContain('data-testid="link-show-full"');
    // The QR is drawn only when asked for.
    expect(html).not.toContain('data-testid="link-qr-code"');
  });

  it("says what Reveal and Copy answered beside them, not under the line lists", async () => {
    const refused = await render(fakeLink({ status: ACTIVE, outcome: { tone: "error", place: "reveal", text: "Nothing was revealed: the console's step-up did not complete." } }));
    const note = refused.indexOf('data-testid="link-outcome"');
    expect(note).toBeGreaterThan(refused.indexOf('data-testid="link-reveal"'));
    expect(note).toBeLessThan(refused.indexOf("Revealing asks the console"));
    expect(refused.split('data-testid="link-outcome"')).toHaveLength(2);

    const token = "Xk2abcdefghijklmnopqrstuvwxyz9fQ";
    const copied = await render(fakeLink({
      status: ACTIVE,
      revealed: { kind: "identity", id: "vu_a", slug: "u-abcdefghij", token, path: `/sub/u-abcdefghij/${token}` },
      outcome: { tone: "error", place: "reveal", text: "The console did not copy it. The full link is selected below: copy it by hand." },
    }));
    const copyNote = copied.indexOf('data-testid="link-outcome"');
    expect(copyNote).toBeGreaterThan(copied.indexOf('data-testid="link-copy"'));
    expect(copyNote).toBeLessThan(copied.indexOf('data-testid="link-show-full"'));

    const paused = await render(fakeLink({ status: ACTIVE, outcome: { tone: "success", text: "Link paused: it answers like an unknown URL until you resume it." } }));
    expect(paused.indexOf('data-testid="link-outcome"')).toBeGreaterThan(paused.indexOf('data-testid="link-excluded"'));
  });

  it("keeps the served lines a count until asked, and never says serves for a link that does not answer", async () => {
    const active = await render(fakeLink({ status: ACTIVE }));
    expect(active).toContain("Serves 1 line");
    expect(active).toContain('data-testid="link-served-toggle"');
    expect(active).not.toContain("VLESS-REALITY-31010");
    expect(active).toContain("VLESS-REALITY-31001");
    const none = await render(fakeLink({ status: { ...ACTIVE, issued: false, link: undefined, answer: "decoy", answer_reason: "not_issued" } }));
    expect(none).toContain("Would serve 1 line once a link is issued");
    expect(none).toContain("Would leave out 1 bound line");
    expect(none).not.toMatch(/>Serves |>Leaves out /);
  });

  it("offers Remove expiry for a link with one", async () => {
    const expired = await render(fakeLink({ status: { ...ACTIVE, answer: "decoy", answer_reason: "link_expired", link: { ...ACTIVE.link, expires_at: "2026-10-01T00:00:00Z" } } }));
    expect(expired).toContain('data-testid="link-clear-expiry"');
    expect(expired).toContain("Removing its expiry serves it again");
    expect(await render(fakeLink({ status: ACTIVE }))).not.toContain('data-testid="link-clear-expiry"');
  });

  it("offers Issue for an identity with no link", async () => {
    const html = await render(fakeLink({ status: { identity_id: "vu_a", issued: false, answer: "decoy", answer_reason: "not_issued", included: [], excluded: [], formats: {} } }));
    expect(html).toContain("No link");
    expect(html).toContain('data-testid="link-issue"');
    expect(html).not.toContain('data-testid="link-rotate"');
  });
});
