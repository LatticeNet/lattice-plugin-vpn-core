// @vitest-environment jsdom
import { createApp, h, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import IdentityLinkPanel from "./IdentityLinkPanel.vue";
import { useIdentityLink, type IdentityLinkDeps } from "./identityLink";

const TOKEN = "Zq7tokenvaluethatmustneverleakanywhere9";

function status(over: Record<string, unknown> = {}) {
  return {
    identity_id: "vu_a", issued: true,
    link: { slug: "u-abcdefghij", enabled: true, issued_at: "2026-09-24T08:00:00Z", update_interval_hours: 2 },
    answer: "nodes", answer_reason: "active",
    included: [{ line_hash_id: "lh_1", node_name: "[cd]-DMIT-1", line_name: "VLESS-REALITY-31010", protocol: "vless" }],
    excluded: [{ line_hash_id: "lh_2", node_name: "[cd]-DMIT-4", line_name: "VLESS-REALITY-31001", protocol: "vless", reason: "rotation_not_applied", fix: "plan_update" }],
    formats: { native: ["URI", "V2Ray"], converted: ["ClashMeta"], convert_available: true },
    ...over,
  };
}

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    await nextTick();
  }
};

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

async function mount(over: Partial<Record<string, (payload: Record<string, unknown>) => unknown>> = {}, copied = true) {
  const answers: Record<string, (payload: Record<string, unknown>) => unknown> = {
    link_get: () => status(),
    link_reveal: () => ({ kind: "identity", id: "vu_a", slug: "u-abcdefghij", token: TOKEN, path: `/sub/u-abcdefghij/${TOKEN}` }),
    ...over,
  } as Record<string, (payload: Record<string, unknown>) => unknown>;
  const deps: IdentityLinkDeps = {
    call: async <T,>(method: string, payload: Record<string, unknown>) => answers[method]!(payload) as T,
    can: () => true,
    copy: vi.fn(async () => copied),
  };
  const link = useIdentityLink(deps);
  await link.open("vu_a");
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ render: () => h(IdentityLinkPanel, { link, email: "alice@example.invalid", now: Date.parse("2026-10-04T08:00:00Z"), hostOrigin: "https://console.example" }) });
  app.mount(host);
  await settle();
  const q = <T extends HTMLElement = HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`);
  return { host, link, deps, q, unmount: () => app.unmount() };
}

describe("the link section in the page", () => {
  it("draws the QR only after a reveal, on request, and clears it with the link", async () => {
    const { link, q } = await mount();
    expect(q("link-qr")).toBeNull();
    q("link-reveal")!.click();
    await settle();
    expect(q("link-qr-code")).toBeNull();
    q("link-qr")!.click();
    await settle();
    expect(q("link-qr-code")).not.toBeNull();
    link.forgetReveal();
    await settle();
    expect(q("link-qr-code")).toBeNull();
    // Revealed again, the QR starts hidden.
    q("link-reveal")!.click();
    await settle();
    expect(q("link-qr-code")).toBeNull();
  });

  it("keeps the whole token out of the page until asked, and out of every title", async () => {
    const { host, q } = await mount();
    q("link-reveal")!.click();
    await settle();
    expect(host.innerHTML).not.toContain(TOKEN);
    expect([...host.querySelectorAll("[title]")].some((el) => el.getAttribute("title")!.includes(TOKEN))).toBe(false);
    q("link-show-full")!.click();
    await settle();
    expect(q<HTMLInputElement>("link-manual")!.value).toContain(TOKEN);
  });

  it("shows the full link selected when the console refuses to copy it", async () => {
    const { q } = await mount({}, false);
    q("link-reveal")!.click();
    await settle();
    q("link-copy")!.click();
    await settle();
    const field = q<HTMLInputElement>("link-manual")!;
    expect(field.value).toBe(`https://console.example/sub/u-abcdefghij/${TOKEN}`);
    expect(document.activeElement).toBe(field);
    expect(q("link-outcome")!.textContent).toMatch(/selected below/);
  });
});

describe("a plan filed from a left-out line", () => {
  it("replaces the row's button with the plan's state, moves focus there, and refuses a second filing", async () => {
    let filed = 0;
    const { q, host } = await mount({
      plan_update: () => {
        filed += 1;
        return { approval: { id: `apr_upd_${filed}`, plan: JSON.stringify({ summary: "sb user update alice on VLESS-REALITY-31001" }) } };
      },
    });
    const fix = q("link-fix")!;
    expect(fix.textContent).toContain("Queue update");
    fix.click();
    await settle();
    const pending = q("link-pending")!;
    expect(pending.closest("li")?.dataset.line).toBe("lh_2");
    expect(document.activeElement).toBe(pending);
    expect(q("link-fix")).toBeNull();
    expect(pending.closest("li")!.textContent).toContain("Review in Approvals");
    expect(q("link-line-outcome")!.closest("li")?.dataset.line).toBe("lh_2");
    // The waiting plan is in its row, not repeated under the lines.
    expect(q("link-plans")).toBeNull();
    expect(filed).toBe(1);
    expect(host.textContent).toContain("Plan filed, waiting for approval");
  });
});

