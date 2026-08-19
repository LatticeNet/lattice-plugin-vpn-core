import type { Line, LineChain, LineChainAttempt, LineGroup } from "./vpnModel";

export const GRAPH_NODE_LIMIT = 100;
export const TABLE_PAGE_SIZE = 100;

export type TopologyEdgeKind =
  | "verified"
  | "committed"
  | "observed"
  | "discovered_declared"
  | "discovered_inferred";

export interface TopologyTarget {
  /**
   * Control-plane identity. Empty when the edge names a line the fleet knows by
   * `line_hash_id` alone, which happens while a rediscovered line is still
   * waiting for its `line_uuid` allocation.
   */
  lineUUID: string;
  /** Set when the edge came from discovery, which addresses lines by hash. */
  lineHashID?: string;
  label: string;
  nodeID?: string;
  resolved: boolean;
}

export interface TopologyProposal {
  operation: LineChainAttempt["operation"];
  targetLineUUID?: string;
  approvalID: string;
  status: LineChainAttempt["status"];
  errorCode?: string;
  error?: string;
  isEdge: false;
}

export interface TopologyRow {
  sourceLineUUID: string;
  sourceLabel: string;
  sourceNodeID?: string;
  status: string;
  currentTarget?: TopologyTarget;
  removalTombstone: boolean;
  proposal?: TopologyProposal;
  observedTargetUUID?: string;
  observedTarget?: TopologyTarget;
  discoveredTargets: Array<{ kind: "discovered_declared" | "discovered_inferred"; target: TopologyTarget }>;
  lastError?: string;
  chain: LineChain | null;
}

export interface TopologyEdge {
  id: string;
  from: string;
  to?: string;
  kind: TopologyEdgeKind;
  targetResolved: boolean;
}

export interface TopologyGraph {
  nodes: TopologyTarget[];
  edges: TopologyEdge[];
  truncated: boolean;
  totalNodes: number;
}

export interface ChainTopology {
  rows: TopologyRow[];
  edges: TopologyEdge[];
  graph: TopologyGraph;
  work: { scannedLines: number; scannedChains: number; scannedDiscoveryEdges: number };
}

export interface ChainTopologyWorkCounters {
  scannedLines: number;
  scannedChains: number;
  scannedDeclaredEdges: number;
  scannedDiscoveryEdges: number;
  scannedRowSources: number;
  constructedAuthoritativeEdges: number;
  constructedDiscoveryEdges: number;
  filteredGraphEdges: number;
}

