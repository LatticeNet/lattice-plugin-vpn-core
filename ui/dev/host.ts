/**
 * A stand-in for the dashboard host, for looking at the plugin in a browser.
 *
 * This is deliberately not a mock of the UI: it runs the real plugin build in a
 * real iframe and speaks the real bridge protocol at it, including the frame
 * model production actually uses. The pane fills the console's main region and
 * the iframe fills the pane, so the frame IS the plugin's viewport: the plugin
 * document scrolls inside it, there is one scrollbar, and `100vh`,
 * `position: fixed` and `position: sticky` resolve against the visible window.
 *
 * The host accepts `lattice.plugin.resize` for protocol compatibility and does
 * not wire it to layout, exactly as PluginFrameHost.vue does. The reported
 * number is printed in the bar so a plugin that still tries to drive its own
 * frame height is visible here rather than only in production.
 *
 * It keeps the plugin's page state in its own address the way the console
 * does (bridge v1, "Plugin page state in the console address"): every query
 * key that is not one of the harness's own is page state, handed to the
 * plugin as `pageState` in init, and a `lattice.plugin.state` replaces those
 * keys with a history replace, without reloading the frame. `oldhost=1`
 * plays a host that predates the contract: no `pageState`, messages ignored.
 */

import { filterPageState, validPageState, type PageState } from "../src/pageState";
import { handlers, SCENARIOS, type Scenario } from "./fixtures";
import { LinkFixtureError } from "./linkFixtures";

const ROUTES = ["lines", "users", "profiles", "usage"] as const;
type Route = (typeof ROUTES)[number];

const PLUGIN_ID = "latticenet.vpn-core";
const NONCE = "dev-harness-nonce-000000";

const INTERFACES = [
  {
    service: "latticenet.vpn-core/lines",
    methods: ["list", "get", "chains", "managed", "rollout", "plan_chain", "plan_remove_chain", "sync_metadata", "reattach"],
  },
  { service: "latticenet.vpn-core/users", methods: ["list"] },
  {
    service: "latticenet.vpn-core/users-admin",
    methods: ["create", "update", "delete", "bind", "unbind", "rotate", "plan_add", "plan_update", "plan_remove", "usage_query",
      "link_get", "link_issue", "link_set", "link_revoke", "link_rotate", "link_reveal"],
  },
  { service: "latticenet.vpn-core/profiles", methods: ["query", "settings", "configure"] },
  { service: "latticenet.vpn-core/usage", methods: ["query"] },
];

/* The console's production theme (teal on slate, lattice-dashboard
 * src/style/app.css and src/theme/palettes.ts), so colours are judged on
 * what the plugin will actually receive. */
const CHART_ACCENTS = {
  "--chart-2": "oklch(0.62 0.16 195)", "--chart-3": "oklch(0.66 0.18 142)",
  "--chart-4": "oklch(0.74 0.17 60)", "--chart-5": "oklch(0.64 0.22 12)",
};
const DARK: Record<string, string> = {
  "--background": "oklch(0.155 0.012 240)", "--foreground": "oklch(0.97 0.004 240)", "--card": "oklch(0.195 0.014 240)",
  "--border": "oklch(1 0 0 / 9%)", "--muted": "oklch(0.255 0.014 240)", "--muted-foreground": "oklch(0.705 0.012 240)",
  "--primary": "oklch(0.81 0.13 180)", "--primary-foreground": "oklch(0.17 0.012 240)",
  "--destructive": "oklch(0.704 0.191 22.2)", "--ring": "oklch(0.7 0.12 182)",
  "--success": "oklch(0.706 0.15 156)", "--warning": "oklch(0.8 0.16 80)", "--info": "oklch(0.7 0.12 210)",
  "--success-text": "oklch(0.706 0.15 156)", "--warning-text": "oklch(0.8 0.16 80)", "--info-text": "oklch(0.7 0.12 210)",
  "--chart-1": "oklch(0.81 0.13 180)", ...CHART_ACCENTS,
};
const LIGHT: Record<string, string> = {
  "--background": "oklch(0.99 0.0015 280)", "--foreground": "oklch(0.21 0.02 281)", "--card": "oklch(1 0 0)",
  "--border": "oklch(0.91 0.006 281)", "--muted": "oklch(0.965 0.006 280)", "--muted-foreground": "oklch(0.524 0.022 281)",
  "--primary": "oklch(0.53 0.105 185)", "--primary-foreground": "oklch(0.985 0.01 180)",
  "--destructive": "oklch(0.583 0.231 27.5)", "--ring": "oklch(0.53 0.105 185)",
  "--success": "oklch(0.62 0.16 150)", "--warning": "oklch(0.72 0.16 73)", "--info": "oklch(0.6 0.14 240)",
  "--success-text": "oklch(0.5 0.14 150)", "--warning-text": "oklch(0.52 0.13 73)", "--info-text": "oklch(0.5 0.13 240)",
  "--chart-1": "oklch(0.53 0.105 185)", ...CHART_ACCENTS,
};

