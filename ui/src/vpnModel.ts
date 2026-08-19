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
  return line.last_error?.trim() || "-";
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
