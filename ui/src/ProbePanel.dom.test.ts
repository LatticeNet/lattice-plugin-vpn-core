// @vitest-environment jsdom
import { createApp, h, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import ProbePanel from "./ProbePanel.vue";
import { UNDO_CLEAR_MS, useProbe, type ProbeDeps } from "./probe";
import type { ProbeMethod } from "./probeModel";
import { probeHandlers, SAMPLE_CHAIN, type ProbeScenario } from "../dev/probeFixtures";
import { LinkFixtureError } from "../dev/linkFixtures";

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
  return { host, probe, calls, cancelled, q, paste, run, shown, table, unmount: () => app.unmount() };
}

describe("the Probe layer's states", () => {
  it("before a test: says what a test asks, shows the probe's health, offers the targets", async () => {
    const { q, calls } = await mount();
    expect(calls.map((call) => call.method).sort()).toEqual(["health", "targets"]);
    expect(q("probe-empty")?.textContent).toMatch(/four questions in order/);
    expect(q("probe-health")?.textContent).toMatch(/Probe ready/);
    expect(q("probe-health")?.textContent).toMatch(/sing-box 1\.13\.19 · up 3 h 12 m · 1 of 32 busy/);
    const boxes = q("probe-targets")!.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    expect([...boxes].map((box) => [box.value, box.checked])).toEqual([
      ["gstatic-204", true], ["cloudflare-204", false], ["apple-success", false], ["custom-home-nas", false], ["custom-cdn-edge", false],
    ]);
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
    expect(q("probe-targets")!.querySelectorAll("input[type=checkbox]")).toHaveLength(5);
  });
});

