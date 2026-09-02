import { pageRows, type Line, type LineChain, type LineChainAttempt, type LineGroup } from "./vpnModel";

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
  const { rows: slice, page, pages } = pageRows(rows, requestedPage, pageSize);
  return { rows: slice, page, pages };
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
 * The drawing's object is the node, not the line.
 *
 * On the fleet this plugin actually manages, 101 relay lines describe about
 * fifty node-to-node relationships: six hub nodes each carry an identical bank
 * of twelve outbounds onto the same seven exits. Drawn per line that is a
 * hundred boxes and a smear; drawn per node it is a picture an operator can
 * read in one look, with the line count written on each edge. The canonical
 * table below the drawing still lists every line, and selecting a box or an
 * edge narrows the table to the lines behind it.
 */
export interface NodeBox {
  /** `node_id` for a fleet node; `off:<endpoint>` for an endpoint no fleet line owns. */
  id: string;
  label: string;
  nodeID?: string;
  offFleet: boolean;
  /** Lines reported on this node; 0 for an off-fleet endpoint. */
  lines: number;
  /** Lines on this node that carry an outbound edge. */
  relays: number;
  /** Lines on this node that exit directly. */
  exits: number;
  /** Set on a cluster box: the node ids folded into it, in label order. */
  members?: string[];
}

export interface NodeEdge {
  id: string;
  from: string;
  to: string;
  /** Line-level edges this pair aggregates. */
  count: number;
  /** The strongest evidence among them; the stroke the drawing uses. */
  kind: TopologyEdgeKind;
  kinds: Partial<Record<TopologyEdgeKind, number>>;
  /** Members whose target no fleet line resolved to. */
  unresolved: number;
  /** Members matched to the target node by host alone, port unverified. */
  unverified: number;
  /** Source line uuids, so a selection can narrow the canonical table. */
  sourceLineUUIDs: string[];
}

export interface NodeGraph {
  nodes: NodeBox[];
  edges: NodeEdge[];
}

const KIND_STRENGTH: Record<TopologyEdgeKind, number> = {
  verified: 5,
  committed: 4,
  observed: 3,
  discovered_declared: 2,
  discovered_inferred: 1,
};

/**
 * Fold the line-level edges onto their nodes.
 *
 * Every edge in `topology.edges` is kept, including the ones the bounded
 * per-line graph left out: the node graph is bounded by the fleet's node
 * count, which is two orders of magnitude smaller than its line count, so it
 * does not need a cap of its own. A target no fleet line resolved to becomes
 * an off-fleet box labelled with the endpoint the source line dials, because
 * a relay onto something this control plane cannot see is a fact worth a box.
 * Nodes that touch no edge are not drawn; the fleet table already lists them.
 */
