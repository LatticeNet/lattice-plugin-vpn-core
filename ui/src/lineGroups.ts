/**
 * lineGroups.ts, the Lines collection: one table, grouped the way the
 * operator thinks about the fleet.
 *
 * Two rules from the layering contract drive this file:
 *
 * 1. A group row holds values at the level it belongs to. Every member column
 *    gets an aggregate on the group row (counts, a port range, a byte sum, the
 *    worst state), so no column is blank there.
 * 2. A status that is identical on every line is a fact about the fleet, not
 *    about a row. `stateSummary` finds it so the header can say it once.
 *
 * Traffic is `undefined` when it is unknown (the usage read failed, or the
 * node's collector is not reporting) and a number otherwise. A group sum over
 * members of which some are unknown is a floor and says so; it is never
 * presented as the whole.
 */

import { buildNodeRows, lineRole, type Bank, type LineRole } from "./fleetRows";
import { isRelayCandidate } from "./chainTopology";
import { formatBytes, type Line, type LineGroup } from "./vpnModel";

export type GroupBy = "node" | "bank" | "exit" | "none";
export const GROUP_BY: readonly GroupBy[] = ["node", "bank", "exit", "none"];

export function isGroupBy(value: string | null | undefined): value is GroupBy {
  return !!value && (GROUP_BY as readonly string[]).includes(value);
}

export function groupByLabel(value: GroupBy): string {
  return ({ node: "node", bank: "bank", exit: "exit", none: "none" } as const)[value];
}

export type StateTone = "healthy" | "warning" | "error" | "neutral";

export interface LineState {
  label: string;
  tone: StateTone;
  /** Ordering weight; higher is worse. */
  rank: number;
}

/**
 * One word for where a line stands, config and service together. A dead
 * service outranks a clean config, the way `lineStatus` ranks them; an
 * unreported service keeps the config verdict rather than painting the row.
 */
export function lineStateOf(line: Line): LineState {
  const service = (line.service_state ?? "").trim();
  if (service === "down") return { label: "down", tone: "error", rank: 6 };
  if (line.status === "error" || line.last_error) return { label: "config error", tone: "error", rank: 5 };
  if (service === "restarting") return { label: "restarting", tone: "warning", rank: 4 };
  if (line.status === "pending" || line.status === "stale") return { label: line.status, tone: "warning", rank: 3 };
  if (service === "running") return { label: "running", tone: "healthy", rank: 0 };
  if (line.service_note) return { label: "unproven", tone: "neutral", rank: 1 };
  return { label: "config ok", tone: "neutral", rank: 1 };
}

export interface StateSummary {
  /** The label every line shares, or undefined when they differ. */
  uniform?: string;
  /** Lines per state label, worst first. */
  counts: Array<{ label: string; tone: StateTone; count: number }>;
  configErrors: number;
}

export function stateSummary(groups: readonly LineGroup[]): StateSummary {
  const counts = new Map<string, { label: string; tone: StateTone; count: number; rank: number }>();
  let configErrors = 0;
  let lines = 0;
  for (const group of groups) for (const line of group.lines) {
    lines += 1;
    if (line.status === "error" || line.last_error) configErrors += 1;
    const state = lineStateOf(line);
    const entry = counts.get(state.label) ?? counts.set(state.label, { ...state, count: 0 }).get(state.label)!;
    entry.count += 1;
  }
  const sorted = [...counts.values()].sort((a, b) => b.rank - a.rank || b.count - a.count);
  return {
    uniform: lines > 0 && sorted.length === 1 ? sorted[0].label : undefined,
    counts: sorted.map(({ label, tone, count }) => ({ label, tone, count })),
    configErrors,
  };
}

/** What a line's traffic figure is, or undefined for "unknown, not zero". */
export interface LineTrafficIndex {
  known: boolean;
  byLine: ReadonlyMap<string, number>;
  /** The part of each line's bytes that left the fleet there. */
  egressByLine: ReadonlyMap<string, number>;
  /** Nodes whose collector reported; a silent line there moved nothing. */
  reportingNodes: ReadonlySet<string>;
}

