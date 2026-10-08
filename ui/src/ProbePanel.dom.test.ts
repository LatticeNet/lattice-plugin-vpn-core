// @vitest-environment jsdom
import { createApp, h, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import ProbePanel from "./ProbePanel.vue";
import { UNDO_CLEAR_MS, useProbe, type ProbeDeps } from "./probe";
import type { ProbeMethod } from "./probeModel";
import { probeHandlers, SAMPLE_CHAIN, type ProbeScenario } from "../dev/probeFixtures";

const SECRET = "c2FtcGxlLW9ubHktbm90LXJlYWw=";
const UUID = "4b1f2c9e-8a3d-4e5f-9b6a-7c8d9e0f1a2b";
const RELAY = SAMPLE_CHAIN[1]!;

type Answer = (payload: Record<string, unknown>) => unknown;

const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await nextTick();
  }
};

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

/** True when `first` comes before `second` in the document, the order a reader and a screen reader meet them. */
const before = (first: Element, second: Element) => !!(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

interface MountOptions {
  scenario?: ProbeScenario;
  can?: (method: ProbeMethod) => boolean;
  answers?: Partial<Record<ProbeMethod, Answer>>;
}

async function mount(options: MountOptions = {}) {
  const table = probeHandlers(options.scenario ?? "ok");
  const calls: Array<{ method: ProbeMethod; payload: Record<string, unknown> }> = [];
  const cancelled: ProbeMethod[] = [];
  const deps: ProbeDeps = {
    call: <T,>(method: ProbeMethod, payload: Record<string, unknown>) => {
      calls.push({ method, payload });
      const answer = options.answers?.[method] ?? (table[`probe/${method}`] as Answer);
      const promise = (async () => (await answer(payload)) as T)();
      return { promise, cancel: () => { cancelled.push(method); } };
    },
    can: options.can ?? (() => true),
  };
  const probe = useProbe(deps);
  probe.open();
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ render: () => h(ProbePanel, { probe }) });
  app.mount(host);
  await settle();
  const q = <T extends HTMLElement = HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`);
  const paste = async (text: string) => {
    const editor = q<HTMLTextAreaElement>("probe-editor")!;
    editor.value = text;
    editor.dispatchEvent(new Event("input"));
    await settle();
  };
  const run = async () => {
    q<HTMLButtonElement>("probe-run")!.click();
    await settle();
  };
  /** Everything the operator can read on the page except the textarea itself. */
  const shown = () => host.textContent ?? "";
  return { host, probe, calls, cancelled, q, paste, run, shown, unmount: () => app.unmount() };
}

describe("the Probe layer's states", () => {
  it("before a test: says what a test asks, shows the probe's health, offers the targets", async () => {
    const { q, calls } = await mount();
    expect(calls.map((call) => call.method).sort()).toEqual(["health", "targets"]);
    expect(q("probe-empty")?.textContent).toMatch(/four questions in order/);
    expect(q("probe-health")?.textContent).toMatch(/Probe ready/);
    expect(q("probe-health")?.textContent).toMatch(/sing-box 1\.13\.19 · up 3 h 12 m · 1 of 32 busy/);
    const boxes = q("probe-targets")!.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    expect([...boxes].map((box) => [box.value, box.checked])).toEqual([["gstatic-204", true], ["cloudflare-204", false], ["apple-success", false]]);
    // Nothing pasted, nothing to run.
    expect(q<HTMLButtonElement>("probe-run")!.disabled).toBe(true);
    expect(q<HTMLInputElement>("probe-throughput")!.checked).toBe(false);
  });

  it("probe unavailable: says why above the editor, keeps the editor, and will not run", async () => {
    const { q, paste, calls } = await mount({ scenario: "unavailable" });
    expect(q("probe-unavailable")?.textContent).toMatch(/not running on this control plane/);
    expect(q("probe-unavailable")?.textContent).toMatch(/probe\.sock/);
    // Stacked on a phone, the reason comes before the form, not under it.
    expect(before(q("probe-unavailable")!, q("probe-editor")!)).toBe(true);
    const healthReads = calls.filter((call) => call.method === "health").length;
    [...q("probe-unavailable")!.querySelectorAll("button")].find((button) => button.textContent?.includes("Check again"))!.click();
    await settle();
    expect(calls.filter((call) => call.method === "health")).toHaveLength(healthReads + 1);
    expect(q("probe-health")?.textContent).toMatch(/Probe unavailable/);
    await paste(JSON.stringify(RELAY));
    expect(q<HTMLButtonElement>("probe-run")!.disabled).toBe(true);
    expect(q("probe-result")?.closest(".probe-layout")?.textContent).toMatch(/The probe is not answering, so tests cannot run/);
    expect(calls.some((call) => call.method === "run")).toBe(false);
  });

  it("scope denied from init: the layer says which scope it needs and calls nothing", async () => {
    const { q, calls } = await mount({ can: () => false });
    expect(q("probe-denied")?.textContent).toMatch(/needs vpn:probe/);
    expect(q("probe-editor")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("scope denied by the server: a 403 on run turns the layer into the denied state", async () => {
    const { q, paste, run } = await mount({ scenario: "denied", answers: { health: () => ({ available: true, engine: "sing-box", core_version: "1.13.19" }) } });
    await paste(JSON.stringify(RELAY));
    await run();
    expect(q("probe-denied")).not.toBeNull();
  });

  it("running: shows what is being tested and the clock, and Cancel stops waiting", async () => {
    let resolve: (value: unknown) => void = () => {};
    const { q, paste, run, cancelled, probe } = await mount({ answers: { run: () => new Promise((done) => { resolve = done; }) } });
    await paste(JSON.stringify(SAMPLE_CHAIN, null, 2));
    await run();
    expect(q("probe-running")?.textContent).toMatch(/Testing exit \(vless\) via relay/);
    expect(q("probe-running")?.textContent).toMatch(/The probe stops by 15 s/);
    expect(q("probe-running-note")?.textContent).toMatch(/Testing, 0 s/);
    expect(q("probe-run")).toBeNull();
    q<HTMLButtonElement>("probe-cancel")!.click();
    await settle();
    expect(cancelled).toEqual(["run"]);
    expect(q("probe-failure")?.dataset.kind).toBe("cancelled");
    expect(q("probe-failure")?.textContent).toMatch(/removes the outbound it created/);
    // The answer that arrives after a cancel is not drawn.
    resolve(probeHandlers("ok")["probe/run"]!({ outbounds: SAMPLE_CHAIN, test: "exit", targets: ["gstatic-204"], samples: 5 }));
    await settle();
    expect(q("probe-verdict")).toBeNull();
    expect(probe.phase.value).toBe("failed");
  });

  it("success: verdict, the four passed stages, the facts and the per-target table", async () => {
    const { q, paste, run, calls } = await mount();
    await paste(JSON.stringify(SAMPLE_CHAIN, null, 2));
    q("probe-targets")!.querySelectorAll<HTMLInputElement>("input")[1]!.click();
    await settle();
    await run();
    const sent = calls.find((call) => call.method === "run")!.payload;
    expect(sent).toMatchObject({ test: "exit", targets: ["gstatic-204", "cloudflare-204"], samples: 5, udp: true, throughput: false, throughput_bytes: 0, timeout_ms: 15_000 });
    expect(sent.outbounds).toEqual(SAMPLE_CHAIN);
    expect(q("probe-verdict")?.dataset.stage).toBe("ok");
    expect(q("probe-verdict")?.textContent).toMatch(/^Works/);
    expect([...q("probe-track")!.querySelectorAll("li")].map((li) => li.dataset.state)).toEqual(["pass", "pass", "pass", "pass"]);
    expect(q("probe-facts")?.textContent).toMatch(/198\.51\.100\.24:34656/);
    expect(q("probe-facts")?.textContent).toMatch(/162\.196\.9\.138/);
    expect(q("probe-facts")?.textContent).toMatch(/US · LAX/);
    expect(q("probe-facts")?.textContent).toMatch(/80\.3 ms/);
    // Throughput was not asked for, so it is not listed as a finding.
    expect(q("probe-facts")?.querySelector("[data-fact=throughput]")).toBeNull();
    const rows = q("probe-targets-table")!.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toMatch(/gstatic-204\s*HTTP 204\s*5 of 5\s*250\.4\s*272\.9\s*306\.6/);
    expect(q("probe-proof")?.textContent).toMatch(/· took 1\.84 s\s*· sing-box 1\.13\.19/);
  });

  it("works with losses: says how many answered and marks the targets step partial", async () => {
    const { q, paste, run } = await mount({ scenario: "loss" });
    await paste(JSON.stringify(RELAY));
    await run();
    expect(q("probe-verdict")?.textContent).toMatch(/Works, with losses/);
    expect(q("probe-verdict")?.textContent).toMatch(/3 of 5 requests/);
    expect([...q("probe-track")!.querySelectorAll("li")].map((li) => li.dataset.state)).toEqual(["pass", "pass", "pass", "partial"]);
  });

  const stages: Array<[ProbeScenario, RegExp, string[]]> = [
    ["decode", /sing-box cannot read this outbound/, ["fail", "skip", "skip", "skip"]],
    ["create", /refused to create/, ["fail", "skip", "skip", "skip"]],
    ["server", /The server does not answer/, ["pass", "fail", "skip", "skip"]],
    ["handshake", /The proxy handshake failed/, ["pass", "pass", "fail", "skip"]],
    ["target", /No target answered through the proxy/, ["pass", "pass", "pass", "fail"]],
    ["timeout", /The test ran out of time/, ["pass", "pass", "pass", "timeout"]],
  ];
  for (const [scenario, title, track] of stages) {
    it(`failing stage ${scenario}: says it in plain words, with the probe's own line`, async () => {
      const { q, paste, run } = await mount({ scenario });
      await paste(JSON.stringify(RELAY));
      await run();
      expect(q("probe-verdict")?.dataset.stage).toBe(scenario);
      expect(q("probe-verdict")?.textContent).toMatch(title);
      expect(q("probe-error")?.textContent?.length).toBeGreaterThan(0);
      expect([...q("probe-track")!.querySelectorAll("li")].map((li) => li.dataset.state)).toEqual(track);
    });
  }

  it("a target with no answered sample draws no figure, and every target's own line sits under its row", async () => {
    const { q, paste, run } = await mount({ scenario: "timeout" });
    await paste(JSON.stringify(RELAY));
    q("probe-targets")!.querySelectorAll<HTMLInputElement>("input")[1]!.click();
    await settle();
    await run();
    const table = q("probe-targets-table")!;
    const first = table.querySelector('[data-target="gstatic-204"]')!;
    const second = table.querySelector('[data-target="cloudflare-204"]')!;
    expect(first.querySelector(".probe-no-sample")).toBeNull();
    expect(first.querySelector(".probe-target-error")?.textContent).toMatch(/3 of 5 samples did not answer/);
    expect(second.querySelector(".probe-no-sample")?.textContent).toBe("no sample answered");
    expect(second.textContent).not.toMatch(/0\.0/);
  });

  it("rate limited: says so with the server's retry time, and does not invite a run it would refuse", async () => {
    const { q, paste, run } = await mount({ scenario: "limited" });
    await paste(JSON.stringify(RELAY));
    await run();
    expect(q("probe-failure")?.dataset.kind).toBe("rate_limited");
    expect(q("probe-failure")?.textContent).toMatch(/Rate limited/);
    expect(q("probe-failure")?.textContent).toMatch(/next run is allowed in 14 minutes/);
    expect(q("probe-failure")?.textContent).not.toMatch(/Run again/);
  });

  it("a health read that failed is said above the editor too", async () => {
    const { q } = await mount({ answers: { health: () => Promise.reject(new Error("upstream 502")) } });
    expect(q("probe-health-error")?.textContent).toMatch(/upstream 502/);
    expect(before(q("probe-health-error")!, q("probe-editor")!)).toBe(true);
  });

  it("an HTTP pass with a failed UDP query and download is a warning, and the failed figures say so", async () => {
    const { q, paste, run } = await mount({ scenario: "degraded" });
    await paste(JSON.stringify(SAMPLE_CHAIN));
    q<HTMLInputElement>("probe-throughput")!.click();
    await settle();
    await run();
    const verdict = q("probe-verdict")!;
    expect(verdict.dataset.stage).toBe("ok");
    expect(verdict.dataset.tone).toBe("warning");
    expect(verdict.querySelector("strong")?.textContent).toBe("Works for HTTP, UDP and the download failed");
    const udp = q("probe-facts")!.querySelector<HTMLElement>("[data-fact=udp]")!;
    expect(udp.dataset.tone).toBe("error");
    expect(udp.textContent).toMatch(/Failed\s*read udp: i\/o timeout/);
    expect(q("probe-facts")!.querySelector<HTMLElement>("[data-fact=throughput]")?.dataset.tone).toBe("error");
    expect(q("probe-facts")!.querySelector<HTMLElement>("[data-fact=exit]")?.dataset.tone).toBeUndefined();
  });

  it("policy refusal: says what the probe refused and does not invite the same run again", async () => {
    const { q, paste, run } = await mount({ scenario: "refused" });
    await paste(JSON.stringify(RELAY));
    await run();
    expect(q("probe-failure")?.dataset.kind).toBe("refused");
    expect(q("probe-failure")?.textContent).toMatch(/private address/);
    expect(q("probe-failure")?.textContent).not.toMatch(/Run again/);
  });

  it("the console's timeout and an answer that is not a result are each said as such", async () => {
    const timedOut = await mount({ answers: { run: () => Promise.reject(Object.assign(new Error("plugin request timed out"), { code: "timeout" })) } });
    await timedOut.paste(JSON.stringify(RELAY));
    await timedOut.run();
    expect(timedOut.q("probe-failure")?.dataset.kind).toBe("timeout");
    expect(timedOut.q("probe-failure")?.textContent).toMatch(/console stopped waiting/);
    // A new run measures again; it does not fetch the answer the console gave up on.
    expect(timedOut.q("probe-failure")?.textContent).toMatch(/cannot be recovered\. Running again starts a new test/);
    expect(timedOut.q("probe-failure")?.textContent).not.toMatch(/run it again to see/);
    timedOut.unmount();
    document.body.innerHTML = "";

    const garbled = await mount({ scenario: "garbled" });
    await garbled.paste(JSON.stringify(RELAY));
    await garbled.run();
    expect(garbled.q("probe-failure")?.dataset.kind).toBe("failed");
    expect(garbled.q("probe-failure")?.textContent).toMatch(/not a probe result/);
  });

  it("keeps the keyboard's focus on one button as Run turns into Cancel and back", async () => {
    let resolve: (value: unknown) => void = () => {};
    const { q, paste } = await mount({ answers: { run: () => new Promise((done) => { resolve = done; }) } });
    await paste(JSON.stringify(RELAY));
    const button = q<HTMLButtonElement>("probe-run")!;
    button.focus();
    button.click();
    await settle();
    expect(q("probe-cancel")).toBe(button);
    expect(button.textContent).toMatch(/Cancel/);
    expect(document.activeElement).toBe(button);
    resolve(probeHandlers("ok")["probe/run"]!({ outbounds: [RELAY], test: "relay", targets: ["gstatic-204"], samples: 5 }));
    await settle();
    expect(q("probe-verdict")).not.toBeNull();
    expect(q("probe-run")).toBe(button);
    expect(document.activeElement).toBe(button);
    // The same key press starts a run and stops it.
    button.click();
    await settle();
    button.click();
    await settle();
    expect(q("probe-failure")?.dataset.kind).toBe("cancelled");
    expect(document.activeElement).toBe(button);
    // Run again leaves with its card; the focus goes to the button that now cancels.
    q<HTMLButtonElement>("probe-run-again")!.click();
    await settle();
    expect(q("probe-cancel")).toBe(button);
    expect(document.activeElement).toBe(button);
  });

  it("announces the start and the end once each, and keeps the clock and the figures out of live regions", async () => {
    let resolve: (value: unknown) => void = () => {};
    const { q, paste, run } = await mount({ answers: { run: () => new Promise((done) => { resolve = done; }) } });
    const live = () => [...q("probe-result")!.querySelectorAll<HTMLElement>("[aria-live], [role=status], [role=alert]")];
    await paste(JSON.stringify(SAMPLE_CHAIN));
    await run();
    expect(live()).toEqual([q("probe-announce")]);
    expect(q("probe-announce")?.textContent).toBe("Testing exit (vless) via relay");
    // The running block with its ticking seconds is not announced.
    expect(q("probe-running")?.closest("[aria-live], [role=status], [role=alert]")).toBeNull();
    resolve(probeHandlers("ok")["probe/run"]!({ outbounds: SAMPLE_CHAIN, test: "exit", targets: ["gstatic-204"], samples: 5, udp: true }));
    await settle();
    expect(q("probe-announce")?.textContent).toBe("Works");
    expect(live()).toEqual([q("probe-announce")]);
    expect(q("probe-targets-table")?.closest("[aria-live], [role=status], [role=alert]")).toBeNull();
  });

  it("announces a failed run with its reason", async () => {
    const { q, paste, run } = await mount({ scenario: "limited" });
    await paste(JSON.stringify(RELAY));
    await run();
    expect(q("probe-announce")?.textContent).toMatch(/^Rate limited\. Probe runs are limited to 120 per hour/);
    expect(q("probe-failure")?.getAttribute("role")).toBeNull();
  });

  it("targets that cannot be read say so and can be read again", async () => {
    let fail = true;
    const { q } = await mount({ answers: { targets: () => (fail ? Promise.reject(new Error("upstream 502")) : probeHandlers("ok")["probe/targets"]!({})) } });
    expect(q("probe-targets")?.textContent).toMatch(/upstream 502/);
    expect(q("probe-result")?.closest(".probe-layout")?.textContent).toMatch(/targets could not be read, so tests cannot run/);
    fail = false;
    [...q("probe-targets")!.querySelectorAll("button")].find((button) => button.textContent?.includes("Try again"))!.click();
    await settle();
    expect(q("probe-targets")!.querySelectorAll("input")).toHaveLength(3);
  });
});