export function aggregateNodeGraph(groups: readonly LineGroup[], topology: ChainTopology): NodeGraph {
  const nodeOfUUID = new Map<string, string>();
  const nodeOfHash = new Map<string, string>();
  const lineOfUUID = new Map<string, Line>();
  const boxes = new Map<string, NodeBox>();
  for (const group of groups) {
    const box: NodeBox = {
      id: group.node_id,
      label: group.node_name || group.node_id,
      nodeID: group.node_id,
      offFleet: false,
      lines: group.lines.length,
      relays: 0,
      exits: 0,
    };
    for (const line of group.lines) {
      if (line.jump_edges?.length || isRelayCandidate(line)) box.relays += 1;
      else box.exits += 1;
      const uuid = line.line_uuid?.trim();
      if (uuid) {
        nodeOfUUID.set(uuid, group.node_id);
        lineOfUUID.set(uuid, line);
      }
      const hash = line.line_hash_id?.trim();
      if (hash) nodeOfHash.set(hash, group.node_id);
    }
    boxes.set(group.node_id, box);
  }

  const edgesByPair = new Map<string, NodeEdge>();
  const touched = new Set<string>();
  const offFleet = new Map<string, NodeBox>();
  for (const value of topology.edges) {
    if (!value.to) continue;
    const from = nodeOfUUID.get(value.from);
    if (!from) continue;
    let to = nodeOfUUID.get(value.to) ?? nodeOfHash.get(value.to);
    if (!to) {
      const source = lineOfUUID.get(value.from);
      const server = (source?.outbound_server ?? "").trim();
      const label = server ? `${server}${source?.outbound_port ? `:${source.outbound_port}` : ""}` : value.to;
      to = `off:${label}`;
      if (!offFleet.has(to)) offFleet.set(to, { id: to, label, offFleet: true, lines: 0, relays: 0, exits: 0 });
    }
    touched.add(from);
    touched.add(to);
    const key = `${from} ${to}`;
    let pair = edgesByPair.get(key);
    if (!pair) {
      pair = { id: `${from}->${to}`, from, to, count: 0, kind: value.kind, kinds: {}, unresolved: 0, unverified: 0, sourceLineUUIDs: [] };
      edgesByPair.set(key, pair);
    }
    pair.count += 1;
    pair.kinds[value.kind] = (pair.kinds[value.kind] ?? 0) + 1;
    if (KIND_STRENGTH[value.kind] > KIND_STRENGTH[pair.kind]) pair.kind = value.kind;
    if (!value.targetResolved) pair.unresolved += 1;
    if (!pair.sourceLineUUIDs.includes(value.from)) pair.sourceLineUUIDs.push(value.from);
  }

  // Relays the server could not resolve by endpoint still relay somewhere.
  // On this fleet those are the NAT exits dialed by a forwarding hostname:
  // the host matches a fleet node's public host, the port does not. Match by
  // host and say the port is unverified; a host nobody on the fleet owns is
  // an off-fleet box, because a relay onto something this control plane
  // cannot see is a fact worth a box, not a reason to draw nothing.
  const nodeOfHost = new Map<string, string>();
  for (const group of groups) {
    for (const line of group.lines) {
      for (const host of [line.public_host, line.domain]) {
        const key = (host ?? "").trim().toLowerCase();
        if (key && !nodeOfHost.has(key)) nodeOfHost.set(key, group.node_id);
      }
    }
  }
  for (const group of groups) {
    for (const line of group.lines) {
      if (line.jump_edges?.length || !isRelayCandidate(line)) continue;
      const server = (line.outbound_server ?? "").trim();
      const label = `${server}${line.outbound_port ? `:${line.outbound_port}` : ""}`;
      const byHost = nodeOfHost.get(server.toLowerCase());
      const to = byHost && byHost !== group.node_id ? byHost : `off:${label}`;
      if (!byHost && !offFleet.has(to)) offFleet.set(to, { id: to, label, offFleet: true, lines: 0, relays: 0, exits: 0 });
      touched.add(group.node_id);
      touched.add(to);
      const key = `${group.node_id} ${to}`;
      let pair = edgesByPair.get(key);
      if (!pair) {
        pair = { id: `${group.node_id}->${to}`, from: group.node_id, to, count: 0, kind: "discovered_inferred", kinds: {}, unresolved: 0, unverified: 0, sourceLineUUIDs: [] };
        edgesByPair.set(key, pair);
      }
      pair.count += 1;
      pair.kinds.discovered_inferred = (pair.kinds.discovered_inferred ?? 0) + 1;
      if (byHost) pair.unverified += 1;
      else pair.unresolved += 1;
      const uuid = line.line_uuid?.trim();
      if (uuid && !pair.sourceLineUUIDs.includes(uuid)) pair.sourceLineUUIDs.push(uuid);
    }
  }

  const nodes = [...boxes.values(), ...offFleet.values()].filter((box) => touched.has(box.id));
  return clusterHubs({ nodes, edges: [...edgesByPair.values()] });
}

/**
 * Fold hubs that relay to the same set of nodes into one box.
 *
 * Six hubs each dialing the same seven exits are forty-two edges that say one
 * thing. A cluster box says it once: "6 hubs" with the member names in its
 * title, and each edge out of it carries the summed count. A hub qualifies
 * when nothing relays into it and it has more than one target; two hubs make
 * a cluster. Everything else is left as it was.
 */
