// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://plugin.example/index.html#lattice_nonce=frame-test-nonce-0123456789&host_origin=https%3A%2F%2Fconsole.example"}
/**
 * The whole page in a frame, driven by a fake console.
 *
 * A source check cannot see a leak written in a way it does not grep for, so
 * this mounts App.vue as the console would: the frame URL carries the nonce
 * and the pinned host origin, every message the page posts is recorded (in a
 * test window, window.parent is the window itself), and the fake host answers
 * from the dev harness's fixtures. Then it drives the link section the way an
 * operator does and checks what left the page.
 */
import { createApp, nextTick, type App as VueApp } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App.vue";
import { handlers, resetUserStores } from "../dev/fixtures";

const HOST = "https://console.example";
const NONCE = "frame-test-nonce-0123456789";
const INTERFACES = [
  { service: "latticenet.vpn-core/lines", methods: ["list", "get", "chains", "managed"] },
  { service: "latticenet.vpn-core/users", methods: ["list"] },
  {
    service: "latticenet.vpn-core/users-admin",
    methods: ["create", "update", "delete", "bind", "unbind", "rotate", "plan_add", "plan_update", "plan_remove", "usage_query",
      "link_get", "link_issue", "link_set", "link_revoke", "link_rotate", "link_reveal"],
  },
  { service: "latticenet.vpn-core/usage", methods: ["query"] },
];

interface Posted {
  message: Record<string, any>;
  targetOrigin: string;
}

let posted: Posted[] = [];
let app: VueApp | undefined;

function answer(data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: { nonce: NONCE, ...data }, origin: HOST, source: window }));
}

/* The fake console: what the page posts is recorded, and the host answers a
 * moment later, as a real one does across the frame boundary. */
function host(pageState: Record<string, string>) {
  return (message: unknown, options?: unknown) => {
    const targetOrigin = typeof options === "string" ? options : (options as { targetOrigin?: string } | undefined)?.targetOrigin ?? "";
    const data = (message ?? {}) as Record<string, any>;
    posted.push({ message: data, targetOrigin });
    if (data.nonce !== NONCE) return;
    setTimeout(() => {
      switch (data.type) {
        case "lattice.plugin.ready":
          answer({ type: "lattice.host.init", version: "1", pluginId: "latticenet.vpn-core", pluginVersion: "0.11.0-alpha.1", pluginRoute: "users",
            locale: "en", colorScheme: "light", designTokens: {}, interfaces: INTERFACES, pageState });
          return;
        case "lattice.plugin.call": {
          const key = `${String(data.service).split("/").pop()}/${data.method}`;
          const handler = handlers("dense")[key];
          try {
            if (!handler) throw new Error(`no answer for ${key}`);
            answer({ type: "lattice.host.result", id: data.id, result: handler(data.payload ?? {}) });
          } catch (cause) {
            answer({ type: "lattice.host.error", id: data.id, code: "call_failed", message: cause instanceof Error ? cause.message : String(cause) });
          }
          return;
        }
        case "lattice.plugin.clipboard":
          answer({ type: "lattice.host.clipboard", id: data.id, ok: true });
          return;
      }
    }, 1);
  };
}

async function until<T>(read: () => T | null | undefined | false, what: string, ms = 3_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await nextTick();
  }
}

const q = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const testid = <T extends HTMLElement = HTMLElement>(id: string) => q<T>(`[data-testid="${id}"]`);
const calls = (method: string) => posted.filter((entry) => entry.message.type === "lattice.plugin.call" && entry.message.method === method);

async function mountPage(open: string): Promise<void> {
  vi.spyOn(window, "postMessage").mockImplementation(host({ open }) as typeof window.postMessage);
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp(App);
  app.mount(root);
  await until(() => testid("identity-link") && (testid("link-state") || testid("link-issue")), "the link section");
}

