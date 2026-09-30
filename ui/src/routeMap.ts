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
  /** Relayed bytes for a node that dials out, egress for one that does not,
   *  and both summed for a hub that is also an exit (distinct traffic). */
  bytes?: number;
  /** Bytes that entered this node's relay lines and went on to another node. */
  relayed?: number;
  /** Bytes that left the fleet from this node. */
  egress?: number;
  /** What the figure on the box means; `both` shows relayed and egress. */
  measure: "relayed" | "egress" | "both" | "none";
  /** Usage was read but this node's collector did not report: unknown, not zero. */
  silent: boolean;
  hasOutgoing: boolean;
}

export interface RouteEdge extends NodeLayoutEdge {
  /** Undefined when unknown, drawn at the thinnest width but dotted. */
  bytes?: number;
  /** Usage was read, but the node the edge leaves from did not report. */
  unknown: boolean;
  width: number;
  state: RouteState;
  /**
   * Lines on the edge in each state: the relays behind it and the lines they
   * dial, because a relay onto a dead listener is a broken route too.
   */
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
  /** Nodes whose collector reported. Absent means every node is taken as reporting. */
  reportingNodes?: ReadonlySet<string>;
}

export const ROUTE_BOX_WIDTH = 330;
export const ROUTE_BOX_HEIGHT = 26;
export const ROUTE_MAX_STROKE = 12;
const ROUTE_ROW_GAP = 5;
const ROUTE_RANK_GAP = 160;
const ROUTE_PAD = 12;
/**
 * A rank past this many rows wraps into a second column. Set high on
 * purpose: an edge into a wrapped column passes under the column before it
 * and reads as a hop between two exits, which is worse than a tall map.
 */
export const ROUTE_MAX_ROWS = 40;

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
  const exitNodes = new Set(groups.filter((group) => group.lines.some((line) => lineRole(line) === "exit")).map((group) => group.node_id));
  const measureOf = (box: NodeBox): RouteBox["measure"] => {
    if (box.offFleet) return "none";
    if (!outgoing.has(box.id)) return "egress";
    return box.nodeID && exitNodes.has(box.nodeID) ? "both" : "relayed";
  };
  const silent = (nodeID: string | undefined) => !!traffic.known && !!nodeID && !!traffic.reportingNodes && !traffic.reportingNodes.has(nodeID);
  const measured = (box: NodeBox): boolean => traffic.known && !box.offFleet && !!box.nodeID && !silent(box.nodeID);
  const relayedOf = (box: NodeBox): number | undefined => (measured(box) ? traffic.byNode.get(box.nodeID!)?.repeated ?? 0 : undefined);
  const egressOf = (box: NodeBox): number | undefined => (measured(box) ? traffic.byNode.get(box.nodeID!)?.egress ?? 0 : undefined);
  const boxBytes = (box: NodeBox): number | undefined => {
    if (!measured(box)) return undefined;
    const measure = measureOf(box);
    if (measure === "relayed") return relayedOf(box);
    if (measure === "egress") return egressOf(box);
    return (relayedOf(box) ?? 0) + (egressOf(box) ?? 0);
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

  // A later hop (a relay behind a relay) sits level with what feeds it, not
  // at the top of its column, so its edge runs across instead of up the page.
  const byID = new Map(layout.nodes.map((node) => [node.id, node]));
  const ranks = [...new Set(layout.nodes.map((node) => node.rank))].sort((a, b) => a - b);
  for (const rank of ranks.slice(2)) {
    const members = layout.nodes.filter((node) => node.rank === rank);
    if (new Set(members.map((node) => node.x)).size !== 1) continue;
    const wanted = members.map((node) => {
      const sources = graph.edges.filter((edge) => edge.to === node.id).map((edge) => byID.get(edge.from)).filter((box): box is NodeLayoutBox => !!box);
      return { node, y: sources.length ? sources.reduce((sum, box) => sum + box.y, 0) / sources.length : node.y };
    }).sort((a, b) => a.y - b.y);
    let floor = ROUTE_PAD;
    for (const item of wanted) {
      item.node.y = Math.max(item.y, floor);
      floor = item.node.y + ROUTE_BOX_HEIGHT + ROUTE_ROW_GAP;
    }
  }
  for (const edge of layout.edges) {
    edge.y1 = (byID.get(edge.from)?.y ?? 0) + ROUTE_BOX_HEIGHT / 2;
    edge.y2 = (byID.get(edge.to)?.y ?? 0) + ROUTE_BOX_HEIGHT / 2;
  }
  const height = Math.max(layout.height, ...layout.nodes.map((node) => node.y + ROUTE_BOX_HEIGHT + ROUTE_PAD));

  const offFleetIDs = new Set(layout.nodes.filter((node) => node.offFleet).map((node) => node.id));
  const weighed = layout.edges.map((edge) => {
    const hashes = edge.sourceLineHashes ?? [];
    const states: Record<RouteState, number> = { healthy: 0, warning: 0, error: 0 };
    let bytes = 0;
    const involved = new Set<string>();
    for (const hash of hashes) {
      involved.add(hash);
      for (const target of lineByHash.get(hash)?.jump_edges ?? []) involved.add(target);
      bytes += traffic.byLine.get(hash) ?? 0;
    }
    for (const hash of involved) {
      const line = lineByHash.get(hash);
      if (line) states[lineStatus(line)] += 1;
    }
    const state = (Object.keys(states) as RouteState[])
      .filter((key) => states[key] > 0)
      .sort((a, b) => STATE_RANK[b] - STATE_RANK[a])[0] ?? "healthy";
    // Bytes behind a silent collector are not a measurement, so they neither
    // widen this edge nor set the scale for the others.
    const unknown = traffic.known && silent(edge.from);
    return { edge, bytes: unknown ? 0 : bytes, unknown, states, state };
  });
  const maxBytes = weighed.reduce((value, item) => Math.max(value, item.bytes), 0);
  const maxCount = weighed.reduce((value, item) => Math.max(value, item.edge.count), 0);
  const weightedBy = traffic.known && maxBytes > 0 ? "bytes" : "lines";

  const edges: RouteEdge[] = weighed.map(({ edge, bytes, unknown, states, state }) => ({
    ...edge,
    bytes: traffic.known && !unknown ? bytes : undefined,
    unknown,
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
    relayed: measureOf(node) === "egress" ? undefined : relayedOf(node),
    egress: measureOf(node) === "relayed" ? undefined : egressOf(node),
    measure: measureOf(node),
    silent: !node.offFleet && silent(node.nodeID),
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
    height,
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