export function clusterHubs(graph: NodeGraph): NodeGraph {
  const incoming = new Set(graph.edges.map((edge) => edge.to));
  const signature = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (node.offFleet || incoming.has(node.id)) continue;
    const targets = graph.edges.filter((edge) => edge.from === node.id).map((edge) => edge.to).sort();
    if (targets.length < 2) continue;
    const key = targets.join("|");
    (signature.get(key) ?? signature.set(key, []).get(key)!).push(node.id);
  }
  const clusterOf = new Map<string, string>();
  const clusters: NodeBox[] = [];
  for (const [, members] of signature) {
    if (members.length < 2) continue;
    const boxes = members.map((id) => graph.nodes.find((node) => node.id === id)!).sort((a, b) => a.label.localeCompare(b.label));
    const id = `cluster:${boxes.map((box) => box.id).join("+")}`;
    clusters.push({
      id,
      label: `${boxes.length} hubs`,
      offFleet: false,
      lines: boxes.reduce((sum, box) => sum + box.lines, 0),
      relays: boxes.reduce((sum, box) => sum + box.relays, 0),
      exits: boxes.reduce((sum, box) => sum + box.exits, 0),
      members: boxes.map((box) => box.id),
    });
    for (const box of boxes) clusterOf.set(box.id, id);
  }
  if (!clusters.length) return graph;
  const nodes = [...graph.nodes.filter((node) => !clusterOf.has(node.id)), ...clusters];
  const merged = new Map<string, NodeEdge>();
  for (const edge of graph.edges) {
    const from = clusterOf.get(edge.from) ?? edge.from;
    const key = `${from} ${edge.to}`;
    let pair = merged.get(key);
    if (!pair) {
      pair = { ...edge, id: `${from}->${edge.to}`, from, kinds: { ...edge.kinds }, sourceLineUUIDs: [...edge.sourceLineUUIDs] };
      merged.set(key, pair);
      continue;
    }
    pair.count += edge.count;
    pair.unresolved += edge.unresolved;
    pair.unverified += edge.unverified;
    for (const [kind, count] of Object.entries(edge.kinds)) pair.kinds[kind as TopologyEdgeKind] = (pair.kinds[kind as TopologyEdgeKind] ?? 0) + (count ?? 0);
    if (KIND_STRENGTH[edge.kind] > KIND_STRENGTH[pair.kind]) pair.kind = edge.kind;
    for (const uuid of edge.sourceLineUUIDs) if (!pair.sourceLineUUIDs.includes(uuid)) pair.sourceLineUUIDs.push(uuid);
  }
  return { nodes, edges: [...merged.values()] };
}

export interface NodeLayoutBox extends NodeBox {
  rank: number;
  x: number;
  y: number;
}

export interface NodeLayoutEdge extends NodeEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface NodeLayout {
  nodes: NodeLayoutBox[];
  edges: NodeLayoutEdge[];
  width: number;
  height: number;
  ranks: number;
}

/* User-space units render close to 1:1 (the drawing is capped at its own
 * intrinsic width), so these are effectively px and the labels are sized to
 * read at this scale. A box carries a node name and a count line. */
export const NODE_BOX_WIDTH = 220;
export const NODE_BOX_HEIGHT = 44;
const ROW_GAP = 14;
const RANK_GAP = 130;
const SUBCOLUMN_GAP = 28;
const PAD = 24;
/** Rows a rank may stack before it wraps into a second column. Twelve, not
 * eight: an edge into a wrapped column crosses the column before it, so the
 * wrap is the last resort and a tall single column the normal case. Twelve
 * rows is 720 user units, one screen on the consoles this is read on. */
export const NODE_LAYOUT_MAX_ROWS = 12;

/**
 * Lay the node graph out by rank, left to right, so a relay reads as a hop.
 *
 * Rank is the longest path from a node with no inbound edge; a cycle lands in
 * one trailing rank rather than vanishing. A rank taller than `maxRows` wraps
 * into more columns instead of growing without bound. Nothing is dropped and
 * nothing is refused; `fitNodeLayout` decides how the result meets the
 * panel's width.
 */
