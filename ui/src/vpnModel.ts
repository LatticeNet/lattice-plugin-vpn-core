export interface Line {
  id: string;
  line_hash_id: string;
  line_uuid?: string;
  downstream_line_uuid?: string;
  node_id: string;
  core: string;
  source: string;
  managed: boolean;
  name: string;
  type?: string;
  transport?: string;
  security?: string;
  listen_host?: string;
  listen_port?: number;
  public_host?: string;
  domain?: string;
  outbound_ref?: string;
  outbound_server?: string;
  outbound_port?: number;
  jump_edges?: string[];
  declared_jump_edges?: string[];
  overlay?: boolean;
  overlay_status?: string;
  overlay_user?: string;
  metadata?: Record<string, string>;
  user_count: number;
  user_known: boolean;
  status?: string;
  last_error?: string;
}

export interface LineGroup {
  node_id: string;
  node_name?: string;
  lines: Line[];
}

export type LineChainStatus =
  | "planned"
  | "applying"
  | "applied_unobserved"
  | "converged"
  | "drifted"
  | "failed";

export interface LineChainSnapshot {
  target_line_uuid?: string;
  target_node_id?: string;
  artifact_digest?: string;
  status: LineChainStatus;
}

export interface LineChainAttempt {
  operation: "set" | "replace" | "remove";
  candidate_target_line_uuid?: string;
  approval_id: string;
  candidate_artifact_digest?: string;
  status: "planned" | "applying" | "failed";
  error_code?: string;
  error?: string;
}

export interface LineChain {
  source_line_uuid: string;
  source_node_id?: string;
  status: LineChainStatus;
  current?: LineChainSnapshot | null;
  attempt?: LineChainAttempt | null;
  observed_outbound_tag?: string;
  observed_downstream_line_uuid?: string;
  last_error?: string;
}

export function lineChainTone(chain: LineChain): "healthy" | "warning" | "error" {
  if (chain.status === "converged") return "healthy";
  if (chain.status === "failed" || chain.status === "drifted") return "error";
  return "warning";
}

export interface VpnCredentialView {
  protocol: string;
  flow?: string;
  method?: string;
  security?: string;
  has_secret: boolean;
}

export interface LineBinding {
  line_hash_id: string;
  enabled: boolean;
  flow_override?: string;
}

export interface VpnUser {
  id: string;
  email: string;
  name?: string;
  enabled: boolean;
  credentials: VpnCredentialView[];
  bindings: LineBinding[];
  quota_bytes?: number;
  expires_at?: string;
  group?: string;
  comment?: string;
  migrated: boolean;
  created_at: string;
  updated_at: string;
}

