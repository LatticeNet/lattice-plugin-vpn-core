/**
 * usageModel.ts, the read model behind the Usage and Users screens.
 *
 * The server decides attribution; this file only reads what it decided and
 * refuses to round it off. Three rules from the wire contract drive every
 * function here, and each one exists because the obvious shortcut is wrong:
 *
 * 1. `counted` says whether a row feeds an identity's total and quota. A row
 *    can carry real bytes and still not be counted (a relayed portion already
 *    counted at the entry, or an estimate). Summing `used_bytes` per user
 *    without checking `counted` double-counts a chain.
 * 2. `estimate` marks a subtraction (inbound counter minus upstream relay
 *    counters), not a measurement. It is shown as an estimate wherever it
 *    appears, never silently mixed into a measured figure.
 * 3. `counted_at` is NOT a timestamp. It is a comma-joined list of upstream
 *    line hash ids whose entry counter already carries these bytes. The name
 *    reads like a time and parsing it as one yields "Invalid Date" on the
 *    exact rows that most need explaining.
 *
 * Node totals count everything, user totals count only the entry. That gap is
 * `double_counted_via_chains_bytes` and it is reported, never reconciled away.
 */

import type { LineGroup } from "./vpnModel";

/** How the server decided who owns a row's bytes. Six values, all literal. */
export type UsageAttribution =
  | "named"
  | "credential"
  | "binding"
  | "substore"
  | "none"
  | "unknown_line";

/** Whether the identity was demonstrated or guessed by exclusion. */
export type UsageProof = "proof" | "inferred";

/** A line's place in a chain. `direct` is a line that is in no chain. */
export type UsageRole = "direct" | "entry" | "relay" | "exit" | "shared";

/** What a node's usage collector is doing. Only `ok` means the bytes are real. */
export type CollectorState = "ok" | "error" | "stats_off" | "no_collector";

export type Tone = "healthy" | "warning" | "error" | "neutral" | "info";

/**
 * One attributed slice of one line's traffic, exactly as the server sends it.
 * Optional fields are `omitempty` on the wire and genuinely absent, not zero.
 */
export interface UsageLineRow {
  node_id: string;
  node_name?: string;
  line_hash_id?: string;
  tag: string;
  role: string;
  /** Comma-joined upstream line hash ids, not a time. See the header note. */
  counted_at?: string;
  uplink: number;
  downlink: number;
  used_bytes: number;
  attribution: string;
  attribution_proof?: string;
  attribution_reason?: string;
  user_id?: string;
  email?: string;
  /** VpnUser ids that could own these bytes when the server refused to pick. */
  candidates?: string[];
  /** The row is a subtraction, not a counter the box reported. */
  estimate?: boolean;
  /** The row feeds the identity's totals and quota. */
  counted: boolean;
}

/** The `latticenet.vpn-core/usage` query answer. Legacy fields kept as sent. */
export interface UsageQueryResult {
  by_user?: unknown[];
  by_node?: unknown[];
  rows?: unknown[];
  collectors?: UsageCollectorRow[];
  per_line?: boolean;
  lines?: UsageLineRow[];
  double_counted_via_chains_bytes?: number;
  period?: string;
  from?: string;
  to?: string;
}

export interface UsageCollectorRow {
  node_id: string;
  node_name?: string;
  source?: string;
  status?: string;
  error?: string;
  checked_at?: string;
}

/** One line a user is allocated, from the users list. */
export interface AllocatedLine {
  line_hash_id: string;
  tag?: string;
  role: string;
  /** binding | substore | relay */
  allocation: string;
  period_uplink: number;
  period_downlink: number;
  last_seen_at?: string;
  counted: boolean;
  estimate?: boolean;
  via_relay?: boolean;
}

export interface AllocatedNode {
  node_id: string;
  node_name?: string;
  collector_state: string;
  lines: AllocatedLine[];
}

/** The periods the server accepts, in the order the console offers them. */
export const USAGE_PERIODS = ["today", "7d", "30d", "all"] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];

export function isUsagePeriod(value: string): value is UsagePeriod {
  return (USAGE_PERIODS as readonly string[]).includes(value);
}

