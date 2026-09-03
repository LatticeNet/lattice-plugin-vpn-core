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

import { handlers, type ContentShape, type Scenario } from "./fixtures";

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
    methods: ["create", "update", "delete", "bind", "unbind", "rotate", "plan_add", "plan_update", "plan_remove", "usage_query"],
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
let frameEpoch = 0;
let route = (params.get("route") ?? "lines") as Route;
let scenario = (params.get("scenario") ?? "production") as Scenario;
let content = (params.get("content") ?? "plain") as ContentShape;
/* `zoom` magnifies the whole harness for screenshot review on a very wide
 * display, where a 1440px frame is a postage stamp. Harness only. */
const zoom = params.get("zoom");
if (zoom) document.documentElement.style.zoom = zoom;
/* `plugin` is forwarded to the plugin document's own query string, so a
 * reviewer can open a lens or a node by URL (`plugin=lens%3Dtopology`). */
const pluginQuery = params.get("plugin") ?? "";
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
    <label>data <select id="scenario">${["production", "hubs", "offfleet", "rich", "dense", "empty", "failing"].map((value) => `<option${value === scenario ? " selected" : ""}>${value}</option>`).join("")}</select></label>
    <label>content <select id="content">${["plain", "hostile"].map((value) => `<option${value === content ? " selected" : ""}>${value}</option>`).join("")}</select></label>
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
  const query = new URLSearchParams({ route, scenario, content, theme: dark ? "dark" : "light", width, frame: String(windowHeight) });
  history.replaceState(null, "", `?${query}`);
  applyChrome();
  // The epoch matters: assigning an identical src, fragment and all, is a
  // same-document navigation, so the frame would keep running and the route or
  // data the operator just picked would never reach a fresh plugin.
  frameEpoch += 1;
  frame.src = `/index.html?frame=${frameEpoch}${pluginQuery ? `&${pluginQuery}` : ""}#lattice_nonce=${NONCE}&host_origin=${encodeURIComponent(location.origin)}`;
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
      const table = handlers(scenario, content);
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
 * `?probe=1` — assert the property, not a threshold.
 *
 * The fixture next door had a near miss worth encoding here. It detected a
 * collector overflow because a hostname was long enough, and when that string
 * was made more realistic it became 17px shorter than the container, fit, and
 * the fixture went quiet while still reporting green. The repair was to
 * lengthen the string, which is a threshold, and a threshold drifts: a font
 * size, a padding, a grid track or a panel width, all of which live in other
 * files, move the same margin without anyone touching the string or reading
 * the comment that says its length matters.
 *
 * So this asserts what cannot drift. Not "does the panel overflow by N", which
 * is a number, but "is anything on screen unreachable", which is a binary. If
 * every value fits, nothing is clipped and this is silent rather than falsely
 * green. If a rule regresses, it trips at whatever margin that month happens
 * to produce.
 *
 * Three properties, each a real failure rather than a proxy for one:
 *
 *   1. A panel that overflows has lost content outright. `.data-panel` is
 *      `overflow: clip`, and nothing scrolls a clip box: not the wheel, not
 *      the keyboard, not focus, not script. Past its edge the content is gone.
 *   2. A scroller that overflows is fine, provided every pixel is reachable.
 *      What is checked is that `scrollLeft` actually travels the distance, not
 *      that the distance is small. Off-screen and gone look identical in a
 *      screenshot and are not the same thing.
 *   3. A clipped cell is acceptable only if the full value is recoverable,
 *      which here means a `title` on it or an ancestor. Clipped with no title
 *      is information destroyed with no recourse, which is the shape of every
 *      truncation defect this harness has found.
 *
 * Manual, and deliberately so. Layout needs a real engine, jsdom will not
 * compute any of this, and a browser lane is a real cost to carry for one
 * property. This makes the check one keystroke instead of a judgement call;
 * it does not make CI defend it. That remains a decision to take on purpose
 * rather than drift into.
 * ------------------------------------------------------------------------- */

type Finding = { property: string; detail: string };

const capped = "td strong, td small, td.mono, .badge, .count, .collector-grid strong, .collector-grid p";

function panelName(el: Element): string {
  const panel = el.closest(".data-panel");
  return panel?.querySelector("h2")?.textContent?.trim() ?? "(unnamed panel)";
}

