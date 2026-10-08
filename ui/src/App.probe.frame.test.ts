// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://plugin.example/index.html#lattice_nonce=probe-frame-nonce-0123456789&host_origin=https%3A%2F%2Fconsole.example"}
/**
 * The Probe layer inside the whole page, driven by a fake console.
 *
 * The pasted outbound carries credentials. A source check cannot see a leak
 * written in a shape it does not grep for, so this mounts App.vue as the
 * console would, records every message the page posts, pastes a chain with
 * a password and a UUID, runs it, and checks the credentials left the frame
 * exactly once: as the run call's payload. Not in page state, not in any
 * other call, not in the frame's own address, not in storage.
 */
import { createApp, nextTick, type App as VueApp } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App.vue";
import { handlers, resetUserStores } from "../dev/fixtures";
import { probeHandlers, SAMPLE_CHAIN } from "../dev/probeFixtures";

const HOST = "https://console.example";
const NONCE = "probe-frame-nonce-0123456789";
const SECRET = "c2FtcGxlLW9ubHktbm90LXJlYWw=";
const UUID = "4b1f2c9e-8a3d-4e5f-9b6a-7c8d9e0f1a2b";
const LINES = { service: "latticenet.vpn-core/lines", methods: ["list", "get", "chains", "managed"] };
const USAGE = { service: "latticenet.vpn-core/usage", methods: ["query"] };
const PROBE = { service: "latticenet.vpn-core/probe", methods: ["health", "targets", "run"] };

interface Posted {
  message: Record<string, any>;
  targetOrigin: string;
}

let posted: Posted[] = [];
let app: VueApp | undefined;

function answer(data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data: { nonce: NONCE, ...data }, origin: HOST, source: window }));
}

