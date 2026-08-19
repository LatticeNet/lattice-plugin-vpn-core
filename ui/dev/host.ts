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
 */

import { handlers, type Scenario } from "./fixtures";

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
    methods: ["create", "update", "delete", "bind", "unbind", "rotate", "plan_add", "plan_update", "plan_remove"],
  },
  { service: "latticenet.vpn-core/profiles", methods: ["query", "settings", "configure"] },
  { service: "latticenet.vpn-core/usage", methods: ["query"] },
];

const DARK: Record<string, string> = {
  "--background": "#0d1117", "--foreground": "#e9eef5", "--card": "#161c26",
  "--border": "#242d3a", "--muted": "#1a212c", "--muted-foreground": "#8b96a5",
  "--primary": "#4f9de0", "--primary-foreground": "#06121f",
  "--destructive": "#f2777a", "--ring": "#4f9de0",
};
const LIGHT: Record<string, string> = {
  "--background": "#f7f8f9", "--foreground": "#17191c", "--card": "#ffffff",
  "--border": "#d9dde2", "--muted": "#f1f3f5", "--muted-foreground": "#656d76",
  "--primary": "#1769aa", "--primary-foreground": "#ffffff",
  "--destructive": "#c43838", "--ring": "#1769aa",
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

(window as unknown as { measureRender: () => Promise<Measure> }).measureRender = () =>
  new Promise<Measure>((resolve) => {
    if (poll !== undefined) clearInterval(poll);
    measuring = { dataAt: 0, layoutMs: 0, paintedMs: 0, settledMs: 0, rows: 0, worstGapMs: 0, resolve };
    reload();
  });

const params = new URLSearchParams(location.search);
let frameEpoch = 0;
let route = (params.get("route") ?? "lines") as Route;
let scenario = (params.get("scenario") ?? "production") as Scenario;
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
    <label>data <select id="scenario">${["production", "offfleet", "rich", "dense", "empty", "failing"].map((value) => `<option${value === scenario ? " selected" : ""}>${value}</option>`).join("")}</select></label>
    <label>width <select id="width">${["1440", "2423", "375"].map((value) => `<option${value === width ? " selected" : ""}>${value}</option>`).join("")}</select></label>
    <button id="theme" type="button">${dark ? "light" : "dark"}</button>
    <span id="reported"></span>
  </div>
  <div class="viewport" id="viewport">
    <div class="frame-wrap" id="wrap"><iframe id="frame" title="plugin"></iframe></div>
  </div>`;
document.body.append(shell);

const frame = document.getElementById("frame") as HTMLIFrameElement;
const wrap = document.getElementById("wrap") as HTMLDivElement;
const viewport = document.getElementById("viewport") as HTMLDivElement;
const reported = document.getElementById("reported") as HTMLSpanElement;

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

function reload(): void {
  const query = new URLSearchParams({ route, scenario, theme: dark ? "dark" : "light", width, frame: String(windowHeight) });
  history.replaceState(null, "", `?${query}`);
  applyChrome();
  // The epoch matters: assigning an identical src, fragment and all, is a
  // same-document navigation, so the frame would keep running and the route or
  // data the operator just picked would never reach a fresh plugin.
  frameEpoch += 1;
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
      });
      return;
    case "lattice.plugin.resize": {
      // Accepted and ignored, like the real host. The frame height never
      // depends on anything the plugin says. Reported only so a plugin still
      // trying to drive its own frame is visible.
      const height = Math.max(120, Number(data.height) || 0);
      reported.textContent = `plugin reported ${height}px (ignored; frame is ${windowHeight}px)`;
      return;
    }
    case "lattice.plugin.call": {
      const table = handlers(scenario);
      const key = `${String(data.service).split("/").pop()}/${data.method}`;
      const handler = table[key];
      // Latency, so loading and skeleton states are visible rather than theoretical.
      window.setTimeout(() => {
        if (scenario === "failing") {
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
          post({ type: "lattice.host.error", id: data.id, message: cause instanceof Error ? cause.message : String(cause) });
        }
      }, 320);
    }
  }
});

document.getElementById("route")!.addEventListener("change", (event) => {
  route = (event.target as HTMLSelectElement).value as Route;
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

reload();