export function layoutNodeGraph(graph: NodeGraph, maxRows = NODE_LAYOUT_MAX_ROWS): NodeLayout {
  const rows = Math.max(1, maxRows);
  const ids = new Set(graph.nodes.map((node) => node.id));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const value of graph.edges) {
    if (!ids.has(value.from) || !ids.has(value.to)) continue;
    (outgoing.get(value.from) ?? outgoing.set(value.from, []).get(value.from)!).push(value.to);
    (incoming.get(value.to) ?? incoming.set(value.to, []).get(value.to)!).push(value.from);
  }

  const rank = new Map<string, number>();
  let frontier = graph.nodes.filter((node) => !incoming.has(node.id)).map((node) => node.id);
  for (const id of frontier) rank.set(id, 0);
  for (let depth = 0; depth < graph.nodes.length && frontier.length; depth += 1) {
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
  const maxRank = graph.nodes.reduce((value, node) => Math.max(value, rank.get(node.id) ?? 0), 0);
  for (const node of graph.nodes) if (!rank.has(node.id)) rank.set(node.id, maxRank + 1);

  const perRank = new Map<number, NodeBox[]>();
  for (const node of graph.nodes) {
    const value = rank.get(node.id) ?? 0;
    (perRank.get(value) ?? perRank.set(value, []).get(value)!).push(node);
  }
  const ranks = [...perRank.keys()].sort((a, b) => a - b);
  const placed: NodeLayoutBox[] = [];
  let x = PAD;
  let tallest = 1;
  for (const value of ranks) {
    const members = [...(perRank.get(value) ?? [])].sort((a, b) => a.label.localeCompare(b.label));
    const columns = Math.max(1, Math.ceil(members.length / rows));
    tallest = Math.max(tallest, Math.min(rows, members.length));
    members.forEach((node, index) => {
      const column = Math.floor(index / rows);
      const row = index % rows;
      placed.push({
        ...node,
        rank: value,
        x: x + column * (NODE_BOX_WIDTH + SUBCOLUMN_GAP),
        y: PAD + row * (NODE_BOX_HEIGHT + ROW_GAP),
      });
    });
    x += columns * NODE_BOX_WIDTH + (columns - 1) * SUBCOLUMN_GAP + RANK_GAP;
  }
  const width = ranks.length ? x - RANK_GAP + PAD : PAD * 2;
  const height = PAD * 2 + tallest * NODE_BOX_HEIGHT + (tallest - 1) * ROW_GAP;

  const byID = new Map(placed.map((node) => [node.id, node]));
  const edges: NodeLayoutEdge[] = [];
  for (const value of graph.edges) {
    const from = byID.get(value.from);
    const to = byID.get(value.to);
    if (!from || !to) continue;
    const half = NODE_BOX_HEIGHT / 2;
    edges.push({
      ...value,
      x1: from.x + NODE_BOX_WIDTH,
      y1: from.y + half,
      x2: to.x,
      y2: to.y + half,
    });
  }
  return { nodes: placed, edges, width, height, ranks: ranks.length };
}

/**
 * How a layout meets the width it has.
 *
 * A drawing wider than the panel scales down, but never below `GRAPH_MIN_SCALE`:
 * at three quarters a 12px label is 9px and still reads, at a fifth it is a
 * smear that looks like an answer. Past that floor the panel scrolls sideways
 * at the floor scale, which is the one nested scroll this page keeps, because
 * a figure is not a list and a horizontal scroll never fights the document's
 * vertical one.
 */
export const GRAPH_MIN_SCALE = 0.75;

export interface NodeLayoutFit {
  scale: number;
  /** True when the drawing is still wider than the panel at the floor scale. */
  overflow: boolean;
  renderWidth: number;
  renderHeight: number;
}

export function fitNodeLayout(layout: NodeLayout, availableWidth: number): NodeLayoutFit {
  const budget = Math.max(0, availableWidth);
  const scale = layout.width <= budget || budget === 0 ? 1 : Math.max(GRAPH_MIN_SCALE, budget / layout.width);
  const renderWidth = Math.round(layout.width * scale);
  return { scale, overflow: renderWidth > budget && budget > 0, renderWidth, renderHeight: Math.round(layout.height * scale) };
}

/**
 * Why the drawing is empty, decided from data the panel already holds.
 *
 * The server derives relay edges from each line's own outbound (host, port)
 * and from a sidecar-declared downstream, so "no edges" has distinct causes
 * that the operator can act on differently, and the line records say which
 * one applies. Nothing here invents an edge: an unmatched upstream is reported
 * as an unmatched upstream.
 */
export type TopologyAbsenceReason =
  /** Edges exist and are drawn. */
  | "drawn"
  /** No line carries a line_uuid, so nothing can be an end of a chain. */
  | "no_identity"
  /** No line routes through anything: every outbound on the fleet is direct. */
  | "no_relay"
  /** Lines relay, but every upstream they name is outside this control plane. */
  | "upstream_off_fleet";

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
  drawnEdges: number,
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
  if (drawnEdges > 0) return absence("drawn");
  if (!topology.rows.length) return absence("no_identity");
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