function indexed(traffic: LineTrafficIndex | undefined, map: "byLine" | "egressByLine", line: Line): number | undefined {
  if (!traffic?.known) return undefined;
  const hash = line.line_hash_id?.trim();
  const bytes = hash ? traffic[map].get(hash) : undefined;
  if (bytes !== undefined) return bytes;
  // A line with rows elsewhere in the index moved bytes, none of them egress.
  if (map === "egressByLine" && hash && traffic.byLine.has(hash)) return 0;
  return traffic.reportingNodes.has(line.node_id) ? 0 : undefined;
}

export function lineBytes(traffic: LineTrafficIndex | undefined, line: Line): number | undefined {
  return indexed(traffic, "byLine", line);
}

/** The line's bytes that left the fleet there; undefined when unknown. */
export function lineEgress(traffic: LineTrafficIndex | undefined, line: Line): number | undefined {
  return indexed(traffic, "egressByLine", line);
}

export interface LineTarget {
  /** The node name a relay dials, `host:port` off the fleet, or a word. */
  label: string;
  kind: "node" | "off-fleet" | "direct" | "none";
  nodeID?: string;
  /** More than one resolved target. */
  more: number;
}

export interface FleetIndex {
  lineByHash: Map<string, { line: Line; group: LineGroup }>;
}

export function fleetIndex(groups: readonly LineGroup[]): FleetIndex {
  const lineByHash = new Map<string, { line: Line; group: LineGroup }>();
  for (const group of groups) for (const line of group.lines) {
    const hash = line.line_hash_id?.trim();
    if (hash && !lineByHash.has(hash)) lineByHash.set(hash, { line, group });
  }
  return { lineByHash };
}

export function lineTarget(index: FleetIndex, line: Line): LineTarget {
  const hashes = line.jump_edges ?? [];
  const resolved = hashes.map((hash) => index.lineByHash.get(hash)).filter((value): value is { line: Line; group: LineGroup } => !!value);
  if (resolved.length) {
    const first = resolved[0].group;
    return { label: first.node_name || first.node_id, kind: "node", nodeID: first.node_id, more: new Set(resolved.map((item) => item.group.node_id)).size - 1 };
  }
  if (isRelayCandidate(line)) {
    return { label: `${(line.outbound_server ?? "").trim()}:${line.outbound_port}`, kind: "off-fleet", more: 0 };
  }
  if (lineRole(line) === "orphan") return { label: "none", kind: "none", more: 0 };
  return { label: "direct", kind: "direct", more: 0 };
}

/**
 * Where traffic on this line finally leaves the fleet: follow resolved relay
 * edges to the last hop. An exit line leaves from its own node. A cycle or a
 * chain deeper than the fleet can hold stops where it is, rather than looping.
 */
export function egressOf(index: FleetIndex, group: LineGroup, line: Line): { key: string; label: string; kind: LineTarget["kind"] } {
  let currentGroup = group;
  let current = line;
  const seen = new Set<string>();
  for (let depth = 0; depth < 8; depth += 1) {
    seen.add(current.line_hash_id);
    const next = (current.jump_edges ?? []).map((hash) => index.lineByHash.get(hash)).find((value) => value && !seen.has(value.line.line_hash_id));
    if (!next) break;
    currentGroup = next.group;
    current = next.line;
  }
  if (current !== line || lineRole(current) === "exit") {
    if (!(current.jump_edges?.length) && isRelayCandidate(current)) {
      const label = `${(current.outbound_server ?? "").trim()}:${current.outbound_port}`;
      return { key: `off:${label}`, label, kind: "off-fleet" };
    }
    return { key: currentGroup.node_id, label: currentGroup.node_name || currentGroup.node_id, kind: "node" };
  }
  const target = lineTarget(index, line);
  if (target.kind === "off-fleet") return { key: `off:${target.label}`, label: target.label, kind: "off-fleet" };
  return { key: "none", label: "No outbound", kind: "none" };
}