beforeEach(() => {
  resetUserStores();
  posted = [];
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
  // jsdom has no CSS.escape; the page uses it to find a re-rendered row when
  // the identity's panel closes. Identity ids here are plain, so this escapes
  // only what a selector cannot carry bare.
  (globalThis as { CSS?: { escape?: (value: string) => string } }).CSS ??= {};
  (globalThis as { CSS: { escape?: (value: string) => string } }).CSS.escape ??= (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("a revealed link leaves the frame only as the one clipboard message", () => {
  it("reveal, copy, show the full link and hide post nothing else carrying the token", async () => {
    const replaced = vi.spyOn(history, "replaceState");
    const pushed = vi.spyOn(history, "pushState");
    await mountPage("u_cdcd");

    testid("link-reveal")!.click();
    await until(() => testid("link-url"), "the revealed link");
    const reveal = calls("link_reveal");
    expect(reveal).toHaveLength(1);
    const revealedNow = handlers("dense")["users-admin/link_reveal"]({ user_id: "u_cdcd" }) as { slug: string; token: string };
    const token = revealedNow.token;
    expect(token.length).toBeGreaterThan(20);

    testid("link-copy")!.click();
    await until(() => testid("link-outcome")?.textContent?.includes("Link copied"), "the copy note");
    testid("link-show-full")!.click();
    await until(() => testid<HTMLInputElement>("link-manual"), "the full link");
    expect(testid<HTMLInputElement>("link-manual")!.value).toContain(token);
    // The page writes its state to the console's address while the link is
    // held: a search, then closing the identity.
    const states = () => posted.filter((entry) => entry.message.type === "lattice.plugin.state");
    const search = q<HTMLInputElement>('input[aria-label="Search, filter and sort identities"]')!;
    search.value = "cdcd";
    search.dispatchEvent(new Event("input"));
    await until(() => states().some((entry) => entry.message.state?.q === "cdcd"), "the search in page state", 4_000);
    q<HTMLButtonElement>('[aria-label="Hide the link"]')!.click();
    await until(() => testid("link-reveal"), "Reveal after Hide");
    q<HTMLButtonElement>('[data-overlay="user-detail"] header [aria-label="Close"]')!.click();
    await until(() => states().some((entry) => entry.message.state && !("open" in entry.message.state)), "the closed identity in page state", 4_000);

    const clipboard = posted.filter((entry) => entry.message.type === "lattice.plugin.clipboard");
    expect(clipboard).toHaveLength(1);
    expect(clipboard[0]!.targetOrigin).toBe(HOST);
    expect(clipboard[0]!.message.text).toBe(`${HOST}/sub/${revealedNow.slug}/${token}`);

    const others = posted.filter((entry) => entry.message.type !== "lattice.plugin.clipboard");
    expect(others.length).toBeGreaterThan(5);
    for (const entry of others) expect(JSON.stringify(entry.message), entry.message.type).not.toContain(token);
    // Every message, the clipboard one too, went to the pinned console only.
    expect(new Set(posted.map((entry) => entry.targetOrigin))).toEqual(new Set([HOST]));
    expect(states().length).toBeGreaterThan(1);
    expect(JSON.stringify(states())).not.toContain(token);
    expect(JSON.stringify([replaced.mock.calls, pushed.mock.calls])).not.toContain(token);
    expect(location.href).not.toContain(token);
  });
});

describe("Remove expiry is confirmed in the page", () => {
  it("on an expired link, says the old URL serves again and offers rotating first; Escape and Cancel give focus back", async () => {
    await mountPage("u_team_7");
    const remove = await until(() => testid("link-clear-expiry"), "Remove expiry");
    remove.focus();
    remove.click();
    const dialog = await until(() => q('[data-overlay="link-confirm"]'), "the confirm");
    expect(dialog.textContent).toMatch(/serve real servers again on its next fetch, to everyone who ever received it/);
    expect(testid("link-confirm-rotate-first")).not.toBeNull();
    expect(calls("link_set")).toHaveLength(0);
    await until(() => document.activeElement?.textContent?.trim() === "Cancel", "Cancel focused");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await until(() => !q('[data-overlay="link-confirm"]') && document.activeElement === testid("link-clear-expiry"), "focus back after Escape");

    testid("link-clear-expiry")!.click();
    await until(() => q('[data-overlay="link-confirm"]'), "the confirm again");
    [...document.querySelectorAll<HTMLButtonElement>('[data-overlay="link-confirm"] footer button')].find((button) => button.textContent?.trim() === "Cancel")!.click();
    await until(() => !q('[data-overlay="link-confirm"]') && document.activeElement === testid("link-clear-expiry"), "focus back after Cancel");
    expect(calls("link_set")).toHaveLength(0);

    testid("link-clear-expiry")!.click();
    await until(() => testid("link-confirm-rotate-first"), "the confirm a third time");
    testid("link-confirm-rotate-first")!.click();
    await until(() => calls("link_set").length === 1, "the expiry removed");
    const order = posted.filter((entry) => entry.message.type === "lattice.plugin.call" && /^link_(rotate|set)$/.test(entry.message.method)).map((entry) => entry.message.method);
    expect(order).toEqual(["link_rotate", "link_set"]);
    expect(calls("link_set")[0]!.message.payload).toEqual({ user_id: "u_team_7", clear_expiry: true });
  });

  it("on an expiry still to come, says the link will never expire and offers no rotation", async () => {
    handlers("dense")["users-admin/link_set"]({ user_id: "u_lab", expires_at: "2027-01-01T00:00:00Z" });
    await mountPage("u_lab");
    (await until(() => testid("link-clear-expiry"), "Remove expiry")).click();
    const dialog = await until(() => q('[data-overlay="link-confirm"]'), "the confirm");
    expect(dialog.textContent).toMatch(/The expiry on .+ is removed, and the link never expires/);
    expect(dialog.textContent).toMatch(/This page cannot set an expiry again/);
    expect(testid("link-clear-expiry")!.classList.contains("button")).toBe(true);
    expect(dialog.textContent).not.toMatch(/everyone who ever received it/);
    expect(testid("link-confirm-rotate-first")).toBeNull();
    testid("link-confirm")!.click();
    await until(() => calls("link_set").length === 1, "the expiry removed");
    await until(() => testid("link-live")?.textContent?.includes("no longer expires"), "the outcome");
  });
});

describe("Turn on for a binding that is off", () => {
  it("is confirmed, reads the identity again, and sends the flow override stored now", async () => {
    await mountPage("u_lab");
    const turnOn = await until(() => [...document.querySelectorAll<HTMLButtonElement>("#user-lines button")].find((button) => button.textContent?.trim() === "Turn on"), "Turn on");
    const hash = turnOn.closest(".binding-list > div")!.querySelector("strong")!.textContent!;
    // Another operator set the override after this page read the identity.
    const stored = (handlers("dense")["users/list"]({}) as { users: Array<{ id: string; bindings: Array<{ line_hash_id: string; enabled: boolean; flow_override?: string }> }> })
      .users.find((user) => user.id === "u_lab")!.bindings.find((binding) => !binding.enabled)!;
    stored.flow_override = "xtls-rprx-vision";

    turnOn.focus();
    turnOn.click();
    const dialog = await until(() => q('[data-overlay="binding-confirm"]'), "the confirm");
    expect(dialog.textContent).toMatch(/no Undo/);
    expect(calls("bind")).toHaveLength(0);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await until(() => !q('[data-overlay="binding-confirm"]') && document.activeElement === turnOn, "focus back after Escape");

    const listsBefore = calls("list").filter((entry) => String(entry.message.service).endsWith("/users")).length;
    turnOn.click();
    await until(() => testid("binding-confirm"), "the confirm again");
    testid("binding-confirm")!.click();
    await until(() => calls("bind").length === 1, "the bind");
    const bind = calls("bind")[0]!;
    const listsBetween = posted.slice(0, posted.indexOf(bind)).filter((entry) => entry.message.type === "lattice.plugin.call" && entry.message.method === "list" && String(entry.message.service).endsWith("/users")).length;
    expect(listsBetween).toBeGreaterThan(listsBefore);
    expect(bind.message.payload).toEqual({ user_id: "u_lab", line_hash_id: stored.line_hash_id, flow_override: "xtls-rprx-vision" });
    expect(hash.length).toBeGreaterThan(0);
  });
});

describe("Revoke", () => {
  it("gives focus to Issue link once the link is gone", async () => {
    await mountPage("u_cdcd");
    const revoke = testid("link-revoke")!;
    revoke.focus();
    revoke.click();
    await until(() => testid("link-confirm"), "the confirm");
    testid("link-confirm")!.click();
    await until(() => testid("link-issue") && document.activeElement === testid("link-issue"), "focus on Issue link");
  });
});