export function normalizeChainTopology(
  groups: readonly LineGroup[],
  chains: readonly LineChain[],
  graphLimit = GRAPH_NODE_LIMIT,
  workCounters?: ChainTopologyWorkCounters,
): ChainTopology {
  const lineByUUID = new Map<string, { line: Line; nodeName?: string }>();
  /**
   * The second identifier domain. `jump_edges` and `declared_jump_edges` name
   * their target by `line_hash_id`, not by `line_uuid`: see the server's Line
   * struct, "line_hash_ids this line relays to". Chains name their target by
   * `line_uuid`. Resolving a discovery edge through the uuid map silently
   * yields nothing, which is how a fleet with real relay structure can report
   * zero edges.
   */
  const lineByHash = new Map<string, { line: Line; nodeName?: string }>();
  const sourceOrder: string[] = [];
  const graphNodes: TopologyTarget[] = [];
  const boundedUUIDs = new Set<string>();
  const boundedLimit = Math.max(0, graphLimit);
  let scannedLines = 0;
  for (const group of groups) {
    for (const line of group.lines) {
      scannedLines++;
      const hash = line.line_hash_id?.trim();
      if (hash && !lineByHash.has(hash)) lineByHash.set(hash, { line, nodeName: group.node_name });
      const uuid = line.line_uuid?.trim();
      if (uuid && !lineByUUID.has(uuid)) {
        lineByUUID.set(uuid, { line, nodeName: group.node_name });
        sourceOrder.push(uuid);
        if (graphNodes.length < boundedLimit) {
          graphNodes.push({ lineUUID: uuid, label: line.name || uuid, nodeID: line.node_id, resolved: true });
          boundedUUIDs.add(uuid);
        }
      }
    }
  }
  const chainBySource = new Map<string, LineChain>();
  let scannedChains = 0;
  for (const chain of chains) {
    scannedChains++;
    if (!chainBySource.has(chain.source_line_uuid)) {
      chainBySource.set(chain.source_line_uuid, chain);
      if (!lineByUUID.has(chain.source_line_uuid)) sourceOrder.push(chain.source_line_uuid);
    }
  }
  const rows: TopologyRow[] = [];
  const edges: TopologyEdge[] = [];
  let scannedDeclaredEdges = 0;
  let scannedDiscoveryEdges = 0;
  let scannedRowSources = 0;
  let constructedAuthoritativeEdges = 0;
  let constructedDiscoveryEdges = 0;

  for (const sourceUUID of sourceOrder) {
    scannedRowSources++;
    const source = lineByUUID.get(sourceUUID);
    const currentChain = chainBySource.get(sourceUUID) ?? null;
    const row: TopologyRow = {
      sourceLineUUID: sourceUUID,
      sourceLabel: source?.line.name || sourceUUID,
      sourceNodeID: currentChain?.source_node_id || source?.line.node_id,
      status: currentChain?.status || source?.line.status || "discovered",
      removalTombstone: currentChain?.current != null && !currentChain.current.target_line_uuid,
      proposal: currentChain?.attempt ? {
        operation: currentChain.attempt.operation,
        targetLineUUID: currentChain.attempt.candidate_target_line_uuid,
        approvalID: currentChain.attempt.approval_id,
        status: currentChain.attempt.status,
        errorCode: currentChain.attempt.error_code,
        error: currentChain.attempt.error,
        isEdge: false,
      } : undefined,
      observedTargetUUID: currentChain?.observed_downstream_line_uuid,
      discoveredTargets: [],
      lastError: currentChain?.last_error || currentChain?.attempt?.error,
      chain: currentChain,
    };

    const currentUUID = currentChain?.current?.target_line_uuid;
    const observedUUID = currentChain?.observed_downstream_line_uuid;
    if (currentUUID) row.currentTarget = targetFor(currentUUID, lineByUUID);
    if (observedUUID) row.observedTarget = targetFor(observedUUID, lineByUUID);

    if (currentChain) {
      if (currentChain.status === "converged" && currentUUID && observedUUID === currentUUID) {
        edges.push(edge(sourceUUID, currentUUID, "verified", lineByUUID));
        constructedAuthoritativeEdges++;
      } else {
        if (currentUUID) {
          edges.push(edge(sourceUUID, currentUUID, "committed", lineByUUID));
          constructedAuthoritativeEdges++;
        }
        if (observedUUID) {
          edges.push(edge(sourceUUID, observedUUID, "observed", lineByUUID));
          constructedAuthoritativeEdges++;
        }
      }
    } else {
      const declared = new Set<string>();
      for (const target of source?.line.declared_jump_edges ?? []) {
        scannedDeclaredEdges++;
        declared.add(target);
      }
      for (const hash of source?.line.jump_edges ?? []) {
        scannedDiscoveryEdges++;
        const kind = declared.has(hash) ? "discovered_declared" : "discovered_inferred";
        const target = discoveredTargetFor(hash, lineByHash);
        edges.push({
          id: `${kind}:${sourceUUID}:${hash}`,
          from: sourceUUID,
          // The drawing is keyed by line_uuid, so an edge onto a line that has
          // no uuid yet stays out of it and is named in the table instead.
          to: target.lineUUID || hash,
          kind,
          targetResolved: target.resolved,
        });
        constructedDiscoveryEdges++;
        row.discoveredTargets.push({ kind, target });
      }
    }
    rows.push(row);
  }

  const graphEdges: TopologyEdge[] = [];
  let filteredGraphEdges = 0;
  for (const value of edges) {
    filteredGraphEdges++;
    if (boundedUUIDs.has(value.from) && !!value.to && boundedUUIDs.has(value.to) && value.targetResolved) {
      graphEdges.push(value);
    }
  }

  if (workCounters) {
    Object.assign(workCounters, {
      scannedLines,
      scannedChains,
      scannedDeclaredEdges,
      scannedDiscoveryEdges,
      scannedRowSources,
      constructedAuthoritativeEdges,
      constructedDiscoveryEdges,
      filteredGraphEdges,
    });
  }

  return {
    rows,
    edges,
    graph: {
      nodes: graphNodes,
      edges: graphEdges,
      truncated: lineByUUID.size > graphNodes.length,
      totalNodes: lineByUUID.size,
    },
    work: { scannedLines, scannedChains, scannedDiscoveryEdges },
  };
}

export function pageTopologyRows(rows: readonly TopologyRow[], requestedPage: number, pageSize = TABLE_PAGE_SIZE): { rows: TopologyRow[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(Math.max(1, Math.trunc(requestedPage) || 1), pages);
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), page, pages };
}