export interface LineEntry {
  group: LineGroup;
  line: Line;
  role: LineRole;
  target: LineTarget;
  state: LineState;
  /** undefined is unknown, never zero. */
  bytes?: number;
  /** The part of `bytes` that left the fleet on this line. */
  egress?: number;
}

export interface GroupAggregate {
  lines: number;
  roles: Record<LineRole, number>;
  /** Protocols with their line counts, most common first. */
  protocols: Array<{ type: string; count: number }>;
  ports: { min: number; max: number } | undefined;
  /** Distinct fleet nodes the relays dial. */
  targetNodes: number;
  offFleet: number;
  users: { known: number; unknownLines: number };
  /** Sum over members whose traffic is known. */
  bytes: number;
  /** The part of `bytes` that left the fleet through these lines. */
  egress: number;
  /** The rest: bytes that entered at a hub or passed a middle hop, which an
   *  exit counts again when it leaves. */
  forwarded: number;
  /** Members whose traffic is unknown; the sum is a floor when non-zero. */
  unknownBytes: number;
  /** The worst state among the members, and how many lines hold it. */
  worst: LineState & { count: number };
  /** True when every member shares the worst state. */
  uniformState: boolean;
}

export interface LineGroupRow {
  key: string;
  label: string;
  sub: string;
  /** The fleet node behind the group, when there is exactly one. */
  nodeID?: string;
  entries: LineEntry[];
  agg: GroupAggregate;
}

function entryOf(index: FleetIndex, traffic: LineTrafficIndex | undefined, group: LineGroup, line: Line): LineEntry {
  return {
    group, line, role: lineRole(line), target: lineTarget(index, line), state: lineStateOf(line),
    bytes: lineBytes(traffic, line), egress: lineEgress(traffic, line),
  };
}

function byPort(a: LineEntry, b: LineEntry): number {
  return (a.line.listen_port ?? 0) - (b.line.listen_port ?? 0) || a.line.name.localeCompare(b.line.name);
}

export function aggregate(entries: readonly LineEntry[]): GroupAggregate {
  const roles: Record<LineRole, number> = { relay: 0, exit: 0, orphan: 0 };
  const protocols = new Map<string, number>();
  const targets = new Set<string>();
  let offFleet = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  let knownUsers = 0;
  let unknownUsers = 0;
  let bytes = 0;
  let egress = 0;
  let unknownBytes = 0;
  let worst: LineState | undefined;
  let worstCount = 0;
  for (const entry of entries) {
    roles[entry.role] += 1;
    const type = (entry.line.type ?? "").trim() || "unknown";
    protocols.set(type, (protocols.get(type) ?? 0) + 1);
    if (entry.target.kind === "node" && entry.target.nodeID) targets.add(entry.target.nodeID);
    if (entry.target.kind === "off-fleet") offFleet += 1;
    const port = entry.line.listen_port ?? 0;
    if (port > 0) {
      min = Math.min(min, port);
      max = Math.max(max, port);
    }
    if (entry.line.user_known) knownUsers += entry.line.user_count;
    else unknownUsers += 1;
    if (entry.bytes === undefined) unknownBytes += 1;
    else {
      bytes += entry.bytes;
      egress += Math.min(entry.egress ?? 0, entry.bytes);
    }
    if (!worst || entry.state.rank > worst.rank) {
      worst = entry.state;
      worstCount = 1;
    } else if (entry.state.label === worst.label) {
      worstCount += 1;
    }
  }
  const fallback: LineState = { label: "config ok", tone: "neutral", rank: 1 };
  return {
    lines: entries.length,
    roles,
    protocols: [...protocols].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
    ports: Number.isFinite(min) ? { min, max } : undefined,
    targetNodes: targets.size,
    offFleet,
    users: { known: knownUsers, unknownLines: unknownUsers },
    bytes,
    egress,
    forwarded: bytes - egress,
    unknownBytes,
    worst: { ...(worst ?? fallback), count: worstCount },
    uniformState: entries.length > 0 && worstCount === entries.length,
  };
}

