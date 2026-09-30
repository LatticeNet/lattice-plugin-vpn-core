/**
 * usersModel.ts, the Users collection: 134 identities read the way the
 * operator works through them.
 *
 * The jobs are to find an identity, see whether it works (enabled, bound to a
 * line, not expired, under quota), change it, and catch the ones about to
 * lapse. Everything here is pure so the rules can be tested without a page:
 *
 * - One word for where an identity stands (`identityState`), so the status
 *   column, the status grouping and the attention list cannot disagree.
 * - A column that is blank on every identity is a fact about the collection,
 *   not about a row. `userColumns` finds those so the header says it once.
 * - A group row holds aggregates in every member column (design 22 rule 3).
 *
 * The server writes Go's zero time, `0001-01-01T00:00:00Z`, for "no expiry":
 * the field is a `time.Time` and `omitempty` does not drop a struct. That
 * value is read as no expiry everywhere, and sending it back is how an
 * expiry is cleared, because the update handler stores it as the zero time
 * every expiry check already treats as none.
 */

import { quotaState, type AllocatedNode } from "./usageModel";
import { formatBytes, pageRows, type LineGroup, type VpnUser } from "./vpnModel";

export const EXPIRING_WITHIN_DAYS = 30;
const DAY_MS = 86_400_000;

/** What the update call takes to remove an expiry. */
export const NO_EXPIRY = "0001-01-01T00:00:00Z";

// ── expiry ───────────────────────────────────────────────────────────────

/** The expiry as a date, or undefined for none (absent, zero time or junk). */
export function expiryDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() <= 1) return undefined;
  return date;
}

export type ExpiryKind = "none" | "expired" | "soon" | "later";

export interface Expiry {
  kind: ExpiryKind;
  at?: Date;
  /** Milliseconds from now; negative once it has passed. */
  inMs?: number;
}

export function expiryOf(user: Pick<VpnUser, "expires_at">, now: number): Expiry {
  const at = expiryDate(user.expires_at);
  if (!at) return { kind: "none" };
  const inMs = at.getTime() - now;
  if (inMs <= 0) return { kind: "expired", at, inMs };
  if (inMs <= EXPIRING_WITHIN_DAYS * DAY_MS) return { kind: "soon", at, inMs };
  return { kind: "later", at, inMs };
}

