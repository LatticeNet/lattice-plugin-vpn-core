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
