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
import { CONTENT_SHAPES, handlers, SCENARIOS, withContent, type ContentShape, type Scenario } from "./fixtures";
import { LinkFixtureError } from "./linkFixtures";
import { probeHandlers, PROBE_SCENARIOS, type ProbeScenario } from "./probeFixtures";

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
  { service: "latticenet.vpn-core/probe", methods: ["health", "targets", "run"] },
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
const HARNESS_KEYS = new Set(["route", "scenario", "content", "theme", "width", "frame", "fail", "zoom", "measure", "layout", "plugin", "oldhost", "stepup", "deny", "slow", "probe"]);
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
/* `deny=probe` leaves the probe service out of init, as the console does for a
 * session without vpn:probe. `probe=<scenario>` picks what the probe answers
 * (probeFixtures.ts); the default works. */
const denyProbe = params.get("deny") === "probe";
const probeScenario = (PROBE_SCENARIOS as readonly string[]).includes(params.get("probe") ?? "") ? (params.get("probe") as ProbeScenario) : "ok";
const interfaces = denyProbe ? INTERFACES.filter((contract) => !contract.service.endsWith("/probe")) : INTERFACES;
/* `content=hostile` keeps the scenario's topology and makes its strings
 * adversarial (fixtures.ts, "Content shape"). It composes with every scenario
 * and every probe scenario. */