export function formatBytes(value: number | undefined): string {
  const bytes = Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let amount = bytes;
  let unit = -1;
  do {
    amount /= 1024;
    unit += 1;
  } while (amount >= 1024 && unit < units.length - 1);
  return `${amount >= 100 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

export function safeErrorMessage(value: unknown, fallback = "Request failed"): string {
  if (value instanceof Error && value.message.trim()) return value.message;
  if (typeof value === "string" && value.trim()) return value;
  return fallback;
}

export function filterLineGroups(groups: LineGroup[], query: string): LineGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;
  return groups
    .map((group) => ({
      ...group,
      lines: group.lines.filter((line) => [
        group.node_name, group.node_id, line.name, line.type, line.core,
        line.source, line.public_host, line.listen_host, line.domain, line.status,
        line.outbound_ref, line.outbound_server, line.last_error, line.line_hash_id,
      ].some((value) => value?.toLowerCase().includes(needle))),
    }))
    .filter((group) => group.lines.length > 0);
}

export function lineStatus(line: Line): "healthy" | "warning" | "error" {
  if (line.status === "error" || line.last_error) return "error";
  if (line.status === "pending" || line.status === "stale") return "warning";
  return "healthy";
}

export function formatLineEndpoint(line: Line): string {
  return formatHostPort(line.public_host, line.listen_port);
}

export function formatLineListen(line: Line): string {
  return formatHostPort(line.listen_host, line.listen_port);
}

export function formatLineDomain(line: Line): string {
  return line.domain?.trim() || "-";
}

export function lineOwnership(line: Line): string {
  return line.managed ? "managed" : "observed";
}

export function lineErrorText(line: Line): string {
  return line.last_error?.trim() || "none reported";
}

function formatHostPort(host: string | undefined, port: number | undefined): string {
  const trimmedHost = host?.trim() || "";
  if (!trimmedHost) return "-";
  if (typeof port === "number" && Number.isFinite(port) && port > 0) {
    const formattedHost = trimmedHost.includes(":") && !trimmedHost.startsWith("[")
      ? `[${trimmedHost}]`
      : trimmedHost;
    return `${formattedHost}:${port}`;
  }
  return trimmedHost;
}

// design-17 S3: the managed-line overlay surface. A definition is the
// server-owned plan/apply record; a line carries overlay=true once the
// rediscovered inbound joins its definition (server read-model join).
export interface ManagedLineDef {
  line_uuid: string;
  node_id: string;
  line_hash_id: string;
  tag: string;
  port: number;
  sni: string;
  user_id: string;
  user_name: string;
  status: "planned" | "applied" | "failed" | string;
  approval_id: string;
  last_error?: string;
  created_at: string;
  updated_at: string;
}

export interface RolloutPlanned {
  node_id: string;
  approval_id: string;
  line_uuid: string;
  tag: string;
  port: number;
  sni: string;
}

export interface RolloutSkipped {
  node_id: string;
  reason: string;
}

export interface RolloutResult {
  ok: boolean;
  planned: RolloutPlanned[];
  skipped: RolloutSkipped[];
}

// overlayTone maps the definition status to the badge's semantic tones.
export function overlayTone(status: string | undefined): "success" | "warning" | "error" | "info" {
  switch (status) {
    case "applied": return "success";
    case "planned": return "warning";
    case "failed": return "error";
    default: return "info";
  }
}

// overlayCoverage counts node groups that have an applied overlay line:
// the fleet-coverage headline ("N of M nodes carry the managed line").
export function overlayCoverage(groups: LineGroup[]): { covered: number; total: number } {
  let covered = 0;
  for (const group of groups) {
    if (group.lines.some((line) => line.overlay && line.overlay_status === "applied")) covered++;
  }
  return { covered, total: groups.length };
}

// unresolvedOverlayDefs are definitions with no visible line yet: planned
// (awaiting approval/apply) or failed. They surface in their own strip
// because there is no line row to hang the badge on.
export function unresolvedOverlayDefs(defs: ManagedLineDef[], groups: LineGroup[]): ManagedLineDef[] {
  const visible = new Set<string>();
  for (const group of groups) {
    for (const line of group.lines) {
      if (line.overlay) visible.add(line.line_hash_id);
    }
  }
  return defs.filter((def) => !visible.has(def.line_hash_id));
}

// rolloutSummaryLine is the one honest sentence the result panel leads with.
export function rolloutSummaryLine(result: RolloutResult): string {
  const planned = result.planned?.length ?? 0;
  const skipped = result.skipped?.length ?? 0;
  if (planned === 0 && skipped === 0) return "No eligible nodes. Every node is already planned or applied.";
  if (skipped === 0) return `Planned for ${planned} node${planned === 1 ? "" : "s"}. Review and approve the batch to apply.`;
  return `Planned for ${planned} node${planned === 1 ? "" : "s"}, skipped ${skipped} (reasons below). Approve the batch to apply.`;
}

// ── line table ordering ──────────────────────────────────────────────────
// A fleet view that lists 111 rows in server order is a list, not a table.
// Sorting is pure so it can be tested without a DOM and reused by the header.

export interface LineRow {
  group: LineGroup;
  line: Line;
}

export type LineSortKey = "node" | "line" | "core" | "ownership" | "endpoint" | "users" | "status";
export type SortDirection = "asc" | "desc";

const STATUS_ORDER: Record<string, number> = { error: 0, warning: 1, healthy: 2 };

function lineSortValue(row: LineRow, key: LineSortKey): string | number {
  switch (key) {
    case "node": return (row.group.node_name || row.group.node_id).toLowerCase();
    case "line": return row.line.name.toLowerCase();
    case "core": return (row.line.core || "").toLowerCase();
    case "ownership": return lineOwnership(row.line);
    case "endpoint": return formatLineEndpoint(row.line).toLowerCase();
    // Unknown user counts sort last in either direction rather than as zero,
    // which would read as "this line has no users" when it means "not known".
    case "users": return row.line.user_known ? row.line.user_count : Number.MAX_SAFE_INTEGER;
    case "status": return STATUS_ORDER[lineStatus(row.line)] ?? 3;
  }
}

export function sortLineRows(rows: readonly LineRow[], key: LineSortKey | "", direction: SortDirection): LineRow[] {
  if (!key) return [...rows];
  const sign = direction === "desc" ? -1 : 1;
  return [...rows].sort((left, right) => {
    const a = lineSortValue(left, key);
    const b = lineSortValue(right, key);
    if (a === b) {
      // Ties fall back to node then line, and deliberately do NOT follow the
      // primary direction: reversing "status" should reverse the status groups,
      // not shuffle the rows inside each one. Same data, same order, always.
      return (left.group.node_id + left.line.name).localeCompare(right.group.node_id + right.line.name);
    }
    if (typeof a === "number" && typeof b === "number") return (a - b) * sign;
    return String(a).localeCompare(String(b)) * sign;
  });
}

/**
 * One page of a list, with the requested page clamped into range.
 *
 * The slice is always taken after sorting and filtering, never before: a page
 * is a window onto the whole set, so `total` is what a header may report and
 * the order is the order the operator asked for. A pager that sorts its own
 * page is worse than no pager, because it looks right.
 */
export interface Page<T> {
  rows: T[];
  page: number;
  pages: number;
  /** 1-based inclusive bounds of the slice. Both 0 when the set is empty. */
  from: number;
  to: number;
  /** Size of the whole set the page was cut from, not of the page. */
  total: number;
}

export function pageRows<T>(rows: readonly T[], requestedPage: number, pageSize: number): Page<T> {
  const size = Math.max(1, Math.trunc(pageSize) || 1);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const page = Math.min(Math.max(1, Math.trunc(requestedPage) || 1), pages);
  const start = (page - 1) * size;
  const slice = rows.slice(start, start + size);
  return {
    rows: slice,
    page,
    pages,
    from: slice.length ? start + 1 : 0,
    to: start + slice.length,
    total: rows.length,
  };
}

/**
 * A quota box read as "how many GiB", or `undefined` for "do not change it".
 *
 * Blank is not zero. The field is prefilled from the stored record and then the
 * whole form is submitted, so an operator who opens an account to rename it and
 * never looks at the quota must not have their limit removed. Unparseable is
 * also "do not change it": storing a number nobody typed, while the box still
 * shows what they did type, is worse than ignoring it.
 *
 * A zero the operator actually types is kept, because clearing a quota on
 * purpose has to stay possible.
 */
export function quotaBytesFromInput(raw: string): number | undefined {
  const text = raw.trim();
  if (text === "") return undefined;
  const gib = Number(text);
  if (!Number.isFinite(gib) || gib < 0) return undefined;
  return Math.round(gib * 1024 * 1024 * 1024);
}

/**
 * One row of the server's usage read-model: bytes for a (node, user) pair, and
 * for a (node, user, line) triple once a line-aware collector is reporting.
 *
 * The server has computed and returned these all along; the plugin declared a
 * result type without them, so every per-line and per-(node, user) figure was
 * parsed and dropped. See vpnCoreUsageRPC in lattice-server internal/server/usage.go.
 */
export interface UsageRow {
  node_id: string;
  node_name?: string;
  user_id: string;
  email?: string;
  /** Empty when the node's collector reports node totals only. */
  line_hash_id?: string;
  bytes: number;
}

export interface LineUsage {
  lineHashID: string;
  label: string;
  nodeID: string;
  nodeName?: string;
  /** Whether the hash matched a line in the current fleet listing. */
  resolved: boolean;
  bytes: number;
  users: number;
}

export interface UsageLineBreakdown {
  lines: LineUsage[];
  /** Bytes a collector attributed to a specific line. */
  attributedBytes: number;
  /** Bytes reported against a node with no line attribution. */
  unattributedBytes: number;
  /** Nodes contributing unattributed bytes, so the gap has an address. */
  unattributedNodes: string[];
}

/**
 * Fold usage rows into per-line totals, naming each line from the fleet listing.
 *
 * Unattributed bytes are counted rather than hidden: a node running an older or
 * aggregate-only collector reports a node total with no line, and a per-line
 * table that quietly omitted it would read as a complete picture of traffic
 * when it is not. A hash that matches no current line keeps the hash as its
 * label and is marked unresolved rather than dropped.
 */
export function usageByLine(rows: readonly UsageRow[], groups: readonly LineGroup[]): UsageLineBreakdown {
  const lineByHash = new Map<string, { line: Line; nodeName?: string }>();
  for (const group of groups) {
    for (const line of group.lines) {
      const hash = line.line_hash_id?.trim();
      if (hash && !lineByHash.has(hash)) lineByHash.set(hash, { line, nodeName: group.node_name });
    }
  }

  const totals = new Map<string, LineUsage & { userIDs: Set<string> }>();
  const unattributedNodes = new Set<string>();
  let attributedBytes = 0;
  let unattributedBytes = 0;

  for (const row of rows) {
    const hash = row.line_hash_id?.trim();
    const bytes = Number.isFinite(row.bytes) ? row.bytes : 0;
    if (!hash) {
      unattributedBytes += bytes;
      if (bytes > 0) unattributedNodes.add(row.node_name || row.node_id);
      continue;
    }
    attributedBytes += bytes;
    const key = `${row.node_id} ${hash}`;
    let entry = totals.get(key);
    if (!entry) {
      const found = lineByHash.get(hash);
      entry = {
        lineHashID: hash,
        label: found?.line.name || hash,
        nodeID: row.node_id,
        nodeName: row.node_name || found?.nodeName,
        resolved: !!found,
        bytes: 0,
        users: 0,
        userIDs: new Set<string>(),
      };
      totals.set(key, entry);
    }
    entry.bytes += bytes;
    if (row.user_id) entry.userIDs.add(row.user_id);
  }

  const lines = [...totals.values()]
    .map(({ userIDs, ...entry }) => ({ ...entry, users: userIDs.size }))
    .sort((a, b) => b.bytes - a.bytes || a.lineHashID.localeCompare(b.lineHashID));

  return {
    lines,
    attributedBytes,
    unattributedBytes,
    unattributedNodes: [...unattributedNodes].sort(),
  };
}
