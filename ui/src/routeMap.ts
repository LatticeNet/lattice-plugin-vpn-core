/**
 * routeMap.ts, the one picture on the Lines overview.
 *
 * Relay hubs on the left, the nodes they dial on the right, one edge per node
 * pair, and a second hop further right where a target relays again. It is the
 * node-pair graph the Topology layer already derives (chainTopology.ts), laid
 * out by hop depth, with two things added that the Topology drawing does not
 * carry: each edge's stroke width is the period's bytes on the lines behind
 * it, and its colour is the worst state among those lines.
 *
 * When the usage read failed the widths fall back to line counts and the
 * caller says so; a drawing whose weights silently switched meaning would be
 * lying about the one thing it exists to show.
 */

import {
  layoutNodeGraph,
  nodePairGraph,
  normalizeChainTopology,
  type NodeBox,
  type NodeLayoutBox,
  type NodeLayoutEdge,
} from "./chainTopology";
import { lineRole } from "./fleetRows";
import type { NodeTraffic } from "./trafficModel";
import { lineStatus, type Line, type LineChain, type LineGroup } from "./vpnModel";

export type RouteState = "healthy" | "warning" | "error";

export interface RouteBox extends NodeLayoutBox {
  /** Relayed bytes for a node that dials out, egress for one that does not. */
  bytes?: number;
  /** What the figure on the box means. */
  measure: "relayed" | "egress" | "none";
  hasOutgoing: boolean;
}

export interface RouteEdge extends NodeLayoutEdge {
  bytes?: number;
  width: number;
  state: RouteState;
  /** Lines behind the edge in each state, for the accessible name. */
  states: Record<RouteState, number>;
  offFleet: boolean;
}

export interface RouteMap {
  boxes: RouteBox[];
  edges: RouteEdge[];
  width: number;
  height: number;
  /** What the stroke width encodes. */
  weightedBy: "bytes" | "lines";
  /** Nodes with egress that no relay touches, which the map does not draw. */
  directOnly: { nodes: number; bytes?: number };
}

export interface RouteTraffic {
  /** False when usage was not read or the read failed. */
  known: boolean;
  byLine: ReadonlyMap<string, number>;
  byNode: ReadonlyMap<string, NodeTraffic>;
}

export const ROUTE_BOX_WIDTH = 212;
export const ROUTE_BOX_HEIGHT = 36;
export const ROUTE_MAX_STROKE = 12;
const ROUTE_ROW_GAP = 8;
const ROUTE_RANK_GAP = 150;
const ROUTE_PAD = 12;
/** A rank past this many rows wraps into a second column. */
export const ROUTE_MAX_ROWS = 14;

const STATE_RANK: Record<RouteState, number> = { healthy: 0, warning: 1, error: 2 };

/** Stroke width for a share of the heaviest edge. Area reads as amount, so sqrt. */
export function routeStroke(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 1;
  return 1 + (ROUTE_MAX_STROKE - 1) * Math.sqrt(Math.min(1, value / max));
}

