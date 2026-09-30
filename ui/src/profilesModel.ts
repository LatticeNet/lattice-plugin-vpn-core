/**
 * profilesModel.ts, Node Profiles: which nodes vpn-core can read, whether
 * each collector works, and the one that needs fixing.
 *
 * Production has 25 profiles that say the same thing on every row: observed,
 * sing-box 1.12.4, collector ok, one config path, every inbound discovered.
 * A value identical on every row is a fact about the fleet, so it moves to
 * the head and its column leaves; what is left in the table is what differs.
 * Exceptions sort first, so the node to fix is the first row.
 */

export interface Profile {
  node_id: string;
  node_name?: string;
  managed: boolean;
  core?: string;
  core_version?: string;
  config_path?: string;
  stats_api?: string;
  applied: boolean;
  last_apply_at?: string;
  last_error?: string;
  inbound_count: number;
  discovered_count: number;
  discovery_status?: string;
  discovery_error?: string;
  collector?: { source?: string; status?: string; last_error?: string };
  capabilities: string[];
}

export interface ProfilePluginConfig {
  singbox_discover: boolean;
  singbox_bin?: string;
  proxy_usage_file?: string;
  proxy_usage_url?: string;
  proxy_usage_xray_api?: string;
  proxy_usage_xray_bin?: string;
  proxy_usage_xray_pattern?: string;
  singbox_stats_api?: string;
}

export interface ProfileSettings {
  node_id: string;
  node_name?: string;
  prerequisites: {
    allow_exec: boolean;
    allow_root_exec: boolean;
    no_exec: boolean;
    reported_allow_exec: boolean;
    reported_allow_root_exec: boolean;
    reported_no_exec: boolean;
  };
  saved: ProfilePluginConfig;
  reported?: ProfilePluginConfig;
  reconfigure_required: boolean;
}

export type ProfileTone = "healthy" | "warning" | "error" | "neutral";

export function profileName(profile: Pick<Profile, "node_id" | "node_name">): string {
  return profile.node_name || profile.node_id;
}

export function coreText(profile: Profile): string {
  return [profile.core || "unknown core", profile.core_version].filter(Boolean).join(" ");
}

export function ownershipText(profile: Profile): string {
  if (!profile.managed) return "observed";
  return profile.applied ? "managed, applied" : "managed, not applied yet";
}

export function collectorText(profile: Profile): string {
  return profile.collector?.status || "not reported";
}

export function collectorTone(profile: Profile): ProfileTone {
  const status = profile.collector?.status;
  if (status === "ok") return "healthy";
  if (status === "error") return "error";
  return status ? "warning" : "neutral";
}

export function inboundText(profile: Profile): string {
  if (profile.inbound_count === profile.discovered_count) return String(profile.inbound_count);
  return `${profile.inbound_count}, ${profile.discovered_count} discovered`;
}

/** What is wrong with a profile, worst first; empty when nothing is. */
export function profileIssues(profile: Profile): Array<{ text: string; tone: ProfileTone }> {
  const issues: Array<{ text: string; tone: ProfileTone }> = [];
  if (profile.last_error) issues.push({ text: `apply failed: ${profile.last_error}`, tone: "error" });
  if (profile.discovery_error) issues.push({ text: `discovery failed: ${profile.discovery_error}`, tone: "error" });
  const collector = profile.collector?.status;
  if (collector === "error") issues.push({ text: `collector failing${profile.collector?.last_error ? `: ${profile.collector.last_error}` : ""}`, tone: "error" });
  else if (collector && collector !== "ok") issues.push({ text: `collector ${collector}${profile.collector?.last_error ? `: ${profile.collector.last_error}` : ""}`, tone: "warning" });
  else if (!collector) issues.push({ text: "no collector reported, so this node's traffic is unknown", tone: "warning" });
  if (profile.managed && !profile.applied) issues.push({ text: "managed, and its config is not applied yet", tone: "warning" });
  return issues;
}

/** Higher is worse: errors, then warnings, then the rest. */
export function profileRank(profile: Profile): number {
  const issues = profileIssues(profile);
  if (issues.some((issue) => issue.tone === "error")) return 2;
  return issues.length ? 1 : 0;
}

export function sortProfiles(profiles: readonly Profile[]): Profile[] {
  return [...profiles].sort((a, b) =>
    profileRank(b) - profileRank(a) || profileName(a).localeCompare(profileName(b), undefined, { sensitivity: "base", numeric: true }));
}

export interface ProfileColumns {
  core: boolean;
  ownership: boolean;
  inbounds: boolean;
  collector: boolean;
  path: boolean;
  issue: boolean;
}

export interface ProfileHead {
  nodes: number;
  collectorsOk: number;
  managed: number;
  /** Facts every profile shares, each said once: "sing-box 1.12.4". */
  shared: string[];
  show: ProfileColumns;
}

function uniform<T>(values: readonly T[]): T | undefined {
  return values.length && values.every((value) => value === values[0]) ? values[0] : undefined;
}

export function profileHead(profiles: readonly Profile[]): ProfileHead {
  const core = uniform(profiles.map(coreText));
  const ownership = uniform(profiles.map(ownershipText));
  const collector = uniform(profiles.map(collectorText));
  const path = uniform(profiles.map((profile) => profile.config_path || ""));
  const inboundsMatch = profiles.every((profile) => profile.inbound_count === profile.discovered_count);
  const shared: string[] = [];
  if (profiles.length) {
    if (core !== undefined) shared.push(core);
    if (ownership !== undefined) shared.push(ownership === "observed" ? "observed, not managed" : ownership);
    if (collector !== undefined) shared.push(collector === "ok" ? "collector ok" : `collector ${collector}`);
    if (path !== undefined) shared.push(path ? `config ${path}` : "no config path reported");
    if (inboundsMatch) shared.push("every inbound discovered");
  }
  return {
    nodes: profiles.length,
    collectorsOk: profiles.filter((profile) => profile.collector?.status === "ok").length,
    managed: profiles.filter((profile) => profile.managed).length,
    shared,
    show: {
      core: core === undefined,
      ownership: ownership === undefined,
      // The count differs per node, so it stays; only the discovered half folds.
      inbounds: true,
      collector: collector === undefined,
      path: path === undefined,
      issue: profiles.some((profile) => profileIssues(profile).length > 0),
    },
  };
}
