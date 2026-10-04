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