describe("saved targets", () => {
  const ADMIN = () => true;
  const READ_ONLY = (method: ProbeMethod) => !method.startsWith("target_");
  const row = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-testid="probe-targets"] [data-target="${id}"]`)!;
  const type = async (input: HTMLInputElement | HTMLSelectElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input"));
    await settle();
  };
  const field = (host: HTMLElement, id: string) => host.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;

  it("lists saved targets by name beside the built-in ones, with what each checks", async () => {
    const { host, q } = await mount({ can: ADMIN });
    expect(q("probe-saved")?.textContent).toMatch(/Saved targets\s*2 of 32/);
    expect(row(host, "custom-home-nas").textContent).toMatch(/Home NAS health\s*nas\.home-lab\.example\.net:8443 · expects 200-299 · checks text/);
    expect(row(host, "custom-cdn-edge").textContent).toMatch(/CDN edge \(HEAD\)\s*edge\.cdn-provider\.example\.org · HEAD · expects 204,301-302/);
    expect(row(host, "custom-home-nas").querySelector('[data-testid="probe-target-edit"]')?.getAttribute("aria-label")).toBe("Edit Home NAS health");
    expect(q("probe-target-add")?.textContent).toMatch(/Add target/);
    expect(q("probe-target-readonly")).toBeNull();
  });

  it("adds a target: says what is wrong beside each field first, then saves and chooses it", async () => {
    const { host, q, calls } = await mount({ can: ADMIN });
    q<HTMLButtonElement>("probe-target-add")!.click();
    await settle();
    expect(document.activeElement).toBe(field(host, "probe-target-label"));
    // Save on an empty form names every problem and sends nothing.
    q("probe-target-form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();
    expect(q("probe-target-form")?.textContent).toMatch(/Give the target a name/);
    expect(q("probe-target-form")?.textContent).toMatch(/Enter the URL to request/);
    expect(document.activeElement).toBe(field(host, "probe-target-label"));
    expect(calls.some((call) => call.method === "target_create")).toBe(false);

    await type(field(host, "probe-target-label"), "Status page");
    await type(field(host, "probe-target-url"), "http://status.example.net/health");
    expect(q("probe-target-form")?.textContent).toMatch(/Saved targets use https/);
    await type(field(host, "probe-target-url"), "https://10.0.0.8/health");
    expect(q("probe-target-form")?.textContent).toMatch(/10\.0\.0\.8 is not a public address/);
    await type(field(host, "probe-target-url"), "https://status.example.net:8443/health?x=1");
    await type(field(host, "probe-target-status"), "301, 200-299");
    await type(field(host, "probe-target-body"), "All systems");
    expect(field(host, "probe-target-url").getAttribute("aria-invalid")).toBe("false");
    q<HTMLButtonElement>("probe-target-save")!.click();
    await settle();
    const create = calls.find((call) => call.method === "target_create")!;
    expect(create.payload).toEqual({ label: "Status page", url: "https://status.example.net:8443/health?x=1", method: "GET", expect_status: "200-299,301", body_contains: "All systems" });
    expect(q("probe-target-form")).toBeNull();
    const added = row(host, "custom-status-page");
    expect(added.textContent).toMatch(/Status page/);
    expect(added.querySelector<HTMLInputElement>("input")!.checked).toBe(true);
    expect(document.activeElement).toBe(added.querySelector("input"));
    expect(q("probe-saved")?.textContent).toMatch(/3 of 32/);
  });

  it("HEAD has no body: the body text stays in the form for GET but is not sent", async () => {
    const { host, q, calls } = await mount({ can: ADMIN });
    q<HTMLButtonElement>("probe-target-add")!.click();
    await settle();
    await type(field(host, "probe-target-label"), "Edge");
    await type(field(host, "probe-target-url"), "https://edge.example.net/");
    await type(field(host, "probe-target-body"), "ok");
    await type(field(host, "probe-target-method") as unknown as HTMLSelectElement, "HEAD");
    expect(field(host, "probe-target-body").disabled).toBe(true);
    expect(field(host, "probe-target-body").value).toBe("ok");
    expect(q("probe-target-form")?.textContent).toMatch(/Not sent with HEAD/);
    q<HTMLButtonElement>("probe-target-save")!.click();
    await settle();
    expect(calls.find((call) => call.method === "target_create")?.payload).toMatchObject({ method: "HEAD", body_contains: "" });
  });

  it("a URL pasted over the starting https:// does not repeat the scheme", async () => {
    const { host, q } = await mount({ can: ADMIN });
    q<HTMLButtonElement>("probe-target-add")!.click();
    await settle();
    await type(field(host, "probe-target-url"), "https://https://status.example.net/health");
    expect(field(host, "probe-target-url").value).toBe("https://status.example.net/health");
  });

  it("each field's name is its label alone; its help or error describes it", async () => {
    const { host, q } = await mount({ can: ADMIN });
    q<HTMLButtonElement>("probe-target-add")!.click();
    await settle();
    const url = field(host, "probe-target-url");
    expect(host.querySelector(`label[for="${url.id}"]`)?.textContent?.trim()).toBe("URL");
    expect(url.closest("label")).toBeNull();
    expect(host.querySelector(`#${url.getAttribute("aria-describedby")}`)?.textContent).toMatch(/https only/);
  });

  it("counts the chosen targets beside the list, and says when there are too many", async () => {
    const { host, q } = await mount({ can: ADMIN });
    expect(q("probe-targets-count")?.textContent?.trim()).toBe("1 of 16 chosen");
    row(host, "custom-home-nas").querySelector<HTMLInputElement>("input")!.click();
    await settle();
    expect(q("probe-targets-count")?.textContent?.trim()).toBe("2 of 16 chosen");
    expect(q("probe-targets-count")?.getAttribute("aria-live")).toBe("polite");
  });

  it("folds a long saved list to the first few and the chosen ones", async () => {
    const { host, q, table, probe } = await mount({ can: ADMIN });
    for (let i = 0; i < 9; i++) table["probe/target_create"]!({ label: `Extra ${i}`, url: `https://extra${i}.example.net/`, method: "GET", expect_status: "200" });
    await probe.reloadTargets();
    await settle();
    probe.chosenTargets.value = [...probe.chosenTargets.value, "custom-extra-8"];
    await settle();
    const rows = () => [...host.querySelectorAll<HTMLElement>(".probe-saved-row")].map((el) => el.dataset.target);
    expect(rows()).toHaveLength(7);
    expect(rows()).toContain("custom-extra-8");
    expect(q("probe-saved-fold")?.textContent).toMatch(/Show all 11 saved targets \(4 more\)/);
    q<HTMLButtonElement>("probe-saved-fold")!.click();
    await settle();
    expect(rows()).toHaveLength(11);
    expect(q("probe-saved-fold")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("a refusal from the server is said in the form, which stays open with what was typed", async () => {
    const { host, q } = await mount({ can: ADMIN });
    q<HTMLButtonElement>("probe-target-add")!.click();
    await settle();
    await type(field(host, "probe-target-label"), "Blocked");
    await type(field(host, "probe-target-url"), "https://refuse-me.example.net/");
    q<HTMLButtonElement>("probe-target-save")!.click();
    await settle();
    expect(q("probe-target-save-error")?.getAttribute("role")).toBe("alert");
    expect(q("probe-target-save-error")?.textContent).toMatch(/block list/);
    expect(field(host, "probe-target-url").value).toBe("https://refuse-me.example.net/");
  });

  it("edits a target under its own row by the version it read, and Escape returns the focus to its Edit button", async () => {
    const { host, q, calls } = await mount({ can: ADMIN });
    const edit = () => row(host, "custom-home-nas").querySelector<HTMLButtonElement>('[data-testid="probe-target-edit"]')!;
    edit().click();
    await settle();
    expect(q("probe-target-form")?.getAttribute("aria-label")).toBe("Edit Home NAS health");
    expect(row(host, "custom-home-nas").dataset.editing).toBe("true");
    // The form opens right under the row it edits, not under the whole list.
    expect(row(host, "custom-home-nas").nextElementSibling?.querySelector('[data-testid="probe-target-form"]')).not.toBeNull();
    expect(field(host, "probe-target-status").value).toBe("200-299");
    await type(field(host, "probe-target-status"), "200");
    q<HTMLButtonElement>("probe-target-save")!.click();
    await settle();
    const update = calls.find((call) => call.method === "target_update")!;
    expect(update.payload).toMatchObject({ id: "custom-home-nas", version: 3, expect_status: "200", body_contains: '"status":"ok"' });
    expect(row(host, "custom-home-nas").textContent).toMatch(/expects 200 ·/);

    row(host, "custom-home-nas").querySelector<HTMLButtonElement>('[data-testid="probe-target-edit"]')!.click();
    await settle();
    field(host, "probe-target-label").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    expect(q("probe-target-form")).toBeNull();
    expect(document.activeElement).toBe(edit());
  });

  it("after someone else's save, Reload keeps the fields this operator changed on top of their version", async () => {
    const { host, q, calls, table } = await mount({ can: ADMIN });
    row(host, "custom-home-nas").querySelector<HTMLButtonElement>('[data-testid="probe-target-edit"]')!.click();
    await settle();
    await type(field(host, "probe-target-url"), "https://nas.home-lab.example.net:8443/api/ready");
    // Another operator renames it meanwhile.
    table["probe/target_update"]!({ id: "custom-home-nas", version: 3, label: "Home NAS (renamed)", url: "https://nas.home-lab.example.net:8443/api/health?probe=lattice", method: "GET", expect_status: "200-299", body_contains: '"status":"ok"' });
    q<HTMLButtonElement>("probe-target-save")!.click();
    await settle();
    expect(q("probe-target-save-error")?.textContent).toMatch(/Someone changed this target/);
    [...q("probe-target-save-error")!.querySelectorAll("button")].find((button) => button.textContent?.includes("Reload targets"))!.click();
    await settle();
    expect(q("probe-target-notice")?.textContent).toMatch(/newer version.*your URL kept/);
    expect(field(host, "probe-target-label").value).toBe("Home NAS (renamed)");
    expect(field(host, "probe-target-url").value).toBe("https://nas.home-lab.example.net:8443/api/ready");
    expect(document.activeElement).toBe(field(host, "probe-target-label"));
    q<HTMLButtonElement>("probe-target-save")!.click();
    await settle();
    const updates = calls.filter((call) => call.method === "target_update");
    expect(updates.at(-1)!.payload).toMatchObject({ id: "custom-home-nas", version: 4, label: "Home NAS (renamed)", url: "https://nas.home-lab.example.net:8443/api/ready" });
    expect(q("probe-target-form")).toBeNull();
  });

  it("a target deleted elsewhere while it is edited can be saved as new or let go", async () => {
    const { host, q, calls, table } = await mount({ can: ADMIN });
    row(host, "custom-cdn-edge").querySelector<HTMLButtonElement>('[data-testid="probe-target-edit"]')!.click();
    await settle();
    table["probe/target_delete"]!({ id: "custom-cdn-edge", version: 1 });
    q<HTMLButtonElement>("probe-target-save")!.click();
    await settle();
    expect(q("probe-target-save-error")?.textContent).toMatch(/may have been deleted/);
    [...q("probe-target-save-error")!.querySelectorAll("button")].find((button) => button.textContent?.includes("Reload targets"))!.click();
    await settle();
    expect(host.querySelector('.probe-saved-row[data-target="custom-cdn-edge"]')).toBeNull();
    expect(q("probe-target-gone")?.textContent).toMatch(/deleted this target/);
    expect(q("probe-target-save")?.textContent).toMatch(/Save as new/);
    expect(field(host, "probe-target-label").value).toBe("CDN edge (HEAD)");
    q<HTMLButtonElement>("probe-target-save")!.click();
    await settle();
    expect(calls.find((call) => call.method === "target_create")?.payload).toMatchObject({ label: "CDN edge (HEAD)", method: "HEAD" });
    expect(row(host, "custom-cdn-edge-head")).not.toBeNull();
  });

  it("while a save is in flight, Cancel and Escape cannot pretend to stop it", async () => {
    let finish: (value: unknown) => void = () => {};
    const { host, q } = await mount({ can: ADMIN, answers: { target_create: () => new Promise((resolve) => { finish = resolve; }) } });
    q<HTMLButtonElement>("probe-target-add")!.click();
    await settle();
    await type(field(host, "probe-target-label"), "Slow");
    await type(field(host, "probe-target-url"), "https://slow.example.net/");
    q<HTMLButtonElement>("probe-target-save")!.click();
    await settle();
    expect(q<HTMLButtonElement>("probe-target-cancel")!.disabled).toBe(true);
    field(host, "probe-target-label").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    expect(q("probe-target-form")).not.toBeNull();
    finish({ id: "custom-slow", source: "custom", label: "Slow", url: "https://slow.example.net/", method: "GET", expect_status: "200-299", version: 1 });
    await settle();
    expect(q("probe-target-form")).toBeNull();
    expect(document.activeElement).toBe(row(host, "custom-slow").querySelector("input"));
  });

  it("a delete that fails says why and leaves the focus on its Delete button", async () => {
    const { host, q } = await mount({ can: ADMIN, answers: { target_delete: () => Promise.reject(new LinkFixtureError(500, "internal_error", "the saved probe targets could not be written")) } });
    row(host, "custom-cdn-edge").querySelector<HTMLButtonElement>('[data-testid="probe-target-delete"]')!.click();
    await settle();
    q<HTMLButtonElement>("probe-target-confirm-delete")!.click();
    await settle();
    expect(row(host, "custom-cdn-edge").querySelector('[role="alert"]')?.textContent).toMatch(/The saved probe targets could not be written/);
    expect(document.activeElement).toBe(row(host, "custom-cdn-edge").querySelector('[data-testid="probe-target-delete"]'));
  });

  it("a result keeps the names its targets had when it ran", async () => {
    const { host, q, paste, run } = await mount({ can: ADMIN });
    row(host, "custom-home-nas").querySelector<HTMLInputElement>("input")!.click();
    await settle();
    await paste(JSON.stringify(SAMPLE_CHAIN));
    await run();
    row(host, "custom-home-nas").querySelector<HTMLButtonElement>('[data-testid="probe-target-edit"]')!.click();
    await settle();
    await type(field(host, "probe-target-label"), "Renamed later");
    q<HTMLButtonElement>("probe-target-save")!.click();
    await settle();
    expect(row(host, "custom-home-nas").textContent).toMatch(/Renamed later/);
    expect(q("probe-targets-table")!.querySelector('[data-target="custom-home-nas"]')?.textContent).toMatch(/Home NAS health/);
  });

  it("a save that lost to someone else's says so and offers to read the list again", async () => {
    const { host, q, calls } = await mount({
      can: ADMIN,
      answers: { target_update: () => Promise.reject(new LinkFixtureError(409, "conflict", "someone changed this target since it was read; reload the list and try again")) },
    });
    row(host, "custom-cdn-edge").querySelector<HTMLButtonElement>('[data-testid="probe-target-edit"]')!.click();
    await settle();
    q<HTMLButtonElement>("probe-target-save")!.click();
    await settle();
    expect(q("probe-target-save-error")?.textContent).toMatch(/Someone changed this target/);
    const before = calls.filter((call) => call.method === "targets").length;
    [...q("probe-target-save-error")!.querySelectorAll("button")].find((button) => button.textContent?.includes("Reload targets"))!.click();
    await settle();
    expect(calls.filter((call) => call.method === "targets").length).toBe(before + 1);
  });

  it("deletes only after a confirm in the row, whose Keep has the focus", async () => {
    const { host, q, calls, paste, run } = await mount({ can: ADMIN });
    row(host, "custom-cdn-edge").querySelector<HTMLInputElement>("input")!.click();
    await settle();
    const remove = () => row(host, "custom-cdn-edge").querySelector<HTMLButtonElement>('[data-testid="probe-target-delete"]')!;
    remove().click();
    await settle();
    expect(row(host, "custom-cdn-edge").textContent).toMatch(/Delete CDN edge \(HEAD\)\?/);
    expect(document.activeElement?.textContent).toBe("Keep");
    (document.activeElement as HTMLButtonElement).click();
    await settle();
    expect(document.activeElement).toBe(remove());
    // Escape inside the confirm keeps the target too.
    remove().click();
    await settle();
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    expect(document.activeElement).toBe(remove());
    remove().click();
    await settle();
    q<HTMLButtonElement>("probe-target-confirm-delete")!.click();
    await settle();
    expect(calls.find((call) => call.method === "target_delete")?.payload).toEqual({ id: "custom-cdn-edge", version: 1 });
    expect(host.querySelector('[data-target="custom-cdn-edge"]')).toBeNull();
    expect(q("probe-targets-announce")?.textContent).toBe("Deleted CDN edge (HEAD).");
    // The focus goes to the saved target before it, the last one left.
    expect(document.activeElement).toBe(row(host, "custom-home-nas").querySelector('[data-testid="probe-target-delete"]'));
    await paste(JSON.stringify(SAMPLE_CHAIN));
    await run();
    expect(calls.find((call) => call.method === "run")!.payload.targets).toEqual(["gstatic-204"]);
  });

  it("a session without vpncore:admin runs saved targets but is told why it cannot change them", async () => {
    const { host, q, calls, paste, run } = await mount({ can: READ_ONLY });
    expect(q("probe-target-add")).toBeNull();
    expect(host.querySelector('[data-testid="probe-target-edit"], [data-testid="probe-target-delete"]')).toBeNull();
    expect(q("probe-target-readonly")?.textContent).toMatch(/needs vpncore:admin/);
    row(host, "custom-home-nas").querySelector<HTMLInputElement>("input")!.click();
    await settle();
    await paste(JSON.stringify(SAMPLE_CHAIN));
    await run();
    expect(calls.find((call) => call.method === "run")!.payload.targets).toEqual(["gstatic-204", "custom-home-nas"]);
    const tableRow = q("probe-targets-table")!.querySelector('[data-target="custom-home-nas"]')!;
    expect(tableRow.textContent).toMatch(/Home NAS health\s*HTTP 200 · text found/);
  });

  it("while the probe cannot run saved targets, they are listed, not offered, and the reason is said", async () => {
    const { host, q } = await mount({ scenario: "outdated", can: ADMIN });
    expect(q("probe-saved-outdated")?.textContent).toMatch(/cannot run yet: lattice-probe 0\.1\.0-alpha\.2 does not run saved targets; a newer lattice-probe does\. Updating lattice-probe lets them run/);
    expect(row(host, "custom-home-nas").querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
    expect(q("probe-target-add")).not.toBeNull();
  });

  it("without the edit scope, an outdated probe's note does not promise a run, and an empty list is not shown", async () => {
    const outdated = await mount({ scenario: "outdated", can: READ_ONLY });
    expect(outdated.q("probe-target-readonly")?.textContent).not.toMatch(/Running them/);
    outdated.unmount();
    document.body.innerHTML = "";
    const empty = await mount({ scenario: "nosaved", can: READ_ONLY });
    expect(empty.q("probe-saved")).toBeNull();
  });

  it("an older server answers built-in targets only, and the page offers nothing it cannot keep", async () => {
    const { q } = await mount({ scenario: "oldserver", can: ADMIN });
    const boxes = q("probe-targets")!.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    expect([...boxes].map((box) => box.value)).toEqual(["gstatic-204", "cloudflare-204", "apple-success"]);
    expect(q("probe-saved")).toBeNull();
    expect(q("probe-target-add")).toBeNull();
    expect(q("probe-targets")?.textContent).toMatch(/www\.gstatic\.com · expects 204/);
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