/* Render timing, so "the table is slow" is a number rather than an impression.
 * `measureRender()` remounts the frame, stamps the moment the fleet listing is
 * answered, and then watches the frame every animation frame:
 *   paintedMs  the first frame in which a fleet row has a layout box, which is
 *              the earliest the operator can see any of the table
 *   settledMs  the first frame after which three consecutive frames each came
 *              in under 32ms, which is when the page is usable again
 * Both are measured from the answer, not from navigation, so module load and
 * the harness's own latency are excluded. */
interface Measure {
  dataAt: number;
  /** DOM built and laid out: the rows have a box. Timer driven, so this lands
   *  even while the renderer is too busy to deliver an animation frame. */
  layoutMs: number;
  /** A frame was actually presented after that layout existed. This is the
   *  number the operator feels: nothing is on screen until it lands. */
  paintedMs: number;
  /** Three consecutive animation frames under 32ms, so the page is usable
   *  again. -1 when that never happened inside the deadline. */
  settledMs: number;
  rows: number;
  worstGapMs: number;
  resolve: (value: Measure) => void;
}
const SETTLE_DEADLINE_MS = 30_000;
const POLL_MS = 25;
let measuring: Measure | undefined;
let poll: ReturnType<typeof setInterval> | undefined;

function fleetRows(): NodeListOf<HTMLElement> | undefined {
  const body = frame.contentDocument?.querySelector(".fleet-panel table tbody");
  return body?.querySelectorAll("tr") as NodeListOf<HTMLElement> | undefined;
}

function finish(): void {
  const done = measuring;
  measuring = undefined;
  if (poll !== undefined) clearInterval(poll);
  poll = undefined;
  done?.resolve(done);
}

