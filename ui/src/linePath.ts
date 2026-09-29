/**
 * linePath.ts, the chain one line belongs to, as a path of hops.
 *
 * The line panel draws this instead of a list of relay target hashes: where
 * traffic enters, every hop it crosses, and where it leaves, each with its
 * state. A line that many relays dial into (an exit behind six hubs) gets one
 * entry hop that says how many lines on how many nodes feed it, because the
 * fan-in is the fact and forty-two separate boxes would hide it.
 */

import { isRelayCandidate } from "./chainTopology";
import { fleetIndex, lineStateOf, type LineState } from "./lineGroups";
import type { Line, LineGroup } from "./vpnModel";

export type HopRole = "entry" | "relay" | "exit" | "off-fleet";

export interface PathHop {
  key: string;
  role: HopRole;
  nodeName: string;
  nodeID?: string;
  lineName?: string;
  lineHashID?: string;
  state?: LineState;
  /** The line the panel is about. */
  current: boolean;
  /** Set on an entry hop that stands for several upstream lines. */
  fanIn?: { lines: number; nodes: number };
}

const MAX_HOPS = 8;

export function chainPath(groups: readonly LineGroup[], line: Line): PathHop[] {
  const index = fleetIndex(groups);
  const nodeName = (id: string) => {
    const group = groups.find((value) => value.node_id === id);
    return group?.node_name || id;
  };

  const hops: PathHop[] = [];
  const upstream = groups.flatMap((group) => group.lines
    .filter((candidate) => candidate.line_hash_id !== line.line_hash_id && (candidate.jump_edges ?? []).includes(line.line_hash_id))
    .map((candidate) => ({ group, line: candidate })));
  if (upstream.length) {
    const nodes = [...new Set(upstream.map((item) => item.group.node_id))];
    const worst = upstream.map((item) => lineStateOf(item.line)).sort((a, b) => b.rank - a.rank)[0];
    const single = upstream.length === 1 ? upstream[0] : undefined;
    hops.push({
      key: "upstream",
      role: "entry",
      nodeName: nodes.length === 1 ? nodeName(nodes[0]) : `${nodes.length} nodes`,
      nodeID: nodes.length === 1 ? nodes[0] : undefined,
      lineName: single ? single.line.name : `${upstream.length} lines`,
      lineHashID: single?.line.line_hash_id,
      state: worst,
      current: false,
      fanIn: single ? undefined : { lines: upstream.length, nodes: nodes.length },
    });
  }

  const seen = new Set<string>();
  let current: { line: Line; nodeID: string } | undefined = { line, nodeID: line.node_id };
  const chain: PathHop[] = [];
  while (current && chain.length < MAX_HOPS) {
    seen.add(current.line.line_hash_id);
    chain.push({
      key: current.line.line_hash_id,
      role: "relay",
      nodeName: nodeName(current.nodeID),
      nodeID: current.nodeID,
      lineName: current.line.name,
      lineHashID: current.line.line_hash_id,
      state: lineStateOf(current.line),
      current: current.line === line,
    });
    const next: { line: Line; group: LineGroup } | undefined = (current.line.jump_edges ?? [])
      .map((hash) => index.lineByHash.get(hash))
      .find((value) => !!value && !seen.has(value.line.line_hash_id));
    if (next) {
      current = { line: next.line, nodeID: next.group.node_id };
      continue;
    }
    if (!(current.line.jump_edges?.length) && isRelayCandidate(current.line)) {
      chain.push({
        key: `off:${current.line.outbound_server}:${current.line.outbound_port}`,
        role: "off-fleet",
        nodeName: `${(current.line.outbound_server ?? "").trim()}:${current.line.outbound_port}`,
        current: false,
      });
    }
    current = undefined;
  }

  // The last fleet hop is where traffic leaves; the first, with nothing in
  // front of it, is where it enters. Everything between relays.
  const last = chain[chain.length - 1];
  if (last && last.role !== "off-fleet") last.role = "exit";
  if (!upstream.length && chain.length > 1 && chain[0].role === "relay") chain[0].role = "entry";
  return [...hops, ...chain];
}

export function hopRoleLabel(role: HopRole): string {
  return ({ entry: "entry", relay: "relay", exit: "exit", "off-fleet": "off-fleet" } as const)[role];
}
