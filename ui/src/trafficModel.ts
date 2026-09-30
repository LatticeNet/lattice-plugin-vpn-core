/**
 * trafficModel.ts, traffic over time for the Lines and Usage layers.
 *
 * The headline figure everywhere is egress: the bytes on exit, direct and
 * shared lines (a shared line is a chain target that also serves its own
 * users), counted once at the node where they leave the fleet. That is what a
 * provider bills. A relay hub counts the same traffic again as it enters
 * (`entry`), and a middle hop counts it once more (`relay`). Those bytes are real and they are shown, but
 * never added to egress; a page that summed every role would report 568 GiB
 * for a week in which 313 GiB left.
 *
 * Two server fields feed the time axis and both are optional, because an older
 * server does not send them:
 *
 *   series    daily bytes per node and role, oldest day first
 *   previous  the equal-length window before this one, for the change figure
 *
 * Totals always come from the per-line `lines` rows, which every server sends;
 * the series only spreads them over days. The wire contract says the two agree
 * on egress, and `seriesEgressGap` lets a test hold the fixtures to it.
 */

import type { UsageLineRow } from "./usageModel";

export interface UsageSeriesRow {
  node_id: string;
  /** Omitted when the server has no name for the node. */
  node_name?: string;
  /** entry, exit, relay, direct or shared; never unknown. */
  role: string;
  /** Aligned with `UsageSeries.days`, uplink plus downlink. */
  bytes: number[];
}

export interface UsageSeries {
  /** Every UTC day in the window as yyyymmdd, oldest first, at most 90. */
  days: string[];
  rows: UsageSeriesRow[];
  /** The window was longer than 90 days and only the latest 90 are here. */
  truncated?: boolean;
}

export interface UsagePrevious {
  from: string;
  to: string;
  egress_bytes: number;
}

/** Roles whose bytes left the fleet. The contract's definition of egress. */
export const EGRESS_ROLES: ReadonlySet<string> = new Set(["exit", "direct", "shared"]);
/** Roles that count egress a second time, on the way in or in the middle. */
export const REPEAT_ROLES: ReadonlySet<string> = new Set(["entry", "relay"]);

export function isEgressRole(role: string): boolean {
  return EGRESS_ROLES.has(role);
}

function safeBytes(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value as number) : 0;
}

export interface RoleTotals {
  exit: number;
  direct: number;
  entry: number;
  relay: number;
  /** A chain target that also serves its own users; egress. */
  shared: number;
  /** Any role the contract does not name, kept visible and out of egress. */
  other: number;
  /** exit plus direct plus shared: what left the fleet. */
  egress: number;
  /** entry plus relay: the same traffic counted again on the way. */
  repeated: number;
  /** Every byte reported, overlap included. */
  total: number;
}

export function roleTotals(lines: readonly UsageLineRow[] | undefined): RoleTotals {
  const totals: RoleTotals = { exit: 0, direct: 0, entry: 0, relay: 0, shared: 0, other: 0, egress: 0, repeated: 0, total: 0 };
  for (const row of lines ?? []) {
    const bytes = safeBytes(row.used_bytes);
    totals.total += bytes;
    switch (row.role) {
      case "exit": totals.exit += bytes; break;
      case "direct": totals.direct += bytes; break;
      case "entry": totals.entry += bytes; break;
      case "relay": totals.relay += bytes; break;
      case "shared": totals.shared += bytes; break;
      default: totals.other += bytes;
    }
  }
  totals.egress = totals.exit + totals.direct + totals.shared;
  totals.repeated = totals.entry + totals.relay;
  return totals;
}

/** Bytes per line hash over every row that names the line. */
export function bytesByLine(lines: readonly UsageLineRow[] | undefined): Map<string, number> {
  const index = new Map<string, number>();
  for (const row of lines ?? []) {
    const hash = row.line_hash_id?.trim();
    if (!hash) continue;
    index.set(hash, (index.get(hash) ?? 0) + safeBytes(row.used_bytes));
  }
  return index;
}