function watchRender(): void {
  // Timers keep running when the compositor cannot keep up, so the deadline and
  // the layout stamp are driven from one; only the frame signals need rAF.
  poll = setInterval(() => {
    if (!measuring) return;
    const rows = fleetRows();
    if (!measuring.layoutMs && rows?.length && rows[0].offsetHeight > 0) {
      measuring.layoutMs = Math.round(performance.now() - measuring.dataAt);
      measuring.rows = rows.length;
    }
    if (performance.now() - measuring.dataAt > SETTLE_DEADLINE_MS) {
      if (!measuring.settledMs) measuring.settledMs = -1;
      finish();
    }
  }, POLL_MS);

  let last = 0;
  let quick = 0;
  const step = (ts: number): void => {
    if (!measuring) return;
    const gap = last ? ts - last : 0;
    last = ts;
    if (gap > measuring.worstGapMs) measuring.worstGapMs = Math.round(gap);
    if (measuring.layoutMs) {
      if (!measuring.paintedMs) measuring.paintedMs = Math.round(performance.now() - measuring.dataAt);
      quick = gap > 0 && gap < 32 ? quick + 1 : 0;
      if (quick >= 3) {
        measuring.settledMs = Math.round(performance.now() - measuring.dataAt);
        return finish();
      }
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function armMeasure(resolve: (value: Measure) => void): void {
  if (poll !== undefined) clearInterval(poll);
  measuring = { dataAt: 0, layoutMs: 0, paintedMs: 0, settledMs: 0, rows: 0, worstGapMs: 0, resolve };
}

/* Remount and measure. Useful for a quick A/B, but note that back to back
 * remounts of a heavy document measure the remounts as much as the page. */
(window as unknown as { measureRender: () => Promise<Measure> }).measureRender = () =>
  new Promise<Measure>((resolve) => {
    armMeasure(resolve);
    reload();
  });

const params = new URLSearchParams(location.search);
/* The harness's own keys. Everything else in the address is page state. */
const HARNESS_KEYS = new Set(["route", "scenario", "theme", "width", "frame", "fail", "zoom", "measure", "plugin", "oldhost", "stepup", "deny", "slow"]);
let frameEpoch = 0;
let route = (params.get("route") ?? "lines") as Route;
let scenario = (params.get("scenario") ?? "production") as Scenario;
/* `zoom` magnifies the whole harness for screenshot review on a very wide
 * display, where a 1440px frame is a postage stamp. Harness only. */
const zoom = params.get("zoom");
if (zoom) document.documentElement.style.zoom = zoom;
/* `oldhost=1` answers like a console from before page state: init carries no
 * `pageState` and state messages are ignored, so the fallback can be seen. */
const oldHost = params.get("oldhost") === "1";
/* Page state, filtered by the contract's rules as the console filters its
 * query. `plugin=<encoded query>` is the older spelling from when the harness
 * forwarded it to the frame's own query, read only when no key names state. */
const addressState = [...params].filter(([key]) => !HARNESS_KEYS.has(key));
let pageState: PageState = filterPageState(addressState.length ? addressState : new URLSearchParams(params.get("plugin") ?? ""));
/* The console's budget: 60 states in any 60 seconds per frame, and nothing
 * before the plugin has said it is ready. Both reset with the frame. */
const STATES_PER_MINUTE = 60;
let stateTimes: number[] = [];
let readySeen = false;
/* `fail=usage/query` fails that one call in any scenario, so a partial
 * failure (lines read, usage refused) can be looked at, not only a total one.
 * `fail=usage/query@30d` fails it only for that period, so a period switch
 * whose read fails can be looked at after a good first read. */
const failCalls = new Set(params.getAll("fail"));
/* The console runs a step-up prompt before it answers a reveal (lattice-dashboard
 * PluginFrameHost.vue). `stepup=ok` (the default) answers as if the operator
 * passed it after a short wait; `stepup=cancel` refuses as when they cancel;
 * `stepup=old` answers like a console without the step-up path, which passes
 * the server's step_up_required straight through. */
const stepUp = params.get("stepup") ?? "ok";
/* `deny=link` refuses every link method the way the server refuses a session
 * without vpncore:admin or with a node allowlist: 403 capability_denied. */
const denyLinks = params.get("deny") === "link";
/* `slow=users-admin/link_get` holds that call for two minutes, so its loading
 * state can be looked at. */
const slowCalls = new Set(params.getAll("slow"));
let dark = params.get("theme") !== "light";
let width = params.get("width") ?? "1440";
/** The height of the console's main region. The frame gets exactly this. */
let windowHeight = Number(params.get("frame") ?? 760);

const shell = document.createElement("div");
shell.className = "harness";
shell.innerHTML = `
  <div class="bar">
    <strong>vpn-core dev harness</strong>
    <label>route <select id="route">${ROUTES.map((value) => `<option${value === route ? " selected" : ""}>${value}</option>`).join("")}</select></label>
    <label>data <select id="scenario">${SCENARIOS.map((value) => `<option${value === scenario ? " selected" : ""}>${value}</option>`).join("")}</select></label>
    <label>width <select id="width">${["1440", "2423", "375"].map((value) => `<option${value === width ? " selected" : ""}>${value}</option>`).join("")}</select></label>
    <button id="theme" type="button">${dark ? "light" : "dark"}</button>
    <span id="reported"></span>
    <span id="state"></span>
  </div>
  <div class="viewport" id="viewport">
    <div class="frame-wrap" id="wrap"><iframe id="frame" title="plugin"></iframe></div>
  </div>`;
document.body.append(shell);

const frame = document.getElementById("frame") as HTMLIFrameElement;
const wrap = document.getElementById("wrap") as HTMLDivElement;
const viewport = document.getElementById("viewport") as HTMLDivElement;
const reported = document.getElementById("reported") as HTMLSpanElement;
const stateNote = document.getElementById("state") as HTMLSpanElement;

function tokens(): Record<string, string> {
  return dark ? DARK : LIGHT;
}

function applyChrome(): void {
  wrap.style.width = `${width}px`;
  viewport.style.height = `${windowHeight}px`;
  reported.textContent = `frame ${width} x ${windowHeight}`;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  (document.getElementById("theme") as HTMLButtonElement).textContent = dark ? "light" : "dark";
}

/** The harness's keys, then the page state, as the console would hold it. */
function writeAddress(): void {
  const query = new URLSearchParams({ route, scenario, theme: dark ? "dark" : "light", width, frame: String(windowHeight) });
  for (const key of failCalls) query.append("fail", key);
  for (const key of slowCalls) query.append("slow", key);
  if (stepUp !== "ok") query.set("stepup", stepUp);
  if (denyLinks) query.set("deny", "link");
  if (zoom) query.set("zoom", zoom);
  if (oldHost) query.set("oldhost", "1");
  for (const [key, value] of Object.entries(pageState)) query.set(key, value);
  history.replaceState(null, "", `?${query}`);
}

function reload(): void {
  writeAddress();
  applyChrome();
  stateTimes = [];
  readySeen = false;
  stateNote.textContent = oldHost ? "old host: page state not kept" : "";
  // The epoch matters: assigning an identical src, fragment and all, is a
  // same-document navigation, so the frame would keep running and the route or
  // data the operator just picked would never reach a fresh plugin.
  frameEpoch += 1;
  // No page state in the frame URL: the console's frame URL has no query.
  frame.src = `/index.html?frame=${frameEpoch}#lattice_nonce=${NONCE}&host_origin=${encodeURIComponent(location.origin)}`;
}

function post(message: Record<string, unknown>): void {
  frame.contentWindow?.postMessage({ nonce: NONCE, ...message }, location.origin);
}

window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
  const data = event.data as Record<string, any>;
  if (!data || data.nonce !== NONCE) return;
  switch (data.type) {
    case "lattice.plugin.ready":
      post({
        type: "lattice.host.init", version: "1", pluginId: PLUGIN_ID,
        pluginVersion: "0.0.0-dev", pluginRoute: route, locale: "en",
        colorScheme: dark ? "dark" : "light", designTokens: tokens(), interfaces: INTERFACES,
        ...(oldHost ? {} : { pageState: { ...pageState } }),
      });
      readySeen = true;
      return;
    case "lattice.plugin.state": {
      if (oldHost || !readySeen) return;
      const now = Date.now();
      stateTimes = stateTimes.filter((time) => now - time < 60_000);
      if (stateTimes.length >= STATES_PER_MINUTE) {
        stateNote.textContent = "state ignored: over 60 a minute";
        return;
      }
      stateTimes.push(now);
      const state = validPageState(data.state);
      if (!state) {
        stateNote.textContent = "state dropped: breaks the contract's rules";
        return;
      }
      // Harness only: a state key that is also a harness key cannot live in
      // this address. The console has no such keys; say so rather than guess.
      const clash = Object.keys(state).filter((key) => HARNESS_KEYS.has(key));
      if (clash.length) {
        stateNote.textContent = `state dropped: ${clash.join(", ")} is a harness key`;
        return;
      }
      pageState = state;
      writeAddress();
      const query = new URLSearchParams(state).toString();
      stateNote.textContent = `state ${query || "(default)"}`;
      return;
    }
    case "lattice.plugin.resize": {
      // Accepted and ignored, like the real host. The frame height never
      // depends on anything the plugin says. Reported only so a plugin still
      // trying to drive its own frame is visible.
      const height = Math.max(120, Number(data.height) || 0);
      reported.textContent = `plugin reported ${height}px (ignored; frame is ${windowHeight}px)`;
      return;
    }
    case "lattice.plugin.clipboard": {
      // The console copies on the frame's behalf and always answers.
      const text = typeof data.text === "string" ? data.text : "";
      void (navigator.clipboard?.writeText(text) ?? Promise.reject(new Error("no clipboard")))
        .then(() => true, () => false)
        .then((ok) => post({ type: "lattice.host.clipboard", id: data.id, ok, ...(ok ? {} : { code: "clipboard_refused" }) }));
      return;
    }
    case "lattice.plugin.call": {
      const table = handlers(scenario);
      const key = `${String(data.service).split("/").pop()}/${data.method}`;
      const handler = table[key];
      const isLink = String(data.method).startsWith("link_");
      if (denyLinks && isLink) {
        window.setTimeout(() => post({ type: "lattice.host.error", id: data.id, code: "call_failed", apiCode: "capability_denied", httpStatus: 403,
          message: "vpn-core/users-admin link methods require vpncore:admin with an unrestricted node allowlist" }), 320);
        return;
      }
      if (data.method === "link_reveal" && stepUp !== "ok") {
        window.setTimeout(() => post(stepUp === "cancel"
          ? { type: "lattice.host.error", id: data.id, code: "step_up_required", apiCode: "step_up_required", httpStatus: 403, message: "Step-up was cancelled in the console, so nothing was revealed." }
          : { type: "lattice.host.error", id: data.id, code: "call_failed", message: "step_up_required: revealing a secret needs a fresh second-factor step-up" }), stepUp === "cancel" ? 1_400 : 320);
        return;
      }
      // Latency, so loading and skeleton states are visible rather than theoretical.
      // A reveal waits as long as the console's step-up prompt takes a person.
      const latency = slowCalls.has(key) ? 120_000 : data.method === "link_reveal" ? 1_100 : 320;
      window.setTimeout(() => {
        const period = (data.payload as { period?: unknown } | undefined)?.period;
        if (scenario === "failing" || failCalls.has(key) || (typeof period === "string" && failCalls.has(`${key}@${period}`))) {
          post({ type: "lattice.host.error", id: data.id, message: `upstream refused ${key}: 503 service unavailable` });
          return;
        }
        if (!handler) {
          post({ type: "lattice.host.error", id: data.id, message: `the dev harness has no answer for ${key}` });
          return;
        }
        try {
          post({ type: "lattice.host.result", id: data.id, result: handler((data.payload ?? {}) as any) });
          if (measuring && !measuring.dataAt && key === "lines/list") {
            measuring.dataAt = performance.now();
            watchRender();
          }
        } catch (cause) {
          post({
            type: "lattice.host.error", id: data.id, code: "call_failed",
            message: cause instanceof Error ? cause.message : String(cause),
            ...(cause instanceof LinkFixtureError ? { apiCode: cause.apiCode, httpStatus: cause.httpStatus } : {}),
          });
        }
      }, latency);
    }
  }
});

document.getElementById("route")!.addEventListener("change", (event) => {
  route = (event.target as HTMLSelectElement).value as Route;
  // Another plugin route is another console page with its own query.
  pageState = {};
  reload();
});
document.getElementById("scenario")!.addEventListener("change", (event) => {
  scenario = (event.target as HTMLSelectElement).value as Scenario;
  reload();
});
document.getElementById("width")!.addEventListener("change", (event) => {
  width = (event.target as HTMLSelectElement).value;
  reload();
});
document.getElementById("theme")!.addEventListener("click", () => {
  dark = !dark;
  applyChrome();
  post({ type: "lattice.host.theme", colorScheme: dark ? "dark" : "light", designTokens: tokens() });
});

/* `?measure=1` arms the very first mount, so a single fresh tab load yields one
 * number for what the operator actually waits through: no remount, no warm
 * document, nothing else competing for the compositor. Read window.__measure. */
if (params.get("measure") === "1") {
  armMeasure((value) => {
    (window as unknown as { __measure?: Measure }).__measure = value;
  });
}

reload();