function host(pageState: Record<string, string>, interfaces: unknown[], fail: Set<string>) {
  const table = { ...handlers("production"), ...probeHandlers("ok") };
  return (message: unknown, options?: unknown) => {
    const targetOrigin = typeof options === "string" ? options : (options as { targetOrigin?: string } | undefined)?.targetOrigin ?? "";
    const data = (message ?? {}) as Record<string, any>;
    posted.push({ message: data, targetOrigin });
    if (data.nonce !== NONCE) return;
    setTimeout(() => {
      if (data.type === "lattice.plugin.ready") {
        answer({ type: "lattice.host.init", version: "1", pluginId: "latticenet.vpn-core", pluginVersion: "0.11.0-alpha.4", pluginRoute: "lines",
          locale: "en", colorScheme: "dark", designTokens: {}, interfaces, pageState });
        return;
      }
      if (data.type !== "lattice.plugin.call") return;
      const key = `${String(data.service).split("/").pop()}/${data.method}`;
      try {
        if (fail.has(key)) throw new Error(`upstream refused ${key}: 503 service unavailable`);
        const handler = table[key];
        if (!handler) throw new Error(`no answer for ${key}`);
        answer({ type: "lattice.host.result", id: data.id, result: handler(data.payload ?? {}) });
      } catch (cause) {
        answer({ type: "lattice.host.error", id: data.id, code: "call_failed", message: cause instanceof Error ? cause.message : String(cause) });
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

const testid = <T extends HTMLElement = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);

async function mountPage(pageState: Record<string, string>, interfaces: unknown[] = [LINES, USAGE, PROBE], fail = new Set<string>()): Promise<void> {
  vi.spyOn(window, "postMessage").mockImplementation(host(pageState, interfaces, fail) as typeof window.postMessage);
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp(App);
  app.mount(root);
  await until(() => document.querySelector(".layer-tabs"), "the Lines layers");
}

async function paste(text: string): Promise<void> {
  const editor = await until(() => testid<HTMLTextAreaElement>("probe-editor"), "the probe editor");
  editor.value = text;
  editor.dispatchEvent(new Event("input"));
  await nextTick();
}

beforeEach(() => {
  resetUserStores();
  posted = [];
  window.localStorage?.clear();
  window.sessionStorage?.clear();
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
  (globalThis as { CSS?: { escape?: (value: string) => string } }).CSS ??= {};
  (globalThis as { CSS: { escape?: (value: string) => string } }).CSS.escape ??= (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("the Probe layer in the page", () => {
  it("sends the paste once, as the run payload, and nowhere else", async () => {
    await mountPage({ view: "probe" });
    await until(() => testid("probe-health")?.textContent?.includes("Probe ready"), "the probe's health");
    await paste(JSON.stringify(SAMPLE_CHAIN, null, 2));
    testid<HTMLButtonElement>("probe-run")!.click();
    await until(() => testid("probe-verdict"), "the verdict");
    // Let the debounced page state go out too.
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const carrying = posted.filter((entry) => JSON.stringify(entry.message).includes(SECRET));
    expect(carrying).toHaveLength(1);
    expect(carrying[0]!.message).toMatchObject({ type: "lattice.plugin.call", service: "latticenet.vpn-core/probe", method: "run" });
    expect(carrying[0]!.targetOrigin).toBe(HOST);
    expect(posted.filter((entry) => JSON.stringify(entry.message).includes(UUID))).toHaveLength(1);
    // Every message went to the pinned console origin.
    expect(posted.every((entry) => entry.targetOrigin === HOST)).toBe(true);
    // The page state names the layer and nothing else.
    for (const entry of posted.filter((item) => item.message.type === "lattice.plugin.state")) {
      expect(Object.keys(entry.message.state)).not.toContain("outbound");
      expect(JSON.stringify(entry.message.state)).not.toMatch(/vless|shadowsocks|198\.51/);
    }
    expect(location.href).not.toContain(SECRET);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(SECRET);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(SECRET);
    // Nothing outside the textarea shows the credentials.
    expect(document.body.textContent).not.toContain(SECRET);
    expect(document.body.textContent).not.toContain(UUID);
  });

  it("keeps the paste and the result across layers, and reads the probe only when the layer opens", async () => {
    await mountPage({ view: "overview" });
    await until(() => document.querySelector(".layer-tabs"), "the tabs");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const probeCalls = () => posted.filter((entry) => entry.message.type === "lattice.plugin.call" && entry.message.service === PROBE.service);
    expect(probeCalls()).toHaveLength(0);
    testid<HTMLButtonElement>("probe-tab")!.click();
    await until(() => testid("probe-health")?.textContent?.includes("Probe ready"), "the probe's health");
    expect(probeCalls().map((entry) => entry.message.method).sort()).toEqual(["health", "targets"]);
    await paste(JSON.stringify(SAMPLE_CHAIN[1]));
    testid<HTMLButtonElement>("probe-run")!.click();
    await until(() => testid("probe-verdict"), "the verdict");
    [...document.querySelectorAll<HTMLButtonElement>(".layer-tab")].find((tab) => tab.textContent?.startsWith("Overview"))!.click();
    await nextTick();
    expect(testid("probe-editor")).toBeNull();
    testid<HTMLButtonElement>("probe-tab")!.click();
    await until(() => testid("probe-verdict"), "the verdict again");
    expect(testid<HTMLTextAreaElement>("probe-editor")!.value).toBe(JSON.stringify(SAMPLE_CHAIN[1]));
    // Health and targets were read once; coming back does not read them again.
    expect(probeCalls().filter((entry) => entry.message.method !== "run")).toHaveLength(2);
  });

  it("stays usable when the fleet's lines could not be read", async () => {
    await mountPage({ view: "probe" }, [LINES, USAGE, PROBE], new Set(["lines/list", "lines/chains", "lines/managed"]));
    await until(() => testid("probe-health")?.textContent?.includes("Probe ready"), "the probe's health");
    expect(document.querySelector(".failure-state")).toBeNull();
    await paste(JSON.stringify(SAMPLE_CHAIN[1]));
    testid<HTMLButtonElement>("probe-run")!.click();
    await until(() => testid("probe-verdict"), "the verdict");
    // Another layer still says the lines read failed.
    [...document.querySelectorAll<HTMLButtonElement>(".layer-tab")].find((tab) => tab.textContent?.startsWith("Lines"))!.click();
    await until(() => document.querySelector(".failure-state"), "the failed read");
  });

  it("without vpn:probe the layer says so and the probe is never called", async () => {
    await mountPage({ view: "probe" }, [LINES, USAGE]);
    await until(() => testid("probe-denied"), "the denied state");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posted.some((entry) => entry.message.type === "lattice.plugin.call" && entry.message.service === PROBE.service)).toBe(false);
  });
});