describe("the editor", () => {
  it("reads as the operator types: a fault by line and column, a good paste by count and size", async () => {
    const { q, paste, host } = await mount();
    await paste('{\n  "type": "vless",\n}');
    expect(q("probe-read")?.dataset.tone).toBe("error");
    expect(q("probe-read")?.textContent).toMatch(/Line 2, column 18: A trailing comma/);
    expect(q("probe-editor")?.getAttribute("aria-invalid")).toBe("true");
    await paste(JSON.stringify(SAMPLE_CHAIN));
    expect(q("probe-read")?.textContent).toMatch(/2 outbounds read/);
    expect(host.querySelector(".probe-size")?.textContent).toMatch(/^0\.\d KB of 64 KB$/);
    expect(q("probe-outbounds")?.querySelectorAll("li")).toHaveLength(2);
    expect(q("probe-outbounds")?.querySelector('[data-tested="true"]')?.textContent).toMatch(/exit/);
  });

  it("Show in editor scrolls to where a wrapped fault is drawn, without copying the paste", async () => {
    const { q, paste } = await mount();
    // Minified, with the comma between the two outbounds gone: one logical line, the fault far along it.
    const text = JSON.stringify(SAMPLE_CHAIN).replace('"relay"},{', '"relay"}{');
    await paste(text);
    expect(q("probe-read")?.textContent).toMatch(/Line 1, column \d+: Expected a comma or a closing bracket/);
    const editor = q<HTMLTextAreaElement>("probe-editor")!;
    let top = 0;
    Object.defineProperty(editor, "scrollTop", { configurable: true, get: () => top, set: (value: number) => { top = value; } });
    Object.defineProperty(editor, "clientHeight", { configurable: true, value: 270 });
    Object.defineProperty(editor, "clientWidth", { configurable: true, value: 300 });
    // jsdom lays nothing out: a 40-column, 18px-line wrap stands in for the browser's.
    const laidOut: string[] = [];
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop")!;
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get(this: HTMLElement) {
        const copy = this.parentElement;
        if (copy?.getAttribute("aria-hidden") !== "true") return 0;
        laidOut.push(copy.textContent ?? "");
        return 12 + Math.floor((copy.textContent!.length - 1) / 40) * 18;
      },
    });
    try {
      q<HTMLButtonElement>("probe-show-fault")!.click();
    } finally {
      Object.defineProperty(HTMLElement.prototype, "offsetTop", original);
    }
    const offset = text.indexOf("}{") + 1;
    expect(editor.selectionStart).toBe(offset);
    expect(top).toBe(12 + Math.floor(offset / 40) * 18 - 270 / 3);
    expect(top).toBeGreaterThan(0);
    // The copy measured had the paste's shape and none of its credentials, and it is gone.
    expect(laidOut).toHaveLength(1);
    expect(laidOut[0]).toHaveLength(offset + 1);
    expect(laidOut[0]).not.toContain(UUID);
    expect(laidOut[0]).not.toMatch(/vless|relay|198\.51/);
    expect(document.body.querySelector("div[aria-hidden=true]")).toBeNull();
  });

  it("Run on a broken paste names the fault and selects it inside the textarea", async () => {
    const { q, paste, run, calls } = await mount();
    const text = '{\n  "type": "vless",\n  "tag": "exit",\n  "server": "198.51.100.24"\n  "server_port": 443\n}';
    await paste(text);
    await run();
    const editor = q<HTMLTextAreaElement>("probe-editor")!;
    expect(q("probe-run-note")?.textContent).toMatch(/Expected a comma or a closing brace/);
    expect(document.activeElement).toBe(editor);
    expect(editor.selectionStart).toBe(text.indexOf('"server_port"'));
    expect(calls.some((call) => call.method === "run")).toBe(false);
    // Show in editor does the same from the status line.
    editor.blur();
    q<HTMLButtonElement>("probe-show-fault")!.click();
    expect(document.activeElement).toBe(editor);
  });

  it("picks the chain's end, lets the operator test another hop, and sends that hop alone", async () => {
    const { q, paste, run, calls } = await mount();
    await paste(JSON.stringify(SAMPLE_CHAIN));
    const picker = q<HTMLSelectElement>("probe-test")!;
    expect(picker.value).toBe("exit");
    expect([...picker.options].map((option) => option.textContent)).toEqual(["exit (vless) via relay", "relay (shadowsocks)"]);
    expect(q("probe-outbounds")?.querySelectorAll('[data-sent="true"]')).toHaveLength(2);
    picker.value = "relay";
    picker.dispatchEvent(new Event("change"));
    await settle();
    // The exit stays in the editor, marked as left out of the run.
    const exitRow = q("probe-outbounds")!.querySelectorAll<HTMLElement>("li")[0]!;
    expect(exitRow.dataset.sent).toBe("false");
    expect(exitRow.textContent).toMatch(/not in this test/);
    await run();
    const sent = calls.find((call) => call.method === "run")!.payload;
    expect(sent.test).toBe("relay");
    expect(sent.outbounds).toEqual([RELAY]);
    expect(JSON.stringify(sent)).not.toContain(UUID);
  });

  it("hides the picker for one outbound, and Ctrl+Enter runs from the textarea", async () => {
    const { q, paste, calls } = await mount();
    await paste(JSON.stringify(RELAY));
    expect(q("probe-test")).toBeNull();
    q("probe-editor")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    await settle();
    expect(calls.find((call) => call.method === "run")?.payload.test).toBe("relay");
  });

  it("sends the throughput size only when throughput is on, capped at 25 MB", async () => {
    const { q, paste, run, calls } = await mount();
    await paste(JSON.stringify(RELAY));
    expect(q("probe-throughput-bytes")).toBeNull();
    q<HTMLInputElement>("probe-throughput")!.click();
    await settle();
    const sizes = [...q<HTMLSelectElement>("probe-throughput-bytes")!.options].map((option) => option.textContent);
    expect(sizes).toEqual(["1 MB", "5 MB", "10 MB", "25 MB"]);
    await run();
    expect(calls.find((call) => call.method === "run")?.payload).toMatchObject({ throughput: true, throughput_bytes: 5_000_000, timeout_ms: 30_000 });
    expect(q("probe-facts")?.textContent).toMatch(/48\.3 Mbit\/s/);
  });

  it("opts the textarea out of spell checking, autocorrect and password managers", async () => {
    const { q } = await mount();
    const editor = q("probe-editor")!;
    expect(editor.getAttribute("spellcheck")).toBe("false");
    expect(editor.getAttribute("autocomplete")).toBe("off");
    expect(editor.getAttribute("autocorrect")).toBe("off");
    expect(editor.getAttribute("autocapitalize")).toBe("off");
    expect(editor.getAttribute("data-gramm")).toBe("false");
    expect(editor.getAttribute("data-1p-ignore")).toBe("true");
    expect(editor.getAttribute("data-lpignore")).toBe("true");
  });

  it("never shows the paste's secrets outside the textarea, whatever happens", async () => {
    for (const scenario of ["ok", "decode", "handshake", "refused", "limited"] as ProbeScenario[]) {
      const page = await mount({ scenario });
      await page.paste(JSON.stringify(SAMPLE_CHAIN, null, 2));
      await page.run();
      expect(page.shown(), scenario).not.toContain(SECRET);
      expect(page.shown(), scenario).not.toContain(UUID);
      await page.paste(JSON.stringify(SAMPLE_CHAIN).slice(0, -3));
      expect(page.shown(), scenario).not.toContain(SECRET);
      page.unmount();
      document.body.innerHTML = "";
    }
  });

  it("Clear forgets the paste and the result", async () => {
    const { q, paste, run, probe } = await mount();
    await paste(JSON.stringify(RELAY));
    await run();
    expect(q("probe-verdict")).not.toBeNull();
    q<HTMLButtonElement>("probe-clear")!.click();
    await settle();
    expect(probe.draft.value).toBe("");
    expect(q<HTMLTextAreaElement>("probe-editor")!.value).toBe("");
    expect(q("probe-verdict")).toBeNull();
    expect(q("probe-empty")).not.toBeNull();
  });

  it("Clear can be undone until the next edit or for a few seconds, and the focus goes to Undo", async () => {
    const { q, paste, probe } = await mount();
    const text = JSON.stringify(SAMPLE_CHAIN);
    await paste(text);
    const picker = q<HTMLSelectElement>("probe-test")!;
    picker.value = "relay";
    picker.dispatchEvent(new Event("change"));
    await settle();
    q<HTMLButtonElement>("probe-clear")!.click();
    await settle();
    expect(probe.draft.value).toBe("");
    expect(q("probe-read")?.textContent).toMatch(/Cleared\./);
    expect(document.activeElement).toBe(q("probe-undo-clear"));
    q<HTMLButtonElement>("probe-undo-clear")!.click();
    await settle();
    expect(probe.draft.value).toBe(text);
    expect(probe.test.value).toBe("relay");
    expect(q("probe-undo-clear")).toBeNull();
    expect(document.activeElement).toBe(q("probe-clear"));

    // Something typed after Clear is the new draft; the old one is not offered back over it.
    q<HTMLButtonElement>("probe-clear")!.click();
    await settle();
    await paste("{");
    await paste("");
    expect(q("probe-undo-clear")).toBeNull();
    expect(probe.undoClear()).toBe(false);

    // And the offer runs out.
    await paste(text);
    vi.useFakeTimers();
    q<HTMLButtonElement>("probe-clear")!.click();
    await settle();
    expect(q("probe-undo-clear")).not.toBeNull();
    vi.advanceTimersByTime(UNDO_CLEAR_MS);
    await settle();
    expect(q("probe-undo-clear")).toBeNull();
    expect(probe.undoClear()).toBe(false);
    expect(probe.draft.value).toBe("");
  });

  it("Format re-indents a paste that reads, and only that", async () => {
    const { q, paste, probe } = await mount();
    await paste("{}x");
    expect(q<HTMLButtonElement>("probe-format")!.disabled).toBe(true);
    await paste(JSON.stringify(RELAY));
    q<HTMLButtonElement>("probe-format")!.click();
    await settle();
    expect(probe.draft.value).toBe(JSON.stringify(RELAY, null, 2));
  });
});