/**
 * Bytes per line hash over the rows that left the fleet there (exit, direct,
 * shared). A relay line's entry bytes are the same traffic an exit line
 * counts again, so a sum over a relay and its exit adds these, never both.
 */
export function egressByLine(lines: readonly UsageLineRow[] | undefined): Map<string, number> {
  const index = new Map<string, number>();
  for (const row of lines ?? []) {
    const hash = row.line_hash_id?.trim();
    if (!hash || !EGRESS_ROLES.has(row.role)) continue;
    index.set(hash, (index.get(hash) ?? 0) + safeBytes(row.used_bytes));
  }
  return index;
}

export interface NodeTraffic {
  nodeID: string;
  nodeName?: string;
  egress: number;
  repeated: number;
  total: number;
}

/**
 * Per-node traffic from the line rows. This is the node total the Lines
 * overview and the By node layer print, because the legacy `by_node` field is
 * zero on every node in production and must not be read.
 */
export function trafficByNode(lines: readonly UsageLineRow[] | undefined): Map<string, NodeTraffic> {
  const nodes = new Map<string, NodeTraffic>();
  for (const row of lines ?? []) {
    const bytes = safeBytes(row.used_bytes);
    let node = nodes.get(row.node_id);
    if (!node) {
      node = { nodeID: row.node_id, nodeName: row.node_name, egress: 0, repeated: 0, total: 0 };
      nodes.set(row.node_id, node);
    }
    node.nodeName ??= row.node_name;
    node.total += bytes;
    if (EGRESS_ROLES.has(row.role)) node.egress += bytes;
    else if (REPEAT_ROLES.has(row.role)) node.repeated += bytes;
  }
  return nodes;
}

/** Whether a series is present and has at least one day to draw. */
export function hasSeries(series: UsageSeries | null | undefined): series is UsageSeries {
  return !!series && Array.isArray(series.days) && series.days.length > 0 && Array.isArray(series.rows);
}

function aligned(row: UsageSeriesRow, length: number): number[] {
  const values: number[] = [];
  for (let index = 0; index < length; index += 1) values.push(safeBytes(row.bytes?.[index]));
  return values;
}

/** Egress per day: the exit, direct and shared rows summed. */
export function egressByDay(series: UsageSeries): number[] {
  const days = series.days.length;
  const totals = new Array<number>(days).fill(0);
  for (const row of series.rows) {
    if (!EGRESS_ROLES.has(row.role)) continue;
    aligned(row, days).forEach((value, index) => { totals[index] += value; });
  }
  return totals;
}

/**
 * One node's daily bytes, for a sparkline. `roles` narrows to a set of roles
 * (egress for an exit's trend); without it every role the node reported is
 * summed, which is what the node moved. Undefined when the node has no row.
 */
export function nodeDaily(series: UsageSeries, nodeID: string, roles?: ReadonlySet<string>): number[] | undefined {
  const days = series.days.length;
  let found = false;
  const totals = new Array<number>(days).fill(0);
  for (const row of series.rows) {
    if (row.node_id !== nodeID) continue;
    if (roles && !roles.has(row.role)) continue;
    found = true;
    aligned(row, days).forEach((value, index) => { totals[index] += value; });
  }
  return found ? totals : undefined;
}

export interface StackSegment {
  key: string;
  label: string;
  values: number[];
  total: number;
}

export interface DailyStack {
  days: string[];
  /** Bottom of the stack first, which is also the legend order. */
  segments: StackSegment[];
  /** Height of each day's bar. */
  totals: number[];
  max: number;
}

function finishStack(days: string[], segments: StackSegment[]): DailyStack {
  const totals = days.map((_, index) => segments.reduce((sum, segment) => sum + segment.values[index], 0));
  return { days, segments, totals, max: totals.reduce((value, next) => Math.max(value, next), 0) };
}

