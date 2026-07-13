export interface Line {
  id: string;
  line_hash_id: string;
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
        line.source, line.public_host, line.domain, line.status,
      ].some((value) => value?.toLowerCase().includes(needle))),
    }))
    .filter((group) => group.lines.length > 0);
}

export function lineStatus(line: Line): "healthy" | "warning" | "error" {
  if (line.status === "error" || line.last_error) return "error";
  if (line.status === "pending" || line.status === "stale") return "warning";
  return "healthy";
}