function probeLayout(): Finding[] {
  const doc = frame.contentDocument;
  if (!doc) return [{ property: "no-subject", detail: "the frame has no document to probe" }];
  const panels = Array.from(doc.querySelectorAll<HTMLElement>(".data-panel"));
  const cells = doc.querySelectorAll(capped).length;
  /* An empty document yields no findings, and no findings printed as "clear"
   * is how this probe reported a screen that was overflowing by 50px at the
   * time. Nothing to probe is not the same as nothing wrong, and conflating
   * them is the whole failure mode.
   *
   * The guard covers zero cells as well as zero panels, because the first
   * version did not and the same failure walked straight through the gap: on
   * the harness's own landing screen, `route=usage&scenario=production`, it
   * reported `clear (4p 0c)`. Four panels, no cells, because that scenario
   * returns no usage rows. Two of the three properties below are about cells,
   * so a run that examined none has checked almost nothing, and it was saying
   * so in a word that reads as a pass. Any component of the subject count
   * being zero is a finding, not a pass. */
  if (panels.length === 0 || cells === 0) {
    return [{
      property: "no-subject",
      detail: `${panels.length} panels and ${cells} capped cells rendered, so ${panels.length === 0 ? "nothing" : "almost nothing"} was checked; this is not a pass. If the route is right, the scenario probably has no rows.`,
    }];
  }
  const findings: Finding[] = [];

  for (const panel of panels) {
    const over = panel.scrollWidth - panel.clientWidth;
    if (over > 0) {
      findings.push({
        property: "panel-clipped",
        detail: `${panelName(panel)} overflows its own panel by ${over}px; .data-panel is clip, so that content cannot be scrolled to by any means`,
      });
    }
  }

  for (const wrap of Array.from(doc.querySelectorAll<HTMLElement>(".table-wrap"))) {
    const need = wrap.scrollWidth - wrap.clientWidth;
    if (need <= 0) continue;
    const before = wrap.scrollLeft;
    wrap.scrollLeft = need;
    const got = Math.round(wrap.scrollLeft);
    wrap.scrollLeft = before;
    if (got < need) {
      findings.push({
        property: "scroller-unreachable",
        detail: `${panelName(wrap)} overflows by ${need}px but scrollLeft stops at ${got}px, so ${need - got}px is unreachable`,
      });
    }
  }

  for (const cell of Array.from(doc.querySelectorAll<HTMLElement>(capped))) {
    if (cell.scrollWidth <= cell.clientWidth && cell.scrollHeight <= cell.clientHeight) continue;
    if (cell.closest("[title]")) continue;
    findings.push({
      property: "clipped-without-recourse",
      detail: `${panelName(cell)}: ${cell.tagName.toLowerCase()}.${cell.className || "(no class)"} is clipped and carries no title, so the full value cannot be recovered: ${JSON.stringify((cell.textContent ?? "").trim().slice(0, 48))}`,
    });
  }

  return findings;
}

/* Wait for the document to settle rather than guessing a delay, and rather
 * than waiting on the panels alone. The panels mount before their data
 * arrives, so `.data-panel` exists while the rows are still empty: probing
 * then examined a real but unpopulated screen, found nothing, and printed
 * clear over a panel that was overflowing by 50px. Waiting on the wrong
 * signal reads exactly like waiting on the right one.
 *
 * Settling on the count of things this probe actually examines is the signal,
 * not text length and not the panels alone. Text length settled at a plateau
 * mid-render and the panels exist before their rows do; both produced a probe
 * that examined one panel and no cells and called it clear. The subject count
 * only stops growing once what is being checked is on screen, and it is the
 * same number the pass line reports, so the signal and the evidence are the
 * same quantity. */
function subjects(): number {
  const doc = frame.contentDocument;
  if (!doc) return 0;
  return doc.querySelectorAll(".data-panel").length * 1000 + doc.querySelectorAll(capped).length;
}

function runProbe(attempt = 0, last = -1, stable = 0): void {
  const now = subjects();
  const settledFor = now === last ? stable + 1 : 0;
  /* Half a second of no growth, not one sample: a single match is satisfied by
   * any plateau between two renders. */
  if ((now === 0 || settledFor < 5) && attempt < 60) {
    window.setTimeout(() => runProbe(attempt + 1, now, settledFor), 100);
    return;
  }
  const findings = probeLayout();
  (window as unknown as { __probe?: Finding[] }).__probe = findings;
  const where = document.getElementById("reported");
  if (findings.length === 0) {
    /* A bare "clear" is what let an empty document pass for a sound one, so
     * it carries what it examined. A pass with a subject count of zero is a
     * pass over nothing, and now says so on its face. */
    const doc = frame.contentDocument;
    const panels = doc?.querySelectorAll(".data-panel").length ?? 0;
    const cells = doc?.querySelectorAll(capped).length ?? 0;
    console.log(`[probe] clear: ${panels} panels and ${cells} capped cells examined, nothing clipped without recourse and nothing unreachable`);
    if (where) where.textContent = `probe: clear (${panels}p ${cells}c)`;
    return;
  }
  for (const finding of findings) console.error(`[probe] ${finding.property}: ${finding.detail}`);
  if (where) where.textContent = `probe: ${findings.length} finding${findings.length === 1 ? "" : "s"}`;
}

/* `?measure=1` arms the very first mount, so a single fresh tab load yields one
 * number for what the operator actually waits through: no remount, no warm
 * document, nothing else competing for the compositor. Read window.__measure. */
if (params.get("measure") === "1") {
  armMeasure((value) => {
    (window as unknown as { __measure?: Measure }).__measure = value;
  });
}

reload();

/* `?probe=1` runs the layout assertions once the frame has settled. The delay
 * is the plugin's own first paint plus its data fetch, not a race fix: probing
 * before that measures an empty document and reports it clear, which would be
 * another check that looked like it ran.
 *
 * This hook belongs at the end of the file, after the final `reload()`. It was
 * first written against the wrong `reload();`, the one inside `measureRender`,
 * where it typechecked, built, and never executed. `?probe=1` reported nothing
 * and an empty result reads the same as a clean one. That is the exact failure
 * this probe exists to make impossible, produced while writing it. */
if (params.get("probe") === "1") {
  frame.addEventListener("load", () => window.setTimeout(() => runProbe(), 150));
}
