/**
 * A stand-in for the dashboard host, for looking at the plugin in a browser.
 *
 * This is deliberately not a mock of the UI: it runs the real plugin build in a
 * real iframe and speaks the real bridge protocol at it, including the one
 * thing that breaks overlays in production. The host sizes the frame to the
 * height the plugin reports, so the frame is taller than the window and the
 * frame is NOT a viewport. Reproducing that here is the whole point: an overlay
 * that looks centred in a standalone page lands below the fold in the console.
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

const params = new URLSearchParams(location.search);
let route = (params.get("route") ?? "lines") as Route;
let scenario = (params.get("scenario") ?? "production") as Scenario;
let dark = params.get("theme") !== "light";
let width = params.get("width") ?? "1440";
/** Deliberately short, so the frame is taller than the window like production. */
let windowHeight = Number(params.get("frame") ?? 760);

const shell = document.createElement("div");
shell.className = "harness";
shell.innerHTML = `
  <div class="bar">
    <strong>vpn-core dev harness</strong>
    <label>route <select id="route">${ROUTES.map((value) => `<option${value === route ? " selected" : ""}>${value}</option>`).join("")}</select></label>
    <label>data <select id="scenario">${["production", "rich", "empty", "failing"].map((value) => `<option${value === scenario ? " selected" : ""}>${value}</option>`).join("")}</select></label>
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
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  (document.getElementById("theme") as HTMLButtonElement).textContent = dark ? "light" : "dark";
}

function reload(): void {
  const query = new URLSearchParams({ route, scenario, theme: dark ? "dark" : "light", width, frame: String(windowHeight) });
  history.replaceState(null, "", `?${query}`);
  applyChrome();
  frame.src = `/index.html#lattice_nonce=${NONCE}&host_origin=${encodeURIComponent(location.origin)}`;
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
      const height = Math.max(120, Number(data.height) || 0);
      // The host trusts the plugin's own height. That is exactly why `vh` and
      // `position: fixed` are wrong inside the frame.
      frame.style.height = `${height}px`;
      reported.textContent = `frame ${height}px in a ${windowHeight}px window`;
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