function targetFor(uuid: string, lines: Map<string, { line: Line; nodeName?: string }>): TopologyTarget {
  const found = lines.get(uuid);
  return {
    lineUUID: uuid,
    label: found?.line.name || uuid,
    nodeID: found?.line.node_id,
    resolved: !!found,
  };
}

/**
 * Resolve one discovery edge target, which is addressed by `line_hash_id`.
 *
 * A hit names the real line and carries its `line_uuid` across so the drawing
 * and the chain edges share one identifier domain. A miss keeps the hash
 * visible rather than inventing a label, because an edge onto a line this
 * control plane cannot see is a fact worth showing, not one worth hiding.
 */
function discoveredTargetFor(hash: string, byHash: Map<string, { line: Line; nodeName?: string }>): TopologyTarget {
  const found = byHash.get(hash);
  if (!found) return { lineUUID: "", lineHashID: hash, label: hash, resolved: false };
  return {
    lineUUID: found.line.line_uuid?.trim() ?? "",
    lineHashID: hash,
    label: found.line.name || hash,
    nodeID: found.line.node_id,
    resolved: true,
  };
}

function edge(from: string, to: string, kind: TopologyEdgeKind, lines: Map<string, { line: Line; nodeName?: string }>): TopologyEdge {
  return { id: `${kind}:${from}:${to}`, from, to, kind, targetResolved: lines.has(to) };
}

/**
 * What one source row actually knows, as one of five disjoint states.
 *
 * "discovered" is reachable without anyone approving anything: the server
 * resolves relay edges fleet-wide from the committed configuration each line
 * reports, so a line whose outbound lands on another line's endpoint arrives
 * here already carrying `jump_edges`. "unlinked" therefore means the fleet
 * really has no relationship to show for that line, not that the evidence is
 * merely unread.
 */
export type RowEvidence = "attention" | "proposed" | "linked" | "discovered" | "unlinked";

export function rowEvidence(row: TopologyRow): RowEvidence {
  if (row.lastError || row.status === "failed" || row.status === "drifted") return "attention";
  if (row.proposal) return "proposed";
  if (row.currentTarget || row.observedTarget || row.removalTombstone) return "linked";
  if (row.discoveredTargets.length) return "discovered";
  return "unlinked";
}

export interface TopologySummary {
  sources: number;
  attention: number;
  proposed: number;
  linked: number;
  discovered: number;
  unlinked: number;
  edges: number;
}

export function summarizeTopology(topology: ChainTopology): TopologySummary {
  const summary: TopologySummary = {
    sources: topology.rows.length,
    attention: 0,
    proposed: 0,
    linked: 0,
    discovered: 0,
    unlinked: 0,
    edges: topology.edges.length,
  };
  for (const row of topology.rows) summary[rowEvidence(row)] += 1;
  return summary;
}

export function filterTopologyRows(rows: readonly TopologyRow[], filter: RowEvidence | "all"): TopologyRow[] {
  if (filter === "all") return [...rows];
  return rows.filter((row) => rowEvidence(row) === filter);
}

/**
 * The part of the bounded graph that is actually a graph.
 *
 * `normalizeChainTopology` bounds the node set so a 10k-line fleet cannot melt
 * the browser, but a node with no edge carries no topology: rendering it draws
 * a label that the canonical table already prints, in nine truncated
 * characters. Only nodes that participate in an edge are drawn.
 */
export function connectedSubgraph(graph: TopologyGraph): { nodes: TopologyTarget[]; edges: TopologyEdge[] } {
  const touched = new Set<string>();
  for (const value of graph.edges) {
    touched.add(value.from);
    if (value.to) touched.add(value.to);
  }
  return { nodes: graph.nodes.filter((node) => touched.has(node.lineUUID)), edges: [...graph.edges] };
}

export interface GraphLayoutNode extends TopologyTarget {
  rank: number;
  x: number;
  y: number;
}

export interface GraphLayout {
  nodes: GraphLayoutNode[];
  edges: Array<TopologyEdge & { x1: number; y1: number; x2: number; y2: number }>;
  width: number;
  height: number;
  dropped: number;
}

/* User-space units are rendered close to 1:1 (the drawing is capped at its own
 * intrinsic width so a small graph is not blown up), so these are effectively
 * px and the labels have to be legible at this size. */