/** The key the "everything else" segment carries, so no node id can collide with it. */
export const OTHERS_KEY = "\u0000others";

/**
 * Daily egress stacked by exit: the `top` largest egress nodes over the
 * window get a segment each and the rest share one. The sum of the segments
 * on a day is that day's egress, so the stack and the headline agree.
 */
export function stackByExit(series: UsageSeries, top = 5): DailyStack {
  const days = series.days.length;
  const byNode = new Map<string, StackSegment>();
  for (const row of series.rows) {
    if (!EGRESS_ROLES.has(row.role)) continue;
    let segment = byNode.get(row.node_id);
    if (!segment) {
      segment = { key: row.node_id, label: row.node_name || row.node_id, values: new Array<number>(days).fill(0), total: 0 };
      byNode.set(row.node_id, segment);
    }
    if (row.node_name && segment.label === row.node_id) segment.label = row.node_name;
    aligned(row, days).forEach((value, index) => {
      segment!.values[index] += value;
      segment!.total += value;
    });
  }
  const ranked = [...byNode.values()]
    .filter((segment) => segment.total > 0)
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  const kept = ranked.slice(0, Math.max(0, top));
  const rest = ranked.slice(kept.length);
  if (rest.length) {
    const others: StackSegment = {
      key: OTHERS_KEY,
      label: `${rest.length} other ${rest.length === 1 ? "exit" : "exits"}`,
      values: new Array<number>(days).fill(0),
      total: 0,
    };
    for (const segment of rest) {
      segment.values.forEach((value, index) => { others.values[index] += value; });
      others.total += segment.total;
    }
    kept.push(others);
  }
  return finishStack([...series.days], kept);
}

const ROLE_ORDER = ["exit", "shared", "direct", "entry", "relay"];
const ROLE_LABEL: Record<string, string> = {
  exit: "exit",
  shared: "shared exit",
  direct: "direct",
  entry: "entry at a relay hub",
  relay: "middle hop",
};

/**
 * Every byte reported, stacked by line role. Exit, shared and direct sit at
 * the bottom because they are the egress the headline counts; entry and
 * relay sit above them because they are that traffic counted again.
 */
export function stackByRole(series: UsageSeries): DailyStack {
  const days = series.days.length;
  const byRole = new Map<string, StackSegment>();
  for (const row of series.rows) {
    const role = ROLE_ORDER.includes(row.role) ? row.role : "other";
    let segment = byRole.get(role);
    if (!segment) {
      segment = { key: role, label: ROLE_LABEL[role] ?? "other roles", values: new Array<number>(days).fill(0), total: 0 };
      byRole.set(role, segment);
    }
    aligned(row, days).forEach((value, index) => {
      segment!.values[index] += value;
      segment!.total += value;
    });
  }
  const segments = [...ROLE_ORDER, "other"]
    .map((role) => byRole.get(role))
    .filter((segment): segment is StackSegment => !!segment && segment.total > 0);
  return finishStack([...series.days], segments);
}

export interface ExitRank {
  nodeID: string;
  label: string;
  egress: number;
  /** 0..1 of the period's egress. */
  share: number;
  /** Daily egress from the series; undefined without one. */
  trend?: number[];
}

/**
 * Egress nodes ranked by what left through them, from the line rows. The
 * trend comes from the series when there is one; the total never does.
 */
export function rankExits(lines: readonly UsageLineRow[] | undefined, series?: UsageSeries | null): ExitRank[] {
  const nodes = trafficByNode(lines);
  const egress = [...nodes.values()].reduce((sum, node) => sum + node.egress, 0);
  const withSeries = hasSeries(series) ? series : undefined;
  return [...nodes.values()]
    .filter((node) => node.egress > 0)
    .map((node) => ({
      nodeID: node.nodeID,
      label: node.nodeName || node.nodeID,
      egress: node.egress,
      share: egress > 0 ? node.egress / egress : 0,
      trend: withSeries ? nodeDaily(withSeries, node.nodeID, EGRESS_ROLES) : undefined,
    }))
    .sort((a, b) => b.egress - a.egress || a.label.localeCompare(b.label));
}