function row(key: string, label: string, sub: string, entries: LineEntry[], nodeID?: string): LineGroupRow {
  const sorted = [...entries].sort(byPort);
  return { key, label, sub, nodeID, entries: sorted, agg: aggregate(sorted) };
}

/** Heaviest first when traffic is known, then by name, so the order is stable. */
function byTraffic(a: LineGroupRow, b: LineGroupRow): number {
  return b.agg.bytes - a.agg.bytes || a.label.localeCompare(b.label);
}

/** Exit groups rank by what left through them, not by bytes counted twice. */
function byEgress(a: LineGroupRow, b: LineGroupRow): number {
  return b.agg.egress - a.agg.egress || b.agg.bytes - a.agg.bytes || a.label.localeCompare(b.label);
}

/**
 * The traffic figure a group row shows. An exit group holds the exit line and
 * every relay line reaching it, which carry the same traffic twice, so its
 * figure is the egress alone and the relays' bytes are a note beside it. Any
 * other group sums distinct traffic, and when it holds both kinds (a hub that
 * is also an exit) the note splits the sum. A sum over members of which some
 * are unknown is a floor and says so.
 */
export function groupTraffic(agg: GroupAggregate, by: GroupBy): { figure: string; note?: string; unknown: boolean } {
  if (agg.lines > 0 && agg.unknownBytes === agg.lines) return { figure: "unknown", unknown: true };
  const floor = agg.unknownBytes ? "at least " : "";
  if (by === "exit") {
    return {
      figure: `${floor}${formatBytes(agg.egress)}`,
      note: agg.forwarded > 0 ? `left here · ${formatBytes(agg.forwarded)} entered at hubs` : "left here",
      unknown: false,
    };
  }
  return {
    figure: `${floor}${formatBytes(agg.bytes)}`,
    note: agg.egress > 0 && agg.forwarded > 0 ? `egress ${formatBytes(agg.egress)} · relayed ${formatBytes(agg.forwarded)}` : undefined,
    unknown: false,
  };
}

function bankSub(bank: Bank): string {
  const targets = bank.targetNodeIDs.length;
  const range = bank.portRange.min ? `, ports ${bank.portRange.min} to ${bank.portRange.max}` : "";
  const off = bank.offFleet ? `, ${bank.offFleet} off-fleet` : "";
  return `bank of ${bank.lines.length} ${bank.type} to ${targets} ${targets === 1 ? "node" : "nodes"}${range}${off}`;
}

/**
 * The collection, grouped. `none` returns one group holding every line, which
 * the table renders without a group row. Groups are ordered by traffic (the
 * order the overview uses), lines inside a group by port. Targets resolve
 * against `fleet` (every line), so a filtered view still names the node a
 * relay dials instead of calling it an address outside the fleet.
 */