const RANK_WIDTH = 300;
const ROW_HEIGHT = 54;
const PAD_X = 112;
const PAD_Y = 32;
/** Half the node box width; edges stop at the box edge rather than its centre. */
export const NODE_HALF_WIDTH = 100;

/**
 * Lay a chain graph out left to right by rank, so a chain reads as a chain.
 *
 * Rank is the longest path from a source with no inbound edge. Anything left
 * unranked is part of a cycle and lands in one trailing column rather than
 * being dropped silently. `maxNodes` bounds the drawing; the caller reports
 * `dropped` rather than pretending the picture is complete.
 */
export function layoutChainGraph(
  nodes: readonly TopologyTarget[],
  edges: readonly TopologyEdge[],
  maxNodes = 60,
): GraphLayout {
  const kept = nodes.slice(0, Math.max(0, maxNodes));
  const keptIDs = new Set(kept.map((node) => node.lineUUID));
  const keptEdges = edges.filter((value) => keptIDs.has(value.from) && !!value.to && keptIDs.has(value.to));

  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const value of keptEdges) {
    if (!value.to) continue;
    (outgoing.get(value.from) ?? outgoing.set(value.from, []).get(value.from)!).push(value.to);
    (incoming.get(value.to) ?? incoming.set(value.to, []).get(value.to)!).push(value.from);
  }

  const rank = new Map<string, number>();
  let frontier = kept.filter((node) => !incoming.has(node.lineUUID)).map((node) => node.lineUUID);
  for (const id of frontier) rank.set(id, 0);
  // Bounded by the node count: a longer walk means a cycle, handled below.
  for (let depth = 0; depth < kept.length && frontier.length; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const target of outgoing.get(id) ?? []) {
        const candidate = (rank.get(id) ?? 0) + 1;
        if ((rank.get(target) ?? -1) < candidate) {
          rank.set(target, candidate);
          next.push(target);
        }
      }
    }
    frontier = next;
  }
  const maxRank = kept.reduce((value, node) => Math.max(value, rank.get(node.lineUUID) ?? 0), 0);
  for (const node of kept) if (!rank.has(node.lineUUID)) rank.set(node.lineUUID, maxRank + 1);

  const perRank = new Map<number, number>();
  const placed: GraphLayoutNode[] = kept.map((node) => {
    const nodeRank = rank.get(node.lineUUID) ?? 0;
    const index = perRank.get(nodeRank) ?? 0;
    perRank.set(nodeRank, index + 1);
    return { ...node, rank: nodeRank, x: PAD_X + nodeRank * RANK_WIDTH, y: PAD_Y + index * ROW_HEIGHT };
  });
  const byID = new Map(placed.map((node) => [node.lineUUID, node]));

  const columns = Math.max(...placed.map((node) => node.rank), 0) + 1;
  const tallest = Math.max(...[...perRank.values()], 1);
  return {
    nodes: placed,
    edges: keptEdges.map((value) => {
      const from = byID.get(value.from)!;
      const to = byID.get(value.to!)!;
      return { ...value, x1: from.x + NODE_HALF_WIDTH, y1: from.y, x2: to.x - NODE_HALF_WIDTH, y2: to.y };
    }),
    width: PAD_X * 2 + (columns - 1) * RANK_WIDTH,
    height: PAD_Y * 2 + (tallest - 1) * ROW_HEIGHT,
    dropped: Math.max(0, nodes.length - kept.length),
  };
}

/**
 * Why the drawing is empty, decided from data the panel already holds.
 *
 * Six zeroes and a paragraph of guesswork is the failure this replaces. The
 * server derives relay edges from each line's own outbound (host, port) and
 * from a sidecar-declared downstream, so "no edges" has distinct causes that
 * the operator can act on differently, and the line records say which one
 * applies. Nothing here invents an edge: an unmatched upstream is reported as
 * an unmatched upstream.
 */
export type TopologyAbsenceReason =
  /** Edges exist and at least one is drawn. */
  | "drawn"
  /** No line carries a line_uuid, so nothing can be an end of a chain. */
  | "no_identity"
  /** No line routes through anything: every outbound on the fleet is direct. */
  | "no_relay"
  /** Lines relay, but every upstream they name is outside this control plane. */
  | "upstream_off_fleet"
  /** Edges exist, and every one of them falls outside the drawing bound. */
  | "beyond_cap"
  /** Edges exist and would draw, but not at a size anyone can read. */
  | "too_dense";