/** "in 20 days", "within a day", "3 days ago". Whole days, rounded toward the event. */
export function expiryRelative(expiry: Expiry): string {
  if (expiry.inMs === undefined) return "";
  const days = Math.floor(Math.abs(expiry.inMs) / DAY_MS);
  if (expiry.inMs > 0) {
    if (days < 1) return "within a day";
    return `in ${days} ${days === 1 ? "day" : "days"}`;
  }
  if (days < 1) return "less than a day ago";
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** The expiry as a `datetime-local` value, or "" for none. */
export function expiryInput(value?: string): string {
  const date = expiryDate(value);
  if (!date) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * What an edit sends for the expiry: nothing when the field was not touched,
 * the zero time when it was emptied, the instant otherwise.
 *
 * Comparing against the prefilled value, not against blank, is the point. A
 * blank field used to mean "leave it", which made an expiry impossible to
 * clear; blank now means "none", and an untouched field still sends nothing,
 * so a rename never rewrites a date it did not show.
 */
export function expiryPayload(initial: string, current: string): string | undefined {
  const value = current.trim();
  if (value === initial.trim()) return undefined;
  if (!value) return NO_EXPIRY;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

// ── one word for where an identity stands ────────────────────────────────

export type StateTone = "healthy" | "warning" | "error" | "neutral";
export type IdentityStateKey = "expired" | "over_quota" | "expiring" | "unbound" | "active" | "disabled";

export interface IdentityState {
  key: IdentityStateKey;
  label: string;
  tone: StateTone;
  /** Higher is worse. Disabled is deliberate, so it ranks below active. */
  rank: number;
}

const STATES: Record<IdentityStateKey, IdentityState> = {
  expired: { key: "expired", label: "expired", tone: "error", rank: 5 },
  over_quota: { key: "over_quota", label: "over quota", tone: "error", rank: 4 },
  expiring: { key: "expiring", label: "expiring", tone: "warning", rank: 3 },
  unbound: { key: "unbound", label: "no line", tone: "warning", rank: 2 },
  active: { key: "active", label: "active", tone: "healthy", rank: 1 },
  disabled: { key: "disabled", label: "disabled", tone: "neutral", rank: 0 },
};

/** Bound means at least one enabled binding: the credential is placed somewhere. */
export function isBound(user: Pick<VpnUser, "bindings">): boolean {
  return (user.bindings ?? []).some((binding) => binding.enabled);
}

export function isOverQuota(user: Pick<VpnUser, "used_period_bytes" | "quota_bytes">): boolean {
  return quotaState(user.used_period_bytes ?? 0, user.quota_bytes).over;
}

export function hasQuota(user: Pick<VpnUser, "quota_bytes">): boolean {
  return (user.quota_bytes ?? 0) > 0;
}

/** Traffic has been counted to this identity at some point the server still holds. */
export function isAttributed(user: Pick<VpnUser, "used_total_bytes" | "used_period_bytes">): boolean {
  return (user.used_total_bytes ?? 0) > 0 || (user.used_period_bytes ?? 0) > 0;
}

/** The server sent the usage read model with the list; an older one does not. */
export function usageReported(users: readonly VpnUser[]): boolean {
  return users.some((user) => user.used_period_bytes !== undefined || user.allocated_nodes !== undefined);
}

/**
 * Every condition an identity is in, worst first. An identity can expire
 * within 30 days and have no line at once, and the head, the attention list
 * and the numbers count each condition, so one fact has one number on the
 * page. A disabled identity is only disabled: it signs in nowhere, so its
 * expiry or its missing line is not a problem to fix.
 */
export function identityConditions(user: VpnUser, now: number): IdentityState[] {
  if (!user.enabled) return [STATES.disabled];
  const expiry = expiryOf(user, now).kind;
  const out: IdentityState[] = [];
  if (expiry === "expired") out.push(STATES.expired);
  if (isOverQuota(user)) out.push(STATES.over_quota);
  if (expiry === "soon") out.push(STATES.expiring);
  if (!isBound(user)) out.push(STATES.unbound);
  return out.length ? out : [STATES.active];
}

/** The worst condition: what a row sorts and groups by. */
export function identityState(user: VpnUser, now: number): IdentityState {
  return identityConditions(user, now)[0]!;
}

/** A state that says something is wrong, and so never recedes. */
export function isProblem(state: Pick<IdentityState, "tone">): boolean {
  return state.tone === "error" || state.tone === "warning";
}

/** Identity states worst first, for group order and the status sort. */
export const STATE_ORDER: readonly IdentityStateKey[] = ["expired", "over_quota", "expiring", "unbound", "active", "disabled"];

// ── the collection at a glance ───────────────────────────────────────────

export interface StateCount {
  key: IdentityStateKey;
  label: string;
  tone: StateTone;
  count: number;
}

export interface UsersSummary {
  total: number;
  enabled: number;
  disabled: number;
  usageReported: boolean;
  attributed: number;
  /** Enabled identities whose expiry has passed, most recent first. */
  expired: VpnUser[];
  /** Enabled identities that expire within 30 days, soonest first. */
  expiring: VpnUser[];
  /** Enabled identities with no enabled binding. */
  unbound: VpnUser[];
  /** Enabled identities past their quota, furthest over first. */
  overQuotaUsers: VpnUser[];
  overQuota: number;
  withQuota: number;
  /** Sum of each identity's period figure; meaningful only when usage is reported. */
  periodBytes: number;
  /**
   * Identities per condition, worst first; conditions with no identity are
   * left out. An identity in two conditions counts in both, as it does in the
   * attention list, so the counts can add up to more than the total.
   */
  states: StateCount[];
}

function byExpiry(now: number, direction: 1 | -1) {
  return (a: VpnUser, b: VpnUser) =>
    direction * ((expiryOf(a, now).at?.getTime() ?? 0) - (expiryOf(b, now).at?.getTime() ?? 0)) || compareText(a.email, b.email);
}

export function usersSummary(users: readonly VpnUser[], now: number): UsersSummary {
  const counts = new Map<IdentityStateKey, number>();
  const expired: VpnUser[] = [];
  const expiring: VpnUser[] = [];
  const unbound: VpnUser[] = [];
  const overQuotaUsers: VpnUser[] = [];
  let enabled = 0;
  let attributed = 0;
  let withQuota = 0;
  let periodBytes = 0;
  for (const user of users) {
    for (const state of identityConditions(user, now)) counts.set(state.key, (counts.get(state.key) ?? 0) + 1);
    if (isAttributed(user)) attributed += 1;
    if (hasQuota(user)) withQuota += 1;
    periodBytes += user.used_period_bytes ?? 0;
    if (!user.enabled) continue;
    enabled += 1;
    const expiry = expiryOf(user, now).kind;
    if (expiry === "expired") expired.push(user);
    if (expiry === "soon") expiring.push(user);
    if (!isBound(user)) unbound.push(user);
    if (isOverQuota(user)) overQuotaUsers.push(user);
  }
  const overBy = (user: VpnUser) => (user.used_period_bytes ?? 0) / (user.quota_bytes || 1);
  return {
    total: users.length,
    enabled,
    disabled: users.length - enabled,
    usageReported: usageReported(users),
    attributed,
    expired: expired.sort(byExpiry(now, -1)),
    expiring: expiring.sort(byExpiry(now, 1)),
    unbound,
    overQuotaUsers: overQuotaUsers.sort((a, b) => overBy(b) - overBy(a) || compareText(a.email, b.email)),
    overQuota: overQuotaUsers.length,
    withQuota,
    periodBytes,
    states: STATE_ORDER.filter((key) => counts.has(key)).map((key) => ({ ...pick(STATES[key]), count: counts.get(key)! })),
  };
}

function pick(state: IdentityState): Omit<StateCount, "count"> {
  return { key: state.key, label: state.label, tone: state.tone };
}

// ── attention ────────────────────────────────────────────────────────────

/** A subset of the collection the attention list points at, kept as `show`. */
export const USERS_VIEWS = ["all", "expired", "over_quota", "expiring", "unbound"] as const;
export type UsersView = (typeof USERS_VIEWS)[number];

export function isUsersView(value: string | undefined): value is UsersView {
  return !!value && (USERS_VIEWS as readonly string[]).includes(value);
}

export function inView(user: VpnUser, view: UsersView, now: number): boolean {
  if (view === "all") return true;
  if (!user.enabled) return false;
  if (view === "expired") return expiryOf(user, now).kind === "expired";
  if (view === "over_quota") return isOverQuota(user);
  if (view === "expiring") return expiryOf(user, now).kind === "soon";
  return !isBound(user);
}

/** The sentence over a table narrowed to one view. */
export function viewSentence(view: UsersView, count: number): string {
  const one = count === 1;
  switch (view) {
    case "expired": return `${count} enabled ${one ? "identity has" : "identities have"} expired.`;
    case "over_quota": return `${count} enabled ${one ? "identity is" : "identities are"} over ${one ? "its" : "their"} quota.`;
    case "expiring": return `${count} ${one ? "identity expires" : "identities expire"} within ${EXPIRING_WITHIN_DAYS} days.`;
    case "unbound": return `${count} enabled ${one ? "identity is" : "identities are"} bound to no line.`;
    default: return "";
  }
}

export interface UsersAttentionItem {
  key: string;
  severity: "error" | "warning";
  claim: string;
  evidence: string;
  view: UsersView;
}

function names(users: readonly VpnUser[], describe: (user: VpnUser) => string, limit = 3): string {
  const shown = users.slice(0, limit).map(describe).join(", ");
  return users.length > limit ? `${shown} and ${users.length - limit} more` : shown;
}

/**
 * Each item is a claim, the identities that prove it, and the view that lists
 * them. Only enabled identities count: a disabled identity signs in nowhere
 * already, so its expiry or its missing line is not a problem to fix.
 */
export function usersAttention(users: readonly VpnUser[], now: number, formatDay: (date: Date) => string): UsersAttentionItem[] {
  const summary = usersSummary(users, now);
  const items: UsersAttentionItem[] = [];
  const dated = (user: VpnUser) => {
    const at = expiryOf(user, now).at;
    return at ? `${user.email} (${formatDay(at)})` : user.email;
  };
  if (summary.expired.length) {
    const count = summary.expired.length;
    items.push({
      key: "expired", severity: "error", view: "expired",
      claim: `${count} enabled ${count === 1 ? "identity has" : "identities have"} expired`,
      evidence: `${names(summary.expired, dated)}. A Sub-Store subscription built for an expired identity fails to render. Extend or clear the expiry, or disable it.`,
    });
  }
  if (summary.overQuotaUsers.length) {
    const count = summary.overQuotaUsers.length;
    const usage = (user: VpnUser) => `${user.email} (${formatBytes(user.used_period_bytes ?? 0)} of ${formatBytes(user.quota_bytes)})`;
    items.push({
      key: "over_quota", severity: "error", view: "over_quota",
      claim: `${count} enabled ${count === 1 ? "identity is" : "identities are"} over ${count === 1 ? "its" : "their"} quota`,
      evidence: `${names(summary.overQuotaUsers, usage)}. Raise or remove the quota in the identity's panel, or disable ${count === 1 ? "it" : "them"}.`,
    });
  }
  if (summary.expiring.length) {
    const count = summary.expiring.length;
    items.push({
      key: "expiring", severity: "warning", view: "expiring",
      claim: `${count} ${count === 1 ? "identity expires" : "identities expire"} within ${EXPIRING_WITHIN_DAYS} days`,
      evidence: `${names(summary.expiring, dated)}. Extend or clear the expiry in the identity's panel before then.`,
    });
  }
  if (summary.unbound.length) {
    const count = summary.unbound.length;
    items.push({
      key: "unbound", severity: "warning", view: "unbound",
      claim: `${count} enabled ${count === 1 ? "identity is" : "identities are"} bound to no line`,
      evidence: `Lattice has placed ${count === 1 ? "its credential" : "their credentials"} on no line, so ${count === 1 ? "it signs" : "they sign"} in nowhere Lattice manages. Bind a line in the identity's panel, or disable ${count === 1 ? "it" : "them"}.`,
    });
  }
  return items;
}

// ── search, sort, group ──────────────────────────────────────────────────

function compareText(a: string | undefined, b: string | undefined): number {
  return (a ?? "").localeCompare(b ?? "", undefined, { sensitivity: "base", numeric: true });
}

/** Every word must appear in the identity's email, name, id, group, comment or a protocol. */
export function searchUsers(users: readonly VpnUser[], query: string): VpnUser[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...users];
  return users.filter((user) => {
    const haystack = [
      user.email, user.name, user.id, user.group, user.comment,
      ...(user.credentials ?? []).map((credential) => credential.protocol),
    ].filter(Boolean).join(" ").toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export const USER_SORT_KEYS = ["identity", "group", "status", "expires", "quota", "lines", "used"] as const;
export type UserSortKey = (typeof USER_SORT_KEYS)[number];

export interface UserSort {
  key: UserSortKey;
  /** The column's natural order reversed. Missing values stay last either way. */
  reverse: boolean;
}

export const DEFAULT_USER_SORT: Readonly<UserSort> = { key: "identity", reverse: false };

/** `expires` or `-expires`; anything else is the default. */
export function parseUserSort(raw: string | undefined): UserSort {
  const value = (raw ?? "").trim();
  const reverse = value.startsWith("-");
  const key = reverse ? value.slice(1) : value;
  return (USER_SORT_KEYS as readonly string[]).includes(key) ? { key: key as UserSortKey, reverse } : { ...DEFAULT_USER_SORT };
}

/** The address spelling, "" for the default so the address stays short. */
export function encodeUserSort(sort: UserSort): string {
  if (sort.key === DEFAULT_USER_SORT.key && sort.reverse === DEFAULT_USER_SORT.reverse) return "";
  return `${sort.reverse ? "-" : ""}${sort.key}`;
}

/**
 * Each column's natural order: names A to Z, the worst state first, the
 * soonest expiry first, the fullest quota first, the most lines and bytes
 * first. A value the identity does not have (no group, no expiry) sorts last
 * in both directions, so reversing never floods the top with blanks.
 */
function sortValue(user: VpnUser, key: UserSortKey, now: number): number | string | undefined {
  switch (key) {
    case "identity": return user.email;
    case "group": return user.group?.trim() || undefined;
    case "status": return -identityState(user, now).rank;
    case "expires": return expiryOf(user, now).at?.getTime();
    case "quota": return hasQuota(user) ? -quotaState(user.used_period_bytes ?? 0, user.quota_bytes).percent : undefined;
    case "lines": return -(user.bindings ?? []).filter((binding) => binding.enabled).length;
    case "used": return user.used_period_bytes === undefined ? undefined : -user.used_period_bytes;
  }
}

export function sortUsers(users: readonly VpnUser[], sort: UserSort, now: number): VpnUser[] {
  const direction = sort.reverse ? -1 : 1;
  const keyed = users.map((user) => ({ user, value: sortValue(user, sort.key, now) }));
  keyed.sort((a, b) => {
    const missing = Number(a.value === undefined) - Number(b.value === undefined);
    if (missing) return missing;
    let primary = 0;
    if (typeof a.value === "number" && typeof b.value === "number") primary = a.value - b.value;
    else if (a.value !== undefined && b.value !== undefined) primary = compareText(String(a.value), String(b.value));
    return direction * primary || compareText(a.user.email, b.user.email) || compareText(a.user.id, b.user.id);
  });
  return keyed.map((entry) => entry.user);
}

export const USERS_GROUP_BY = ["none", "group", "status"] as const;
export type UsersGroupBy = (typeof USERS_GROUP_BY)[number];

export function isUsersGroupBy(value: string | undefined): value is UsersGroupBy {
  return !!value && (USERS_GROUP_BY as readonly string[]).includes(value);
}

export interface UserAggregate {
  count: number;
  enabled: number;
  /** The worst state in the group and how many members hold it. */
  worst: StateCount;
  uniformState: boolean;
  expired: number;
  expiring: number;
  withExpiry: number;
  /** The soonest expiry still ahead, if any member has one. */
  nextExpiry?: Date;
  withQuota: number;
  overQuota: number;
  /** Enabled bindings across the members, and members holding at least one. */
  bindings: number;
  bound: number;
  attributed: number;
  usedBytes: number;
  groups: number;
}

export interface UserGroupRow {
  key: string;
  label: string;
  users: VpnUser[];
  agg: UserAggregate;
}

export function aggregateUsers(users: readonly VpnUser[], now: number): UserAggregate {
  const states = new Map<IdentityStateKey, number>();
  const groups = new Set<string>();
  let nextExpiry: Date | undefined;
  const agg = {
    count: users.length, enabled: 0, expired: 0, expiring: 0, withExpiry: 0, withQuota: 0, overQuota: 0,
    bindings: 0, bound: 0, attributed: 0, usedBytes: 0,
  };
  for (const user of users) {
    const state = identityState(user, now);
    states.set(state.key, (states.get(state.key) ?? 0) + 1);
    groups.add(user.group?.trim() ?? "");
    if (user.enabled) agg.enabled += 1;
    const expiry = expiryOf(user, now);
    if (expiry.at) agg.withExpiry += 1;
    if (user.enabled && expiry.kind === "expired") agg.expired += 1;
    if (user.enabled && expiry.kind === "soon") agg.expiring += 1;
    if (expiry.at && expiry.kind !== "expired" && (!nextExpiry || expiry.at < nextExpiry)) nextExpiry = expiry.at;
    if (hasQuota(user)) agg.withQuota += 1;
    if (user.enabled && isOverQuota(user)) agg.overQuota += 1;
    const enabledBindings = (user.bindings ?? []).filter((binding) => binding.enabled).length;
    agg.bindings += enabledBindings;
    if (enabledBindings) agg.bound += 1;
    if (isAttributed(user)) agg.attributed += 1;
    agg.usedBytes += user.used_period_bytes ?? 0;
  }
  const worstKey = STATE_ORDER.find((key) => states.has(key)) ?? "active";
  return {
    ...agg,
    worst: { ...pick(STATES[worstKey]), count: states.get(worstKey) ?? 0 },
    uniformState: states.size <= 1,
    nextExpiry,
    groups: groups.size,
  };
}

/**
 * Groups over an already sorted list; members keep that order. Groups by
 * name run A to Z with "no group" last, groups by state run worst first.
 */
export function groupUsers(users: readonly VpnUser[], by: UsersGroupBy, now: number): UserGroupRow[] {
  if (by === "none") return [];
  const buckets = new Map<string, VpnUser[]>();
  for (const user of users) {
    const key = by === "group" ? (user.group?.trim() || "") : identityState(user, now).key;
    const list = buckets.get(key) ?? buckets.set(key, []).get(key)!;
    list.push(user);
  }
  const keys = [...buckets.keys()];
  if (by === "group") keys.sort((a, b) => Number(a === "") - Number(b === "") || compareText(a, b));
  else keys.sort((a, b) => STATE_ORDER.indexOf(a as IdentityStateKey) - STATE_ORDER.indexOf(b as IdentityStateKey));
  return keys.map((key) => ({
    key: `${by}:${key}`,
    label: by === "group" ? (key || "no group") : STATES[key as IdentityStateKey].label,
    users: buckets.get(key)!,
    agg: aggregateUsers(buckets.get(key)!, now),
  }));
}

// ── columns with nothing to show ─────────────────────────────────────────

export interface UserColumns {
  group: boolean;
  status: boolean;
  expires: boolean;
  quota: boolean;
  lines: boolean;
  used: boolean;
}

/**
 * Which columns earn their place, judged on the whole collection so a search
 * never makes columns jump. A column blank on every identity leaves the table
 * and its one fact goes to the header instead.
 */
export function userColumns(users: readonly VpnUser[], now: number): { show: UserColumns; notes: string[] } {
  const summary = usersSummary(users, now);
  const show: UserColumns = {
    group: users.some((user) => !!user.group?.trim()),
    status: summary.states.length > 1,
    expires: users.some((user) => !!expiryDate(user.expires_at)),
    quota: users.some(hasQuota),
    lines: users.some(isBound),
    used: summary.usageReported && summary.attributed > 0,
  };
  const notes: string[] = [];
  if (!users.length) return { show, notes };
  if (!show.group) notes.push("no identity is in a group");
  if (!show.expires) notes.push("no identity has an expiry");
  if (!show.quota) notes.push("no identity has a quota");
  if (!show.lines) notes.push("no identity is bound to a line");
  if (!summary.usageReported) notes.push("this server does not report usage per identity");
  else if (!summary.attributed) notes.push("no traffic is counted to any identity");
  return { show, notes };
}

// ── paging a grouped table ───────────────────────────────────────────────

export type UserTableRow =
  | { kind: "group"; group: UserGroupRow; continued: boolean }
  | { kind: "user"; user: VpnUser };

export interface UserPage {
  rows: UserTableRow[];
  page: number;
  pages: number;
  /** Ordinal of the first and last identity on the page; 0 when it shows none. */
  from: number;
  to: number;
  total: number;
}

/**
 * A page is at most `size` identities. A grouped table pages by identity too,
 * not by group: one group of 121 would otherwise be a single 5,000 px page. A
 * group cut by a page break repeats its header, marked continued, so no
 * identity is ever shown without the group it sits in. A folded group is one
 * slot, so folding never strands a page with nothing on it.
 */
export function pageUserTable(input: { flat?: readonly VpnUser[]; groups?: readonly UserGroupRow[] }, requestedPage: number, size: number, folded: ReadonlySet<string> = new Set()): UserPage {
  if (input.flat) {
    const page = pageRows(input.flat, requestedPage, size);
    return { ...page, rows: page.rows.map((user) => ({ kind: "user" as const, user })) };
  }
  type Slot = { group: UserGroupRow; user?: VpnUser; ordinal: number; first: boolean };
  const slots: Slot[] = [];
  let ordinal = 0;
  let total = 0;
  for (const group of input.groups ?? []) {
    total += group.users.length;
    if (folded.has(group.key)) {
      slots.push({ group, ordinal: 0, first: true });
      continue;
    }
    group.users.forEach((user, index) => {
      ordinal += 1;
      slots.push({ group, user, ordinal, first: index === 0 });
    });
  }
  const page = pageRows(slots, requestedPage, size);
  const rows: UserTableRow[] = [];
  let current: string | undefined;
  for (const slot of page.rows) {
    if (!slot.user) {
      rows.push({ kind: "group", group: slot.group, continued: false });
      current = slot.group.key;
      continue;
    }
    if (current !== slot.group.key) {
      rows.push({ kind: "group", group: slot.group, continued: !slot.first });
      current = slot.group.key;
    }
    rows.push({ kind: "user", user: slot.user });
  }
  const ordinals = page.rows.filter((slot) => slot.user).map((slot) => slot.ordinal);
  return {
    rows,
    page: page.page,
    pages: page.pages,
    from: ordinals.length ? ordinals[0] : 0,
    to: ordinals.length ? ordinals[ordinals.length - 1] : 0,
    total,
  };
}

/** The page that holds an identity, so a panel opened from a link has its row on screen. */
export function rowsHoldUser(rows: readonly UserTableRow[], userID: string): boolean {
  return rows.some((row) => row.kind === "user" && row.user.id === userID);
}

// ── the line picker ──────────────────────────────────────────────────────

export interface LineOption {
  hash: string;
  node: string;
  name: string;
  /** Protocol and port, the way the Lines table shows them. */
  detail: string;
  haystack: string;
}

export function lineOptions(groups: readonly LineGroup[]): LineOption[] {
  const options: LineOption[] = [];
  for (const group of groups) {
    const node = group.node_name || group.node_id;
    for (const line of group.lines) {
      const detail = `${line.type || "unknown"} :${line.listen_port ?? "?"}`;
      options.push({
        hash: line.line_hash_id, node, name: line.name, detail,
        haystack: [node, line.name, detail, line.line_hash_id, line.public_host, line.domain].filter(Boolean).join(" ").toLowerCase(),
      });
    }
  }
  return options;
}

/** Options matching every word, minus the ones already bound, at most `limit` shown. */
export function filterLineOptions(options: readonly LineOption[], query: string, exclude: ReadonlySet<string>, limit = 8): { shown: LineOption[]; matched: number } {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matched = options.filter((option) => !exclude.has(option.hash) && words.every((word) => option.haystack.includes(word)));
  return { shown: matched.slice(0, limit), matched: matched.length };
}

// ── per-node usage in the panel ──────────────────────────────────────────

/** Bytes an allocated node carried for the identity, or undefined when its collector is silent. */
export function allocatedNodeBytes(node: AllocatedNode): number | undefined {
  if (node.collector_state !== "ok") return undefined;
  return (node.lines ?? []).reduce((sum, line) => sum + (line.counted ? line.period_uplink + line.period_downlink : 0), 0);
}

// ── what the page says about one identity ────────────────────────────────

/** The date an operator reads, in their own locale: "Oct 20, 2026". */
export function formatDay(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

/**
 * The outcome of an action on one identity, shown beside its row until the
 * bridge has a toast. `anchor` is the row it follows: the identity itself, or
 * for a delete the row that was above it, "" when it was the first.
 */
export interface UserOutcome {
  userId: string;
  anchor: string;
  text: string;
  tone: "success" | "error";
  /** Puts back what the action changed; the note offers it as Undo. */
  undo?: () => void;
  /** Where the identity's panel says it: in the Lines section for a binding, at the top otherwise. */
  section?: "lines";
}

/**
 * The period figure as a claim: "not reported" when the server sent none,
 * "none counted" when it counted nothing, "at least" when an allocated node's
 * collector is silent and the sum covers only the nodes that reported.
 */
export function usedLabel(user: VpnUser, format: (bytes: number) => string): string {
  if (user.used_period_bytes === undefined) return "not reported";
  if (!isAttributed(user)) return "none counted";
  const silent = (user.allocated_nodes ?? []).some((node) => node.collector_state !== "ok");
  return `${silent ? "at least " : ""}${format(user.used_period_bytes)}`;
}