export function buildRouteMap(groups: readonly LineGroup[], chains: readonly LineChain[], traffic: RouteTraffic): RouteMap {
  const graph = nodePairGraph(groups, normalizeChainTopology(groups, chains));
  const lineByHash = new Map<string, Line>();
  for (const group of groups) for (const line of group.lines) {
    const hash = line.line_hash_id?.trim();
    if (hash && !lineByHash.has(hash)) lineByHash.set(hash, line);
  }

  const outgoing = new Set(graph.edges.map((edge) => edge.from));
  const boxBytes = (box: NodeBox): number | undefined => {
    if (!traffic.known || box.offFleet || !box.nodeID) return undefined;
    const node = traffic.byNode.get(box.nodeID);
    if (outgoing.has(box.id)) return node?.repeated ?? 0;
    return node?.egress ?? 0;
  };
  const order = (a: NodeBox, b: NodeBox): number =>
    (boxBytes(b) ?? 0) - (boxBytes(a) ?? 0) || b.lines - a.lines || a.label.localeCompare(b.label);

  const layout = layoutNodeGraph(graph, ROUTE_MAX_ROWS, {
    boxWidth: ROUTE_BOX_WIDTH,
    boxHeight: ROUTE_BOX_HEIGHT,
    rowGap: ROUTE_ROW_GAP,
    rankGap: ROUTE_RANK_GAP,
    pad: ROUTE_PAD,
    order,
  });

  const offFleetIDs = new Set(layout.nodes.filter((node) => node.offFleet).map((node) => node.id));
  const measured = layout.edges.map((edge) => {
    const hashes = edge.sourceLineHashes ?? [];
    const states: Record<RouteState, number> = { healthy: 0, warning: 0, error: 0 };
    let bytes = 0;
    for (const hash of hashes) {
      const line = lineByHash.get(hash);
      if (line) states[lineStatus(line)] += 1;
      bytes += traffic.byLine.get(hash) ?? 0;
    }
    const state = (Object.keys(states) as RouteState[])
      .filter((key) => states[key] > 0)
      .sort((a, b) => STATE_RANK[b] - STATE_RANK[a])[0] ?? "healthy";
    return { edge, bytes, states, state };
  });
  const maxBytes = measured.reduce((value, item) => Math.max(value, item.bytes), 0);
  const maxCount = measured.reduce((value, item) => Math.max(value, item.edge.count), 0);
  const weightedBy = traffic.known && maxBytes > 0 ? "bytes" : "lines";

  const edges: RouteEdge[] = measured.map(({ edge, bytes, states, state }) => ({
    ...edge,
    bytes: traffic.known ? bytes : undefined,
    width: weightedBy === "bytes" ? routeStroke(bytes, maxBytes) : routeStroke(edge.count, maxCount),
    state,
    states,
    offFleet: offFleetIDs.has(edge.to),
  }));
  // Thin edges first so the heavy ones are painted on top of them.
  edges.sort((a, b) => a.width - b.width);

  const boxes: RouteBox[] = layout.nodes.map((node) => ({
    ...node,
    bytes: boxBytes(node),
    measure: node.offFleet ? "none" : outgoing.has(node.id) ? "relayed" : "egress",
    hasOutgoing: outgoing.has(node.id),
  }));

  const drawn = new Set(layout.nodes.map((node) => node.nodeID).filter(Boolean));
  let directNodes = 0;
  let directBytes = 0;
  for (const group of groups) {
    if (!group.lines.length || drawn.has(group.node_id)) continue;
    if (!group.lines.some((line) => lineRole(line) === "exit")) continue;
    directNodes += 1;
    directBytes += traffic.byNode.get(group.node_id)?.egress ?? 0;
  }

  return {
    boxes,
    edges,
    width: layout.width,
    height: layout.height,
    weightedBy,
    directOnly: { nodes: directNodes, bytes: traffic.known ? directBytes : undefined },
  };
}

export interface RouteShape {
  /** Nodes carrying at least one relay line. */
  hubs: number;
  /** Nodes carrying at least one line that exits directly. */
  exits: number;
  relayLines: number;
  exitLines: number;
  orphanLines: number;
}

/** The second number on the Lines overview: how the fleet routes. */
export function routeShape(groups: readonly LineGroup[]): RouteShape {
  const shape: RouteShape = { hubs: 0, exits: 0, relayLines: 0, exitLines: 0, orphanLines: 0 };
  for (const group of groups) {
    let relay = false;
    let exit = false;
    for (const line of group.lines) {
      const role = lineRole(line);
      if (role === "relay") { shape.relayLines += 1; relay = true; }
      else if (role === "exit") { shape.exitLines += 1; exit = true; }
      else shape.orphanLines += 1;
    }
    if (relay) shape.hubs += 1;
    if (exit) shape.exits += 1;
  }
  return shape;
}