export function groupLines(groups: readonly LineGroup[], by: GroupBy, traffic?: LineTrafficIndex, fleet: readonly LineGroup[] = groups): LineGroupRow[] {
  const index = fleetIndex(fleet);
  const names = new Map(groups.map((group) => [group.node_id, group.node_name || group.node_id]));
  const nodeName = (id: string) => names.get(id) ?? id;
  const all: LineEntry[] = groups.flatMap((group) => group.lines.map((line) => entryOf(index, traffic, group, line)));
  if (!all.length) return [];

  if (by === "none") return [row("all", "All lines", `${all.length} lines`, all)];

  if (by === "node") {
    const rows = buildNodeRows(groups).map((nodeRow) => {
      const entries = all.filter((entry) => entry.group.node_id === nodeRow.group.node_id);
      const banks = nodeRow.banks.map((bank) => `bank of ${bank.lines.length} ${bank.type} to ${bank.targetNodeIDs.length} ${bank.targetNodeIDs.length === 1 ? "node" : "nodes"}`);
      return row(nodeRow.group.node_id, nodeName(nodeRow.group.node_id), banks.join(" · "), entries, nodeRow.group.node_id);
    });
    return rows.sort(byTraffic);
  }

  if (by === "bank") {
    const banked = new Set<string>();
    const rows: LineGroupRow[] = [];
    for (const nodeRow of buildNodeRows(groups)) {
      for (const bank of nodeRow.banks) {
        const hashes = new Set(bank.lines.map((line) => line.line_hash_id));
        const entries = all.filter((entry) => entry.group.node_id === nodeRow.group.node_id && hashes.has(entry.line.line_hash_id));
        for (const entry of entries) banked.add(entry.line.line_hash_id);
        rows.push(row(bank.key, nodeName(nodeRow.group.node_id), bankSub(bank), entries, nodeRow.group.node_id));
      }
    }
    rows.sort(byTraffic);
    const rest = all.filter((entry) => !banked.has(entry.line.line_hash_id));
    if (rest.length) rows.push(row("unbanked", "Not in a bank", "lines that are not one of three or more relays of one protocol on a node", rest));
    return rows;
  }

  // by === "exit": where the traffic on each line leaves the fleet.
  const byExit = new Map<string, { label: string; kind: LineTarget["kind"]; entries: LineEntry[] }>();
  for (const entry of all) {
    const exit = egressOf(index, entry.group, entry.line);
    const bucket = byExit.get(exit.key) ?? byExit.set(exit.key, { label: exit.label, kind: exit.kind, entries: [] }).get(exit.key)!;
    bucket.entries.push(entry);
  }
  return [...byExit].map(([key, bucket]) => {
    const relays = bucket.entries.filter((entry) => entry.role === "relay");
    const hubs = new Set(relays.map((entry) => entry.group.node_id)).size;
    const sub = bucket.kind === "off-fleet"
      ? "an endpoint outside the fleet"
      : bucket.kind === "none"
        ? "lines with nowhere to send traffic"
        : relays.length
          ? `leaves here, reached by ${relays.length} relay ${relays.length === 1 ? "line" : "lines"} on ${hubs} ${hubs === 1 ? "hub" : "hubs"}`
          : "leaves here, no relay in front";
    return row(key, bucket.label, sub, bucket.entries, bucket.kind === "node" ? key : undefined);
  }).sort(byEgress);
}

/** Search results: every matching line, flat, heaviest first, with targets resolved against the whole `fleet`. */
export function flatLines(groups: readonly LineGroup[], traffic?: LineTrafficIndex, fleet: readonly LineGroup[] = groups): LineEntry[] {
  const index = fleetIndex(fleet);
  return groups
    .flatMap((group) => group.lines.map((line) => entryOf(index, traffic, group, line)))
    .sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || (a.group.node_name || a.group.node_id).localeCompare(b.group.node_name || b.group.node_id) || byPort(a, b));
}

/** "vless 12 · hysteria2 1", the protocol cell of a group row. */
export function protocolSummary(agg: GroupAggregate, limit = 2): string {
  const shown = agg.protocols.slice(0, limit).map((item) => `${item.type} ${item.count}`);
  const rest = agg.protocols.length - shown.length;
  return `${shown.join(" · ")}${rest > 0 ? ` · ${rest} more` : ""}`;
}

/** "12 relay · 1 exit", the role cell of a group row. */
export function roleSummary(agg: GroupAggregate): string {
  const parts: string[] = [];
  if (agg.roles.relay) parts.push(`${agg.roles.relay} relay`);
  if (agg.roles.exit) parts.push(`${agg.roles.exit} exit`);
  if (agg.roles.orphan) parts.push(`${agg.roles.orphan} no outbound`);
  return parts.join(" · ") || "no lines";
}

/** "7 nodes", "direct", "2 off-fleet", the target cell of a group row. */
export function targetSummary(agg: GroupAggregate): string {
  const parts: string[] = [];
  if (agg.targetNodes) parts.push(`${agg.targetNodes} ${agg.targetNodes === 1 ? "node" : "nodes"}`);
  if (agg.offFleet) parts.push(`${agg.offFleet} off-fleet`);
  if (!parts.length) return agg.roles.orphan && !agg.roles.exit ? "none" : "direct";
  return parts.join(" · ");
}