describe("focus follows the action", () => {
  it("goes to Copy after a reveal, says the reveal, and returns to Reveal when the link is hidden", async () => {
    const { q, host } = await mount();
    const reveal = q("link-reveal")!;
    reveal.focus();
    reveal.click();
    await settle();
    expect(document.activeElement).toBe(q("link-copy"));
    expect(q("link-live")!.textContent).toMatch(/Link revealed/);
    host.querySelector<HTMLButtonElement>('[aria-label="Hide the link"]')!.click();
    await settle();
    expect(document.activeElement).toBe(q("link-reveal"));
  });

  it("stays on Reveal while the console's step-up is open", async () => {
    let release!: (value: unknown) => void;
    const { q } = await mount({ link_reveal: () => new Promise((resolve) => { release = resolve; }) });
    const reveal = q("link-reveal")!;
    reveal.focus();
    reveal.click();
    await settle();
    expect(reveal.getAttribute("aria-disabled")).toBe("true");
    expect(reveal.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(reveal);
    release({ kind: "identity", id: "vu_a", slug: "u-abcdefghij", token: TOKEN, path: `/sub/u-abcdefghij/${TOKEN}` });
    await settle();
    expect(document.activeElement).toBe(q("link-copy"));
  });

  it("goes to Reveal after Issue", async () => {
    let issued = false;
    const { q } = await mount({
      link_get: () => (issued ? status() : status({ issued: false, link: undefined, answer: "decoy", answer_reason: "not_issued" })),
      link_issue: () => { issued = true; return status(); },
    });
    const issue = q("link-issue")!;
    issue.focus();
    issue.click();
    await settle();
    expect(document.activeElement).toBe(q("link-reveal"));
  });

  it("keeps Pause and Resume on one button, so focus stays on it", async () => {
    let enabled = true;
    const { q } = await mount({
      link_set: (payload) => {
        enabled = payload.enabled === true;
        return status({ link: { slug: "u-abcdefghij", enabled, issued_at: "2026-09-24T08:00:00Z", update_interval_hours: 2 }, ...(enabled ? {} : { answer: "decoy", answer_reason: "link_disabled" }) });
      },
    });
    const pause = q("link-pause")!;
    expect(pause.textContent).toContain("Pause link");
    pause.focus();
    pause.click();
    await settle();
    expect(q("link-pause")).toBe(pause);
    expect(pause.textContent).toContain("Resume link");
    expect(document.activeElement).toBe(pause);
  });
});

describe("the served lines and the link's expiry", () => {
  it("shows the served lines on request and removes an expiry through link_set", async () => {
    let sent: Record<string, unknown> | undefined;
    const expiring = { link: { slug: "u-abcdefghij", enabled: true, issued_at: "2026-09-24T08:00:00Z", expires_at: "2026-10-01T00:00:00Z", update_interval_hours: 2 }, answer: "decoy", answer_reason: "link_expired" };
    const { q, host } = await mount({
      link_get: () => status(expiring),
      link_set: (payload) => { sent = payload; return status(); },
    });
    const toggle = q("link-served-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(host.textContent).not.toContain("VLESS-REALITY-31010");
    toggle.click();
    await settle();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("VLESS-REALITY-31010");
    q("link-clear-expiry")!.click();
    await settle();
    expect(sent).toEqual({ user_id: "vu_a", clear_expiry: true });
    expect(q("link-clear-expiry")).toBeNull();
    expect(q("link-live")!.textContent).toMatch(/expiry removed/);
  });
});

describe("the revealed token leaves the panel only through Copy", () => {
  it("posts nothing, stores nothing and changes no address while revealed, QR'd and copied", async () => {
    const posted = vi.spyOn(window, "postMessage");
    const replaced = vi.spyOn(history, "replaceState");
    const pushed = vi.spyOn(history, "pushState");
    const logged = vi.spyOn(console, "log");
    const { q, host, deps } = await mount();
    const before = location.href;
    q("link-reveal")!.click();
    await settle();
    q("link-qr")!.click();
    q("link-copy")!.click();
    host.querySelector<HTMLButtonElement>(".link-clients button")!.click();
    await settle();
    const seen = JSON.stringify([posted.mock.calls, replaced.mock.calls, pushed.mock.calls, logged.mock.calls]);
    expect(seen).not.toContain(TOKEN);
    expect(location.href).toBe(before);
    expect(localStorage.length + sessionStorage.length).toBe(0);
    // Only the two presses copied, each the link it named.
    expect(vi.mocked(deps.copy).mock.calls.map(([text]) => text)).toEqual([
      `https://console.example/sub/u-abcdefghij/${TOKEN}`,
      `https://console.example/sub/u-abcdefghij/${TOKEN}`,
    ]);
  });
});
