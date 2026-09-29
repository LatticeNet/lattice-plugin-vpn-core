/**
 * pageState.ts, where a page's layer, open line, grouping, search, period,
 * chart stacking and expanded users live between reloads.
 *
 * The console's own address carries them (bridge v1, "Plugin page state in
 * the console address"). The host hands the query of its plugin route to the
 * page in `lattice.host.init` as `pageState`, and the page sends its full
 * state back in `lattice.plugin.state`, debounced, which the host writes into
 * that query with a history replace. So a console reload lands on the same
 * layer and line, and a pasted link names a state.
 *
 * A host that predates the contract sends no `pageState` and ignores the
 * message. The page then keeps the state in its own document query instead,
 * which only survives a reload of the frame itself and may be refused
 * outright in a sandboxed opaque-origin frame, so that write is best effort.
 *
 * The limits below are the contract's and are identical on both sides.
 */

import { isGroupBy, type GroupBy } from "./lineGroups";
import { STACK_BY, USAGE_PERIODS, USAGE_VIEWS, type StackBy, type UsagePeriod, type UsageView } from "./usageModel";

export type PageState = Record<string, string>;

export const PAGE_STATE_MAX_KEYS = 16;
export const PAGE_STATE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;
export const PAGE_STATE_MAX_VALUE_LENGTH = 256;

function validEntry(key: string, value: unknown): value is string {
  return PAGE_STATE_KEY_PATTERN.test(key) && typeof value === "string" && value.length <= PAGE_STATE_MAX_VALUE_LENGTH;
}

/**
 * The state if every entry keeps the rules, otherwise undefined. One bad
 * entry drops the whole state, as the host drops the whole message, so a
 * state is never applied by halves.
 */
export function validPageState(value: unknown): PageState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > PAGE_STATE_MAX_KEYS) return undefined;
  const state: PageState = {};
  for (const [key, entry] of entries) {
    if (!validEntry(key, entry)) return undefined;
    state[key] = entry;
  }
  return state;
}

/**
 * An address query read as page state. The address is the operator's and may
 * hold anything a hand or an old link put there, so entries that break the
 * rules are left out one by one rather than failing the lot: a repeated key
 * among them, since one value would be a guess. At most 16 are kept, in order.
 */
export function filterPageState(entries: Iterable<readonly [string, unknown]>): PageState {
  const list = [...entries];
  const seen = new Map<string, number>();
  for (const [key] of list) seen.set(key, (seen.get(key) ?? 0) + 1);
  const state: PageState = {};
  let kept = 0;
  for (const [key, value] of list) {
    if (kept >= PAGE_STATE_MAX_KEYS) break;
    if (seen.get(key) !== 1 || !validEntry(key, value)) continue;
    state[key] = value;
    kept += 1;
  }
  return state;
}