export interface TopologyAbsence {
  reason: TopologyAbsenceReason;
  /** Lines whose outbound names a real upstream rather than routing direct. */
  relayCandidates: number;
  /** Distinct host:port upstreams that matched no line on this fleet. */
  unmatchedUpstreams: string[];
}

export const UNMATCHED_UPSTREAM_SAMPLE = 6;

/** True when this line routes through a named upstream rather than exiting directly. */
export function isRelayCandidate(line: Line): boolean {
  const ref = (line.outbound_ref ?? "").trim().toLowerCase();
  if (!ref || ref === "direct") return false;
  return !!(line.outbound_server ?? "").trim() && (line.outbound_port ?? 0) > 0;
}

export function diagnoseTopologyAbsence(
  groups: readonly LineGroup[],
  topology: ChainTopology,
  drawing: { edges: number; legible: boolean },
): TopologyAbsence {
  const upstreams = new Set<string>();
  let relayCandidates = 0;
  for (const group of groups) {
    for (const line of group.lines) {
      if (!isRelayCandidate(line)) continue;
      relayCandidates += 1;
      if (line.jump_edges?.length) continue;
      upstreams.add(`${(line.outbound_server ?? "").trim()}:${line.outbound_port}`);
    }
  }
  const unmatchedUpstreams = [...upstreams].sort().slice(0, UNMATCHED_UPSTREAM_SAMPLE);
  const absence = (reason: TopologyAbsenceReason): TopologyAbsence => ({ reason, relayCandidates, unmatchedUpstreams });
  if (drawing.edges > 0) return absence(drawing.legible ? "drawn" : "too_dense");
  if (!topology.rows.length) return absence("no_identity");
  if (topology.edges.length > 0) return absence("beyond_cap");
  if (relayCandidates === 0) return absence("no_relay");
  return absence("upstream_off_fleet");
}

/**
 * Why one line cannot be the target of a chain, in the server's own order.
 *
 * The server compiles a VLESS+REALITY outbound onto the target, which needs the
 * target's private descriptor: its Reality public key, short id, and the bound
 * account's credential. It only holds those for a line it rolled out itself, so
 * "the target must be Lattice-managed" is a real constraint and not a UI habit.
 * Mirroring the full precondition here stops the picker offering a target the
 * plan call will refuse. Keep this in step with compileLineChainSnapshot in
 * lattice-server internal/server/server_linechain.go.
 */
/**
 * Whether the drawing can be rendered at a size anyone can read.
 *
 * `.topology-graph` in styles.css is `width: 100%; height: auto; max-height:
 * 420px` over a viewBox, so a drawing larger than its box is scaled down
 * uniformly rather than clipped. A 62-rank relay graph is 18524 by 2602 user
 * units, which lands at about seven percent scale: 12px labels under a pixel
 * tall, and every edge a smear. That is worse than no picture, because it
 * looks like an answer.
 *
 * So the drawing is rendered only at 1:1 or smaller, and the canonical table
 * carries the topology otherwise, which is what this panel has always said it
 * is for. `availableWidth` is the shell's measured inner width; the fallback
 * is a conservative desktop value for callers that cannot measure.
 */
export const GRAPH_LEGIBLE_HEIGHT = 420;
export const GRAPH_ASSUMED_WIDTH = 1000;

export function isGraphLegible(layout: GraphLayout, availableWidth = GRAPH_ASSUMED_WIDTH): boolean {
  return layout.nodes.length > 0
    && layout.width <= availableWidth
    && layout.height <= GRAPH_LEGIBLE_HEIGHT;
}

export type ChainTargetRejection =
  | "no_identity"
  | "same_node"
  | "not_reality_vless"
  | "not_managed_overlay";

export function chainTargetRejection(line: Line, sourceNodeID?: string): ChainTargetRejection | null {
  if (!line.line_uuid?.trim()) return "no_identity";
  if (sourceNodeID && line.node_id === sourceNodeID) return "same_node";
  if (line.core !== "sing-box" || line.type !== "vless" || line.security !== "reality" || line.transport !== "tcp") {
    return "not_reality_vless";
  }
  if (!line.overlay || line.overlay_status !== "applied" || line.status !== "ok") return "not_managed_overlay";
  return null;
}

/** Adjective phrases, so they read correctly after any count. */
export const CHAIN_TARGET_REJECTION_TEXT: Record<ChainTargetRejection, string> = {
  no_identity: "without a line_uuid",
  same_node: "on the source node",
  not_reality_vless: "not sing-box VLESS+REALITY+TCP",
  not_managed_overlay: "not rolled out by Lattice and reporting healthy",
};