let content: ContentShape = (CONTENT_SHAPES as readonly string[]).includes(params.get("content") ?? "") ? (params.get("content") as ContentShape) : "plain";
/* `layout=1` runs the layout check (below) after every frame load. */
const layoutOnLoad = params.get("layout") === "1";
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
    <label>content <select id="content">${CONTENT_SHAPES.map((value) => `<option${value === content ? " selected" : ""}>${value}</option>`).join("")}</select></label>
    <label>width <select id="width">${["1440", "2423", "375"].map((value) => `<option${value === width ? " selected" : ""}>${value}</option>`).join("")}</select></label>
    <button id="theme" type="button">${dark ? "light" : "dark"}</button>
    <span id="reported"></span>
    <span id="state"></span>
    <span id="layout"></span>
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
const layoutNote = document.getElementById("layout") as HTMLSpanElement;

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
  if (content !== "plain") query.set("content", content);
  if (layoutOnLoad) query.set("layout", "1");
  for (const key of failCalls) query.append("fail", key);
  for (const key of slowCalls) query.append("slow", key);
  if (stepUp !== "ok") query.set("stepup", stepUp);
  if (denyLinks) query.set("deny", "link");
  if (denyProbe) query.set("deny", "probe");
  if (probeScenario !== "ok") query.set("probe", probeScenario);
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
  layoutNote.textContent = "";
  (window as unknown as { __layout?: LayoutReport }).__layout = undefined;
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
        colorScheme: dark ? "dark" : "light", designTokens: tokens(), interfaces,
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
      const table = withContent({ ...handlers(scenario), ...probeHandlers(probeScenario) }, content);
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
      const latency = slowCalls.has(key) ? 120_000 : data.method === "link_reveal" ? 1_100 : key === "probe/run" ? 1_400 : 320;
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
document.getElementById("content")!.addEventListener("change", (event) => {
  content = (event.target as HTMLSelectElement).value as ContentShape;
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

/* ---------------------------------------------------------------------------
 * `?layout=1`: assert the property, not a threshold.
 *
 * PR #20 called this `?probe=1`. `probe=` has since come to pick what the Probe
 * layer's fixture answers, so the check took its own key rather than share one
 * with a different meaning.
 *
 * The content fixture had a near miss worth encoding here. It detected a
 * collector overflow because a hostname was long enough, and when that string
 * was made more realistic it became 17px shorter than the container, fit, and
 * the fixture went quiet while still reporting green. The repair was to
 * lengthen the string, which is a threshold, and a threshold drifts: a font
 * size, a padding, a grid track or a panel width, all of which live in other
 * files, move the same margin without anyone touching the string.
 *
 * So this asserts what cannot drift. Not "does the panel overflow by N", which
 * is a number, but "is anything on screen unreachable", which is a binary. If
 * every value fits, nothing is clipped and this is silent rather than falsely
 * green. If a rule regresses, it trips at whatever margin it produces.
 *
 * Three properties, each a real failure rather than a proxy for one:
 *
 *   1. A panel that overflows has lost content outright. `.data-panel` hides
 *      its overflow: there is no scrollbar, and neither the wheel nor a swipe
 *      moves it. Past its edge the content is gone.
 *   2. A scroller that overflows is fine, provided every pixel is reachable.
 *      Off-screen and gone look identical in a screenshot and are not the
 *      same thing. #20 checked that `scrollLeft` travels `scrollWidth -
 *      clientWidth`, which a real engine always allows, so that test could
 *      only fail on rounding. What does lose a scroller's content is its own
 *      box running past an ancestor that clips: the scroll range is all there,
 *      and its end can never be brought into view.
 *   3. A clipped element is acceptable only if the full value is recoverable,
 *      which here means a `title` on it, on an ancestor, or on a child the
 *      pointer can reach. Clipped with no title is information destroyed with
 *      no recourse, which is the shape of every truncation defect this
 *      harness has found.
 *
 * Which elements clip and which scroll is read from computed style, not from a
 * list of class names. The first version listed selectors (`td strong`,
 * `.badge`, `.collector-grid p`), and the screens it was written against have
 * since been rebuilt around other classes: a selector list goes stale the same
 * silent way a threshold drifts. The subject guard below does keep a list, and
 * that is safe in the other direction, because a stale guard reports that it
 * examined nothing, which is loud.
 *
 * Manual, and deliberately so. Layout needs a real engine, jsdom will not
 * compute any of it, and a browser lane is a real cost to carry for one
 * property. `checkLayout()` in the console runs it on whatever is open (a
 * sheet, a probe result); `layout=1` runs it after every frame load. It does
 * not make CI defend the property; that remains a decision to take on purpose.
 * ------------------------------------------------------------------------- */

interface Finding {
  property: "no-subject" | "panel-clipped" | "scroller-unreachable" | "clipped-without-recourse";
  detail: string;
}
interface LayoutReport {
  findings: Finding[];
  /** Panels, content cells and clipping elements examined, reported apart. */
  panels: number;
  cells: number;
  clipping: number;
}

const PANELS = ".data-panel";

/* The subject two of the properties are about: cells holding row data, the
 * collector grid, attention items and the exit bars. The guard counts these
 * and nothing that merely correlates with them. The first version counted
 * every capped element, and once two panel headers grew row-count chips an
 * empty usage screen reported "clear (4p 2c)": two chips reading "0
 * identities" and "0 nodes", no table cells at all, and a count that looked
 * healthy enough to take the pass branch. A proxy count fails as silently as
 * a proxy threshold.
 *
 * A cell that spans columns is not a subject either. Every "nothing here" row
 * in this plugin is one (the empty topology table says so in a
 * `<td colspan="7">`), and counting it reported an empty fleet as
 * "clear (1p 1c)". Spanning cells that do carry data (a probe target's error,
 * a row's evidence) belong to a row whose own cells are counted. */
const CONTENT_CELLS = "tbody td:not([colspan]), .collector-grid > div, .attention-item, .exit-bars > li";

const rendered = (el: Element) => el.getClientRects().length > 0;

function panelName(el: Element): string {
  const panel = el.closest(PANELS);
  if (!panel) return "(outside any panel)";
  const label = panel.getAttribute("aria-label") ?? panel.querySelector("h2, h3")?.textContent ?? "";
  return label.trim() || `(unnamed .${[...panel.classList].join(".")})`;
}

function nameOf(el: Element): string {
  return [el.tagName.toLowerCase(), ...el.classList].join(".");
}

function measureLayout(): LayoutReport {
  const doc = frame.contentDocument;
  const view = doc?.defaultView;
  if (!doc?.body || !view) return { findings: [{ property: "no-subject", detail: "the frame has no document to check" }], panels: 0, cells: 0, clipping: 0 };
  const panels = Array.from(doc.querySelectorAll<HTMLElement>(PANELS)).filter(rendered);
  const cells = Array.from(doc.querySelectorAll(CONTENT_CELLS)).filter(rendered).length;
  /* Nothing to check is not the same as nothing wrong, and printing the one as
   * "clear" is how this check once reported a screen that was overflowing by
   * 50px. Zero panels or zero cells is a finding, not a pass. */
  if (panels.length === 0 || cells === 0) {
    return {
      findings: [{
        property: "no-subject",
        detail: `${panels.length} panels and ${cells} content cells rendered, so ${panels.length === 0 ? "nothing" : "almost nothing"} was checked; this is not a pass. If the route is right, the scenario probably has no rows here.`,
      }],
      panels: panels.length, cells, clipping: 0,
    };
  }
  const findings: Finding[] = [];

  for (const panel of panels) {
    const over = panel.scrollWidth - panel.clientWidth;
    // One pixel is sub-pixel rounding of the border box, not lost content.
    if (over > 1) {
      findings.push({
        property: "panel-clipped",
        detail: `${panelName(panel)} overflows its own panel by ${over}px; .data-panel hides overflow, so that content cannot be scrolled to`,
      });
    }
  }

  let clipping = 0;
  for (const el of Array.from(doc.body.querySelectorAll<HTMLElement>("*"))) {
    if (el.matches(PANELS) || !rendered(el)) continue;
    const style = view.getComputedStyle(el);
    if (style.overflowX === "auto" || style.overflowX === "scroll") {
      const need = el.scrollWidth - el.clientWidth;
      if (need <= 0) continue;
      /* The nearest ancestor that does not let overflow show decides: one
       * that scrolls can bring the cut part into view, one that clips cannot. */
      for (let up = el.parentElement; up && up !== doc.body; up = up.parentElement) {
        const outer = view.getComputedStyle(up).overflowX;
        if (outer === "visible") continue;
        if (outer === "hidden" || outer === "clip") {
          const box = el.getBoundingClientRect();
          const edge = up.getBoundingClientRect();
          const cut = Math.round(Math.max(box.right - edge.right, edge.left - box.left));
          if (cut > 1) {
            findings.push({
              property: "scroller-unreachable",
              detail: `${panelName(el)}: ${nameOf(el)} scrolls ${need}px of content, but its own box runs ${cut}px past ${nameOf(up)}, which clips it, so that end of its range never comes into view`,
            });
          }
        }
        break;
      }
      continue;
    }
    const clipsX = style.overflowX === "hidden" || style.overflowX === "clip";
    const clipsY = style.overflowY === "hidden" || style.overflowY === "clip";
    /* A one-pixel box is a visually hidden label (.sr-only), not a value. */
    if ((!clipsX && !clipsY) || el.clientWidth <= 1 || el.clientHeight <= 1) continue;
    clipping += 1;
    const wide = clipsX ? el.scrollWidth - el.clientWidth : 0;
    /* Vertically, less than half a line is a clipped descender, not a lost line. */
    const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2 || 16;
    const tall = clipsY ? el.scrollHeight - el.clientHeight : 0;
    if (wide <= 0 && tall < line / 2) continue;
    if (el.closest("[title]") || el.querySelector("[title]")) continue;
    findings.push({
      property: "clipped-without-recourse",
      detail: `${panelName(el)}: ${nameOf(el)} is clipped by ${wide > 0 ? `${wide}px` : `${tall}px vertically`} and carries no title, so the full value cannot be recovered: ${JSON.stringify((el.textContent ?? "").trim().slice(0, 48))}`,
    });
  }

  return { findings, panels: panels.length, cells, clipping };
}

/* Wait for the document to settle rather than guessing a delay, and rather
 * than waiting on the panels alone. The panels mount before their data
 * arrives, so `.data-panel` exists while the rows are still empty: checking
 * then examined a real but unpopulated screen and called it clear. Settling on
 * the count of what is examined is the signal, and it is the same number the
 * pass line reports, so the signal and the evidence are one quantity. Half a
 * second of no growth, not one sample: a single match is satisfied by any
 * plateau between two renders.
 *
 * No cells keeps it waiting too, up to the same six seconds. A loading screen
 * holds one skeleton panel and no rows, and when the screen's reads run one
 * after another that plateau outlasts half a second: the check settled on it
 * and reported no subject over a Collectors panel that, a moment later, was
 * overflowing by 51px. A screen that truly has no rows still ends in the
 * no-subject finding, six seconds later. */
function subjects(): { panels: number; cells: number } {
  const doc = frame.contentDocument;
  if (!doc) return { panels: 0, cells: 0 };
  return { panels: doc.querySelectorAll(PANELS).length, cells: Array.from(doc.querySelectorAll(CONTENT_CELLS)).filter(rendered).length };
}

function settle(): Promise<void> {
  return new Promise((resolve) => {
    let last = "";
    let stable = 0;
    let attempt = 0;
    const tick = () => {
      const now = subjects();
      const key = `${now.panels}:${now.cells}`;
      stable = key === last ? stable + 1 : 0;
      last = key;
      attempt += 1;
      if ((now.cells === 0 || stable < 5) && attempt < 60) window.setTimeout(tick, 100);
      else resolve();
    };
    tick();
  });
}

async function checkLayout(): Promise<LayoutReport> {
  const epoch = frameEpoch;
  await settle();
  const report = measureLayout();
  // A frame that reloaded while this settled is someone else's subject.
  if (epoch !== frameEpoch) return report;
  (window as unknown as { __layout?: LayoutReport }).__layout = report;
  if (report.findings.length === 0) {
    /* A bare "clear" is what let an empty document pass for a sound one, so
     * it carries what it examined. */
    console.log(`[layout] clear: ${report.panels} panels, ${report.cells} content cells and ${report.clipping} clipping elements examined, nothing clipped without recourse and nothing unreachable`);
    layoutNote.textContent = `layout: clear (${report.panels}p ${report.cells}c, ${report.clipping} clipping)`;
  } else {
    for (const finding of report.findings) console.error(`[layout] ${finding.property}: ${finding.detail}`);
    layoutNote.textContent = `layout: ${report.findings.length} finding${report.findings.length === 1 ? "" : "s"}`;
  }
  return report;
}
(window as unknown as { checkLayout: () => Promise<LayoutReport> }).checkLayout = checkLayout;

/* `?measure=1` arms the very first mount, so a single fresh tab load yields one
 * number for what the operator actually waits through: no remount, no warm
 * document, nothing else competing for the compositor. Read window.__measure. */
if (params.get("measure") === "1") {
  armMeasure((value) => {
    (window as unknown as { __measure?: Measure }).__measure = value;
  });
}

reload();

/* `layout=1` checks once each frame load has settled. The short delay is the
 * plugin's first paint, not a race fix; settle() is what waits for the data.
 *
 * This hook belongs at the end of the file, after the final `reload()`. It was
 * first written against the wrong `reload();`, the one inside `measureRender`,
 * where it typechecked, built, and never executed. The check reported nothing,
 * and an empty result reads the same as a clean one. */
if (layoutOnLoad) {
  frame.addEventListener("load", () => window.setTimeout(() => void checkLayout(), 150));
}