/** One spelling per state regardless of key order, for comparing states. */
export function pageStateKey(state: PageState): string {
  return JSON.stringify(Object.entries(state).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// ── this plugin's state ──────────────────────────────────────────────────

export type LinesView = "overview" | "lines" | "topology" | "attention";
export const LINES_VIEWS: readonly LinesView[] = ["overview", "lines", "topology", "attention"];
/* `lens` is the older spelling from the lens switch; a saved link keeps working. */
const LEGACY_LENS: Record<string, LinesView> = { fleet: "lines", topology: "topology", attention: "attention" };

/** Everything the Lines and Usage layers keep. Each route encodes its own part. */
export interface VpnPageState {
  linesView: LinesView;
  usageView: UsageView;
  group: GroupBy;
  /** The Lines search as typed. */
  q: string;
  /** The line whose panel is open, or asked for by a link and not yet found. */
  open: string;
  period: UsagePeriod;
  stack: StackBy;
  /** Users whose allocated nodes are shown on the Users page. */
  expand: string[];
}

export const DEFAULT_PAGE_STATE: Readonly<VpnPageState> = {
  linesView: "overview",
  usageView: "overview",
  group: "node",
  q: "",
  open: "",
  period: "7d",
  stack: "exit",
  expand: [],
};

function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return value !== undefined && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * The state a route's page shows, as address entries. Defaults are left out
 * so the address stays short on the default layer, and a value too long for
 * the contract (a search pasted from somewhere) is left out rather than cut,
 * because a cut search or line id would name something else. The page keeps
 * it in memory either way.
 */
export function encodePageState(route: string, state: VpnPageState): PageState {
  const out: PageState = {};
  const put = (key: string, value: string, fallback = "") => {
    if (value !== fallback && value.length <= PAGE_STATE_MAX_VALUE_LENGTH) out[key] = value;
  };
  if (route === "lines") {
    put("view", state.linesView, DEFAULT_PAGE_STATE.linesView);
    put("group", state.group, DEFAULT_PAGE_STATE.group);
    put("q", state.q.trim());
    put("open", state.open);
  } else if (route === "usage") {
    put("view", state.usageView, DEFAULT_PAGE_STATE.usageView);
    put("period", state.period, DEFAULT_PAGE_STATE.period);
    put("stack", state.stack, DEFAULT_PAGE_STATE.stack);
  } else if (route === "users") {
    // One key holds the list: the contract allows one string per key.
    put("expand", [...new Set(state.expand.filter(Boolean))].join(","));
  }
  return out;
}

/**
 * Address entries read back into state. It does not need the route: `view`
 * is read as both a Lines and a Usage layer, and whichever the route shows is
 * the one that counts. Anything unknown or out of range falls back to the
 * default, so a stale or hand-edited link still opens a page.
 */
export function decodePageState(state: PageState): VpnPageState {
  const view = state.view ?? LEGACY_LENS[state.lens ?? ""];
  return {
    linesView: pick(view, LINES_VIEWS, DEFAULT_PAGE_STATE.linesView),
    usageView: pick(state.view, USAGE_VIEWS, DEFAULT_PAGE_STATE.usageView),
    group: isGroupBy(state.group) ? state.group : DEFAULT_PAGE_STATE.group,
    q: state.q ?? "",
    open: state.open ?? "",
    period: pick(state.period, USAGE_PERIODS, DEFAULT_PAGE_STATE.period),
    stack: pick(state.stack, STACK_BY, DEFAULT_PAGE_STATE.stack),
    expand: [...new Set((state.expand ?? "").split(",").map((id) => id.trim()).filter(Boolean))],
  };
}

// ── the fallback: the frame's own document query ─────────────────────────

export function documentPageState(): PageState {
  if (typeof location === "undefined") return {};
  return filterPageState(new URLSearchParams(location.search));
}

/** Replace the document's query with `state`. The hash carries the channel
 *  nonce and host origin and is kept as it is. */
export function writeDocumentState(state: PageState): void {
  if (typeof location === "undefined" || typeof history === "undefined") return;
  const search = new URLSearchParams(state).toString();
  const next = `${location.pathname}${search ? `?${search}` : ""}${location.hash}`;
  if (next === `${location.pathname}${location.search}${location.hash}`) return;
  try {
    history.replaceState(history.state, "", next);
  } catch {
    // An opaque-origin frame may refuse; the state stays in memory.
  }
}

// ── sending ──────────────────────────────────────────────────────────────

export const STATE_DEBOUNCE_MS = 250;
/* The host takes at most 60 states in any 60 seconds and ignores the rest,
 * which would leave the address on an older state. Spacing sends a little
 * over a second apart keeps every window under that, and the last state of a
 * burst always goes out. */
export const STATE_MIN_INTERVAL_MS = 1_050;

export interface StateSender {
  /** The page's full current state. Sent once it has been quiet for the
   *  debounce and differs from what the host last had. */
  push(state: PageState): void;
  dispose(): void;
}

export function createStateSender(
  send: (state: PageState) => void,
  options: { baseline?: PageState; debounceMs?: number; minIntervalMs?: number; now?: () => number } = {},
): StateSender {
  const debounceMs = options.debounceMs ?? STATE_DEBOUNCE_MS;
  const minIntervalMs = options.minIntervalMs ?? STATE_MIN_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  let last = pageStateKey(options.baseline ?? {});
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let pending: PageState | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const flush = () => {
    timer = undefined;
    const state = pending;
    pending = undefined;
    if (!state || disposed) return;
    const key = pageStateKey(state);
    if (key === last) return;
    last = key;
    lastSentAt = now();
    send(state);
  };

  return {
    push(state) {
      if (disposed) return;
      pending = { ...state };
      if (timer !== undefined) clearTimeout(timer);
      const wait = Math.max(debounceMs, lastSentAt + minIntervalMs - now());
      timer = setTimeout(flush, wait);
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
    },
  };
}