export function periodLabel(period: string): string {
  return ({
    today: "Today",
    "7d": "Last 7 days",
    "30d": "Last 30 days",
    all: "All retained",
  } as Record<string, string>)[period] ?? period;
}

/**
 * The `yyyymmdd` bounds the server echoes, as a readable range.
 * Returns "" when either end is missing, so a caller can omit the line
 * entirely rather than print half a range.
 */
export function formatDayRange(from?: string, to?: string): string {
  const start = formatDay(from);
  const end = formatDay(to);
  if (!start || !end) return "";
  return start === end ? start : `${start} to ${end}`;
}

export function formatDay(value?: string): string {
  const raw = value?.trim() ?? "";
  if (!/^\d{8}$/.test(raw)) return "";
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

/** The upstream lines named by `counted_at`, or [] when the row stands alone. */
export function upstreamLines(row: UsageLineRow): string[] {
  return (row.counted_at ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/** A short word for the chain role, using the operator's vocabulary. */
export function roleLabel(role: string): string {
  return ({
    direct: "direct",
    entry: "entry",
    relay: "relay",
    exit: "exit",
    shared: "shared",
  } as Record<string, string>)[role] ?? (role || "unknown");
}

/**
 * The attribution as a phrase an operator can act on.
 *
 * "none" is never rendered as a blank or a zero: the bytes are real and the
 * owner is unknown, and saying so is the whole point of the column.
 */
export function attributionLabel(row: UsageLineRow): string {
  switch (row.attribution) {
    case "named":
      return "named user";
    case "credential":
      return "credential match";
    case "binding":
      return "only binding";
    case "substore":
      return "only Sub-Store record";
    case "unknown_line":
      return "unknown line";
    case "none":
      return row.candidates?.length ? "unattributed" : "no user";
    default:
      return row.attribution || "unknown";
  }
}

/**
 * Tone for the attribution chip. Proven attributions read healthy, inferred
 * ones read as a caution, and anything the server would not attribute reads
 * warning rather than error: unattributed traffic is a gap in knowledge, not
 * a failure of the node.
 */
export function attributionTone(row: UsageLineRow): Tone {
  switch (row.attribution) {
    case "named":
      return "healthy";
    case "credential":
      return row.attribution_proof === "proof" ? "healthy" : "info";
    case "binding":
    case "substore":
      return "info";
    case "unknown_line":
      return "error";
    default:
      return "warning";
  }
}

/** "measured" or "estimated", the word that belongs next to every byte figure. */
export function measurementLabel(row: UsageLineRow): string {
  return row.estimate ? "estimated" : "measured";
}

export function collectorLabel(state: string): string {
  return ({
    ok: "reporting",
    error: "collector failing",
    stats_off: "stats API off",
    no_collector: "no collector",
  } as Record<string, string>)[state] ?? (state || "not reported");
}

export function collectorTone(state: string): Tone {
  if (state === "ok") return "healthy";
  if (state === "error") return "error";
  return "warning";
}

/**
 * Whether a node's usage figures can be believed. Anything but `ok` means the
 * bytes from that node are unknown, which is not the same as zero, and every
 * total built on it has to say so.
 */
export function collectorReports(state: string): boolean {
  return state === "ok";
}

export interface UsageUserTotal {
  userID: string;
  email?: string;
  /** Bytes the server counted against this identity. */
  countedBytes: number;
  /** Counted bytes that came from an estimated row. */
  estimatedBytes: number;
  /** Rows attributed to this identity but not counted (already counted upstream). */
  uncountedBytes: number;
  nodes: string[];
  lines: number;
  /** True when any counted row for this identity was an estimate. */
  hasEstimate: boolean;
}

export interface UsageNodeTotal {
  nodeID: string;
  nodeName?: string;
  /** Every byte the node reported, counted or not. Node totals count all. */
  totalBytes: number;
  /** Bytes on this node the server could not place on an identity. */
  unattributedBytes: number;
  /** Bytes excluded from user totals because an upstream entry counted them. */
  relayedBytes: number;
  estimatedBytes: number;
  users: number;
  lines: number;
}

export interface UsageFold {
  byUser: UsageUserTotal[];
  byNode: UsageNodeTotal[];
  /** Sum of every row, which is the fleet's traffic including chain overlap. */
  totalBytes: number;
  /** Sum of rows that feed an identity's total. */
  countedBytes: number;
  /** Real bytes with no identity: attribution none or unknown_line. */
  unattributedBytes: number;
  /** Rows whose bytes are a subtraction rather than a counter. */
  estimatedBytes: number;
  /** Rows the server could not place on any line at all. */
  unknownLineBytes: number;
  rows: number;
}

const EMPTY_FOLD: UsageFold = {
  byUser: [],
  byNode: [],
  totalBytes: 0,
  countedBytes: 0,
  unattributedBytes: 0,
  estimatedBytes: 0,
  unknownLineBytes: 0,
  rows: 0,
};

function bytesOf(row: UsageLineRow): number {
  return Number.isFinite(row.used_bytes) ? Math.max(0, row.used_bytes) : 0;
}

/**
 * Fold the line rows into the per-user and per-node totals the screen shows.
 *
 * A user's total is the sum of its `counted` rows only, which is the same
 * number the server's quota accounting uses. A node's total is every row it
 * reported, because a node really did move those bytes. The two disagree by
 * the chain overlap on purpose, and the server states that gap separately.
 */
export function foldUsage(lines: readonly UsageLineRow[] | undefined): UsageFold {
  if (!lines?.length) return { ...EMPTY_FOLD };

  const users = new Map<string, UsageUserTotal & { nodeIDs: Set<string> }>();
  const nodes = new Map<string, UsageNodeTotal & { userIDs: Set<string> }>();
  let totalBytes = 0;
  let countedBytes = 0;
  let unattributedBytes = 0;
  let estimatedBytes = 0;
  let unknownLineBytes = 0;

  for (const row of lines) {
    const bytes = bytesOf(row);
    totalBytes += bytes;
    if (row.estimate) estimatedBytes += bytes;
    if (row.attribution === "unknown_line") unknownLineBytes += bytes;
    if (!row.user_id) unattributedBytes += bytes;

    let node = nodes.get(row.node_id);
    if (!node) {
      node = {
        nodeID: row.node_id,
        nodeName: row.node_name,
        totalBytes: 0,
        unattributedBytes: 0,
        relayedBytes: 0,
        estimatedBytes: 0,
        users: 0,
        lines: 0,
        userIDs: new Set<string>(),
      };
      nodes.set(row.node_id, node);
    }
    node.nodeName ??= row.node_name;
    node.totalBytes += bytes;
    node.lines += 1;
    if (row.estimate) node.estimatedBytes += bytes;
    if (!row.user_id) node.unattributedBytes += bytes;
    if (row.user_id && !row.counted) node.relayedBytes += bytes;
    if (row.user_id) node.userIDs.add(row.user_id);

    if (!row.user_id) continue;
    if (row.counted) countedBytes += bytes;

    let user = users.get(row.user_id);
    if (!user) {
      user = {
        userID: row.user_id,
        email: row.email,
        countedBytes: 0,
        estimatedBytes: 0,
        uncountedBytes: 0,
        nodes: [],
        lines: 0,
        hasEstimate: false,
        nodeIDs: new Set<string>(),
      };
      users.set(row.user_id, user);
    }
    user.email ??= row.email;
    user.lines += 1;
    user.nodeIDs.add(row.node_id);
    if (row.counted) {
      user.countedBytes += bytes;
      if (row.estimate) {
        user.estimatedBytes += bytes;
        user.hasEstimate = true;
      }
    } else {
      user.uncountedBytes += bytes;
    }
  }

  return {
    byUser: [...users.values()]
      .map(({ nodeIDs, ...user }) => ({ ...user, nodes: [...nodeIDs].sort() }))
      .sort((a, b) => b.countedBytes - a.countedBytes || a.userID.localeCompare(b.userID)),
    byNode: [...nodes.values()]
      .map(({ userIDs, ...node }) => ({ ...node, users: userIDs.size }))
      .sort((a, b) => b.totalBytes - a.totalBytes || a.nodeID.localeCompare(b.nodeID)),
    totalBytes,
    countedBytes,
    unattributedBytes,
    estimatedBytes,
    unknownLineBytes,
    rows: lines.length,
  };
}

export interface QuotaState {
  /** No quota is a real state, not a zero one. */
  hasQuota: boolean;
  usedBytes: number;
  quotaBytes: number;
  /** 0..100, clamped. Meaningless without a quota; callers check hasQuota. */
  percent: number;
  over: boolean;
  /** Bytes still available, floored at zero. */
  remainingBytes: number;
  tone: Tone;
}

/**
 * A quota reading. Zero and absent are both "no quota set" on this wire: the
 * server omits `quota_bytes` when unlimited and stores 0 to mean unlimited,
 * so a 0 here must never render as a quota the user has already blown.
 */
export function quotaState(usedBytes: number, quotaBytes?: number): QuotaState {
  const used = Number.isFinite(usedBytes) ? Math.max(0, usedBytes) : 0;
  const quota = Number.isFinite(quotaBytes) ? Math.max(0, quotaBytes ?? 0) : 0;
  if (quota <= 0) {
    return { hasQuota: false, usedBytes: used, quotaBytes: 0, percent: 0, over: false, remainingBytes: 0, tone: "neutral" };
  }
  const percent = Math.min(100, Math.round((used / quota) * 100));
  const over = used >= quota;
  return {
    hasQuota: true,
    usedBytes: used,
    quotaBytes: quota,
    percent,
    over,
    remainingBytes: Math.max(0, quota - used),
    tone: over ? "error" : percent >= 80 ? "warning" : "healthy",
  };
}

/** The quota periods the server accepts on create/update and plan_add/plan_update. */
export const QUOTA_PERIODS = ["none", "monthly"] as const;
export type QuotaPeriod = (typeof QUOTA_PERIODS)[number];

/**
 * The reset day the server will accept, or undefined to leave it alone.
 * Monthly with no stated day defaults to 1 server-side; the range is 1..28 so
 * a quota can never land on a day some months do not have.
 */
export function quotaResetDayFromInput(raw: string): number | undefined {
  const text = raw.trim();
  if (text === "") return undefined;
  const day = Number(text);
  if (!Number.isInteger(day) || day < 1 || day > 28) return undefined;
  return day;
}

export interface AllocationSummary {
  nodes: number;
  lines: number;
  /** Nodes whose collector is not reporting, so their bytes are unknown. */
  silentNodes: AllocatedNode[];
  /** Lines reached through a relay: allocated, but counted at the entry. */
  viaRelayLines: number;
  reportingNodes: number;
}

/**
 * What a user's allocated nodes add up to, and how much of it can be believed.
 *
 * The silent-node list is the point: a user allocated to four nodes where two
 * have no collector has a period figure covering two nodes, and a screen that
 * prints the figure alone is claiming the other two moved nothing.
 */
export function summarizeAllocation(nodes: readonly AllocatedNode[] | undefined): AllocationSummary {
  const list = nodes ?? [];
  const silentNodes = list.filter((node) => !collectorReports(node.collector_state));
  let lines = 0;
  let viaRelayLines = 0;
  for (const node of list) {
    for (const line of node.lines ?? []) {
      lines += 1;
      if (line.via_relay) viaRelayLines += 1;
    }
  }
  return {
    nodes: list.length,
    lines,
    silentNodes,
    viaRelayLines,
    reportingNodes: list.length - silentNodes.length,
  };
}

/**
 * The sentence a usage figure needs when some of its nodes are not reporting.
 * Empty when every allocated node reports, so the caller renders nothing.
 */
export function coverageNote(summary: AllocationSummary): string {
  if (!summary.silentNodes.length) return "";
  const names = summary.silentNodes.map((node) => node.node_name || node.node_id);
  const shown = names.slice(0, 3).join(", ");
  const rest = names.length > 3 ? ` and ${names.length - 3} more` : "";
  const verb = summary.silentNodes.length === 1 ? "is" : "are";
  return `${shown}${rest} ${verb} not reporting usage, so traffic there is unknown rather than zero.`;
}

/** Resolve a line hash against the fleet listing, for naming a row. */
export function lineNameIndex(groups: readonly LineGroup[] | undefined): Map<string, string> {
  const index = new Map<string, string>();
  for (const group of groups ?? []) {
    for (const line of group.lines) {
      const hash = line.line_hash_id?.trim();
      if (hash && !index.has(hash)) index.set(hash, line.name);
    }
  }
  return index;
}
