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
}

export function normalizeChainTopology(groups: readonly LineGroup[], chains: readonly LineChain[], graphLimit = GRAPH_NODE_LIMIT): ChainTopology {
  const lineByUUID = new Map<string, { line: Line; nodeName?: string }>();
  for (const group of groups) {
    for (const line of group.lines) {
      const uuid = line.line_uuid?.trim();
      if (uuid && !lineByUUID.has(uuid)) lineByUUID.set(uuid, { line, nodeName: group.node_name });
    }
  }
  const chainBySource = new Map(chains.map((value) => [value.source_line_uuid, value]));
  const sources = new Set([...lineByUUID.keys(), ...chainBySource.keys()]);
  const rows: TopologyRow[] = [];
  const edges: TopologyEdge[] = [];

  for (const sourceUUID of [...sources].sort()) {
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
      } else {
        if (currentUUID) edges.push(edge(sourceUUID, currentUUID, "committed", lineByUUID));
        if (observedUUID) edges.push(edge(sourceUUID, observedUUID, "observed", lineByUUID));
      }
    } else {
      const declared = new Set(source?.line.declared_jump_edges ?? []);
      for (const target of source?.line.jump_edges ?? []) {
        edges.push(edge(sourceUUID, target, declared.has(target) ? "discovered_declared" : "discovered_inferred", lineByUUID));
      }
    }
    rows.push(row);
  }

  const allNodes = [...lineByUUID.keys()].sort().map((uuid) => targetFor(uuid, lineByUUID));
  const boundedNodes = allNodes.slice(0, Math.max(0, graphLimit));
  const boundedUUIDs = new Set(boundedNodes.map((node) => node.lineUUID));
  return {
    rows,
    edges,
    graph: {
      nodes: boundedNodes,
      edges: edges.filter((value) => boundedUUIDs.has(value.from) && !!value.to && boundedUUIDs.has(value.to) && value.targetResolved),
      truncated: allNodes.length > boundedNodes.length,
      totalNodes: allNodes.length,
    },
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