export interface Change {
  /** (current - previous) / previous. */
  ratio: number;
  /** "+12%", "-3%", "no change". Hyphen-minus, never a dash. */
  label: string;
  previousBytes: number;
}

/**
 * The change against the window before, or undefined when there is nothing to
 * compare with: no `previous` from the server, or a previous window that moved
 * nothing (a percentage of zero is not a number anyone can use).
 */
export function changeAgainst(current: number, previous: UsagePrevious | null | undefined): Change | undefined {
  const before = safeBytes(previous?.egress_bytes);
  if (!previous || before <= 0) return undefined;
  const ratio = (safeBytes(current) - before) / before;
  const percent = Math.round(ratio * 100);
  const label = percent === 0 ? "no change" : `${percent > 0 ? "+" : "-"}${Math.abs(percent)}%`;
  return { ratio, label, previousBytes: before };
}

export interface AttributionSummary {
  /** Distinct lines that reported traffic. */
  lines: number;
  /** Distinct lines with at least one row counted to an identity. */
  countedLines: number;
  /** Bytes on rows that carry an identity, counted or not. */
  identifiedBytes: number;
  totalBytes: number;
  /** identifiedBytes / totalBytes, 0 when nothing was reported. */
  share: number;
}

export function attributionSummary(lines: readonly UsageLineRow[] | undefined): AttributionSummary {
  const seen = new Set<string>();
  const counted = new Set<string>();
  let identifiedBytes = 0;
  let totalBytes = 0;
  for (const row of lines ?? []) {
    const bytes = safeBytes(row.used_bytes);
    totalBytes += bytes;
    if (row.user_id) identifiedBytes += bytes;
    const hash = row.line_hash_id?.trim();
    if (!hash) continue;
    seen.add(hash);
    if (row.user_id && row.counted) counted.add(hash);
  }
  return {
    lines: seen.size,
    countedLines: counted.size,
    identifiedBytes,
    totalBytes,
    share: totalBytes > 0 ? identifiedBytes / totalBytes : 0,
  };
}

/** Below this share of bytes with an identity, By user leads with the fact. */
export const ATTRIBUTION_FLOOR = 0.1;

/**
 * How far the series is from the line rows on egress, in bytes. Zero on a
 * server that honours the contract; tests hold the fixtures to it.
 */
export function seriesEgressGap(series: UsageSeries, lines: readonly UsageLineRow[] | undefined): number {
  const fromSeries = egressByDay(series).reduce((sum, value) => sum + value, 0);
  return fromSeries - roleTotals(lines).egress;
}

/** `20260923` as `09-23`, the axis label. Empty for anything else. */
export function shortDay(value: string): string {
  return /^\d{8}$/.test(value) ? `${value.slice(4, 6)}-${value.slice(6, 8)}` : "";
}

/**
 * Ticks for a byte axis: 0 and up to three round values under the maximum,
 * each a 1, 2 or 5 step of a binary unit so the labels read as "50 GiB" and
 * not "46.6 GiB".
 */
export function byteTicks(max: number): number[] {
  if (!(max > 0)) return [0];
  const units = [1, 1024, 1024 ** 2, 1024 ** 3, 1024 ** 4];
  const unit = [...units].reverse().find((value) => max >= value) ?? 1;
  const scaled = max / unit;
  const raw = scaled / 3;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((factor) => factor * magnitude).find((value) => value >= raw) ?? raw;
  const ticks: number[] = [];
  for (let value = 0; value <= scaled + 1e-9; value += step) ticks.push(value * unit);
  return ticks;
}
