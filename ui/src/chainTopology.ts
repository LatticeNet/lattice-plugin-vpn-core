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
  lineUUID: string;
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
  const sourceOrder: string[] = [];
  const graphNodes: TopologyTarget[] = [];
  const boundedUUIDs = new Set<string>();
  const boundedLimit = Math.max(0, graphLimit);
  let scannedLines = 0;
  for (const group of groups) {
    for (const line of group.lines) {
      scannedLines++;
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
      for (const target of source?.line.jump_edges ?? []) {
        scannedDiscoveryEdges++;
        const kind = declared.has(target) ? "discovered_declared" : "discovered_inferred";
        const discoveredEdge = edge(sourceUUID, target, kind, lineByUUID);
        edges.push(discoveredEdge);
        constructedDiscoveryEdges++;
        row.discoveredTargets.push({ kind, target: targetFor(target, lineByUUID) });
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

function edge(from: string, to: string, kind: TopologyEdgeKind, lines: Map<string, { line: Line; nodeName?: string }>): TopologyEdge {
  return { id: `${kind}:${from}:${to}`, from, to, kind, targetResolved: lines.has(to) };
}

/**
 * What one source row actually knows, as one of five disjoint states.
 *
 * This is the honest reading of the data the server can supply today. There is
 * no `jump_edges` producer deployed, so `discoveredTargets` is empty on every
 * real fleet, and a fleet with no planned chains has every row in "unlinked".
 * Saying that plainly beats drawing a hundred disconnected boxes.
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
