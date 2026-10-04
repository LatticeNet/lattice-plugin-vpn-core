/**
 * pageState.ts, where a page's layer, open object, grouping, search, sort,
 * period and chart stacking live between reloads.
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
 * The limits are the contract's and are identical on both sides.
 */

import {
  PAGE_STATE_KEY_PATTERN,
  PAGE_STATE_MAX_KEYS,
  PAGE_STATE_MAX_VALUE_LENGTH,
  PAGE_STATE_RESERVED_KEYS,
  validPageState,
  type PageState,
} from "@latticenet/plugin-bridge";

import { isGroupBy, type GroupBy } from "./lineGroups";
import { STACK_BY, USAGE_PERIODS, USAGE_VIEWS, type StackBy, type UsagePeriod, type UsageView } from "./usageModel";
import {
  DEFAULT_USER_SORT,
  encodeUserSort,
  isUsersGroupBy,
  isUsersView,
  parseUserSort,
  type UserSort,
  type UsersGroupBy,
  type UsersView,
} from "./usersModel";

/* The contract's rules are plugin-bridge's (validPageState and the
 * PAGE_STATE_* constants), the same code the other plugin pages and their
 * client apply. This page still runs its own client (bridge.ts), which reads
 * them from here. */
export { PAGE_STATE_KEY_PATTERN, PAGE_STATE_MAX_KEYS, PAGE_STATE_MAX_VALUE_LENGTH, validPageState, type PageState };
/** The console's own query keys. They never cross the bridge either way. */
export const RESERVED_PAGE_STATE_KEYS: ReadonlySet<string> = PAGE_STATE_RESERVED_KEYS;

/** One entry under the contract's rules, asked of the bridge's own check. */
function validEntry(key: string, value: unknown): value is string {
  return validPageState({ [key]: value }) !== undefined;
}

/** The entries of a record without the console's reserved keys. */
export function withoutReservedKeys(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !RESERVED_PAGE_STATE_KEYS.has(key)));
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

/**
 * Everything the four pages keep. Each route encodes its own part, and one
 * frame only ever shows one route, so `q` and `open` are shared: the search
 * and the open object of whichever page this is (a line, an identity, a
 * node profile).
 */
export interface VpnPageState {
  linesView: LinesView;
  usageView: UsageView;
  group: GroupBy;
  /** The page's search as typed. */
  q: string;
  /** The object whose panel is open, or asked for by a link and not yet found. */
  open: string;
  period: UsagePeriod;
  stack: StackBy;
  /** Users: the subset the attention list points at, kept as `show`. */
  usersView: UsersView;
  usersGroup: UsersGroupBy;
  usersSort: UserSort;
  /** Users: the New identity form is open (`create=1`), so a link such as the
   *  console palette's "Add a VPN user" lands on the form. */
  create: boolean;
}

export const DEFAULT_PAGE_STATE: Readonly<VpnPageState> = {
  linesView: "overview",
  usageView: "overview",
  group: "node",
  q: "",
  open: "",
  period: "7d",
  stack: "exit",
  usersView: "all",
  usersGroup: "none",
  usersSort: { ...DEFAULT_USER_SORT },
  create: false,
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
    put("show", state.usersView, DEFAULT_PAGE_STATE.usersView);
    put("group", state.usersGroup, DEFAULT_PAGE_STATE.usersGroup);
    put("q", state.q.trim());
    put("sort", encodeUserSort(state.usersSort));
    put("open", state.open);
    if (state.create) put("create", "1");
  } else if (route === "profiles") {
    put("open", state.open);
  }
  return out;
}

/**
 * Address entries read back into state. It does not need the route: `view`
 * is read as a Lines layer and a Usage layer, and whichever the route shows
 * is the one that counts; `group` likewise. Anything unknown or out of range
 * falls back to the default, so a stale or hand-edited link still opens a
 * page.
 *
 * `view` names layers (design 23, 3.4), so the Users subset the attention
 * list points at is `show`. A link from before that says `view=unbound`;
 * it is read when there is no `show`, and never written back.
 *
 * `expand=<id>,<id>` is the Users page's older key, from when a row opened
 * its allocated nodes in place. That is the identity panel now, so the first
 * id opens it. The key is read, never written back.
 */
export function decodePageState(state: PageState): VpnPageState {
  const view = state.view ?? LEGACY_LENS[state.lens ?? ""];
  return {
    linesView: pick(view, LINES_VIEWS, DEFAULT_PAGE_STATE.linesView),
    usageView: pick(state.view, USAGE_VIEWS, DEFAULT_PAGE_STATE.usageView),
    group: isGroupBy(state.group) ? state.group : DEFAULT_PAGE_STATE.group,
    q: state.q ?? "",
    open: state.open ?? legacyExpand(state.expand),
    period: pick(state.period, USAGE_PERIODS, DEFAULT_PAGE_STATE.period),
    stack: pick(state.stack, STACK_BY, DEFAULT_PAGE_STATE.stack),
    usersView: isUsersView(state.show) ? state.show : isUsersView(state.view) ? state.view : DEFAULT_PAGE_STATE.usersView,
    usersGroup: isUsersGroupBy(state.group) ? state.group : DEFAULT_PAGE_STATE.usersGroup,
    usersSort: parseUserSort(state.sort),
    create: state.create === "1",
  };
}

function legacyExpand(value: string | undefined): string {
  return (value ?? "").split(",").map((id) => id.trim()).find(Boolean) ?? "";
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
