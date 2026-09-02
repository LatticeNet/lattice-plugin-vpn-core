<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import {
  Activity,
  ChevronRight,
  CircleAlert,
  Gauge,
  KeyRound,
  Link2,
  LoaderCircle,
  Pencil,
  Plus,
  Radar,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
  Waypoints,
  X,
} from "@lucide/vue";

import { BridgeClient, canCall, type HostInit } from "./bridge";
import { attentionItems, buildNodeRows, lineRole, livenessSummary, normalizeServiceNote, summarizeFleet, type AttentionItem, type Bank, type NodeRow, type ServiceVerdict } from "./fleetRows";
import LineChainWorkspace from "./LineChainWorkspace.vue";
import { evidenceRoute, hostOriginFromHash, postNavigate, type EvidenceLens } from "./navigate";
import { LineWorkspaceLoader } from "./lineWorkspace";
import { MIN_ANCHOR_TOP, anchorTopFrom, clampAnchorTop, isInsideOverlay } from "./overlayAnchor";
import {
  filterLineGroups,
  formatBytes,
  formatLineDomain,
  formatLineEndpoint,
  formatLineListen,
  lineErrorText,
  lineOwnership,
  lineStatus,
  lineServiceTone,
  overlayCoverage,
  overlayTone,
  pageRows,
  rolloutSummaryLine,
  safeErrorMessage,
  unresolvedOverlayDefs,
  usageByLine,
  quotaBytesFromInput,
  type Line,
  type LineSortKey,
  type SortDirection,
  type LineChain,
  type LineGroup,
  type ManagedLineDef,
  type RolloutResult,
  type UsageRow,
  type VpnUser,
} from "./vpnModel";

const SERVICES = {
  lines: "latticenet.vpn-core/lines",
  users: "latticenet.vpn-core/users",
  admin: "latticenet.vpn-core/users-admin",
  profiles: "latticenet.vpn-core/profiles",
  usage: "latticenet.vpn-core/usage",
} as const;

interface Profile {
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

interface ProfilePluginConfig {
  singbox_discover: boolean;
  singbox_bin?: string;
  proxy_usage_file?: string;
  proxy_usage_url?: string;
  proxy_usage_xray_api?: string;
  proxy_usage_xray_bin?: string;
  proxy_usage_xray_pattern?: string;
  singbox_stats_api?: string;
}

interface ProfileSettings {
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

interface UsageByUser {
  user_id: string;
  email?: string;
  used_bytes: number;
  quota_bytes?: number;
  status?: string;
  last_seen?: string;
}

interface UsageByNode {
  node_id: string;
  node_name?: string;
  used_bytes: number;
  user_count: number;
  at?: string;
}

interface UsageCollector {
  node_id: string;
  node_name?: string;
  source?: string;
  status?: string;
  error?: string;
  checked_at?: string;
}

interface UsageResult {
  by_user: UsageByUser[];
  by_node: UsageByNode[];
  /**
   * Per-(node, user) and, where a line-aware collector is running,
   * per-(node, user, line) bytes. The server has always returned these.
   */
  rows: UsageRow[];
  collectors: UsageCollector[];
  /** True when at least one row carries a line_hash_id. */
  per_line: boolean;
}

const init = ref<HostInit>();
const bootError = ref("");
const error = ref("");
const notice = ref("");
const loading = ref(true);
const refreshing = ref(false);
const search = ref("");
const lines = ref<LineGroup[]>([]);
const chains = ref<LineChain[]>([]);
const users = ref<VpnUser[]>([]);
const profiles = ref<Profile[]>([]);
const usage = ref<UsageResult>({ by_user: [], by_node: [], rows: [], collectors: [], per_line: false });
const managedDefs = ref<ManagedLineDef[]>([]);

let bridge: BridgeClient | undefined;
try {
  bridge = new BridgeClient(window);
  bridge.init.then(async (value) => {
    init.value = value;
    await loadCurrent();
  }).catch((cause) => {
    bootError.value = safeErrorMessage(cause, "Plugin host unavailable");
    loading.value = false;
  });
} catch (cause) {
  bootError.value = safeErrorMessage(cause, "Plugin host unavailable");
  loading.value = false;
}

const route = computed(() => init.value?.pluginRoute ?? "lines");
const routeMeta = computed(() => ({
  lines: { title: "Lines", description: "Managed and discovered proxy endpoints across the fleet.", icon: Radar },
  users: { title: "Users", description: "Protocol credentials and line-level access bindings.", icon: Users },
  profiles: { title: "Node Profiles", description: "Runtime ownership, discovery and collector readiness.", icon: ServerCog },
  usage: { title: "Usage", description: "Traffic accounting by user and reporting node.", icon: Gauge },
}[route.value] ?? { title: "VPN Core", description: "sing-box management", icon: Radar }));
const visibleLineGroups = computed(() => filterLineGroups(lines.value, search.value));
// ── lenses over one dataset ──────────────────────────────────────────────
// Fleet is nodes with their lines folded underneath; Topology is the node
// graph with the canonical chain table; Attention is every claim the page can
// prove that needs a hand. All three read the same `lines` and `chains`.
type Lens = "fleet" | "topology" | "attention";
/* The plugin document's own query string can open a lens or a node, so a
 * host, a reviewer or an agent can deep-link a state (`?lens=topology`,
 * `?expand=<node_id>`). Production loads the document without a query today;
 * nothing here depends on one being present. */
const documentQuery = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
const LENSES: readonly Lens[] = ["fleet", "topology", "attention"];
const requestedLens = documentQuery.get("lens");
const lens = ref<Lens>(LENSES.includes(requestedLens as Lens) ? (requestedLens as Lens) : "fleet");
const fleetSummary = computed(() => summarizeFleet(lines.value));
const nodeRows = computed(() => buildNodeRows(visibleLineGroups.value));
const attention = computed(() => attentionItems(lines.value));
const attentionErrors = computed(() => attention.value.filter((item) => item.severity === "error").length);
const attentionWarnings = computed(() => attention.value.filter((item) => item.severity === "warning").length);
const attentionTone = computed(() => attentionErrors.value ? "error" : attentionWarnings.value ? "warning" : "neutral");
/* One statement of what the probes said, so the tile, the proof line and
 * the attention row cannot disagree about it. */
const liveness = computed(() => livenessSummary(lines.value));
const searching = computed(() => search.value.trim().length > 0);

/* 25 node rows is one screen and, today, the whole fleet. Lines open under a
 * node on demand, so the painted area stays a page rather than a scroll. */
const NODE_PAGE_SIZE = 25;
const nodePage = ref(1);
const nodePageData = computed(() => pageRows(nodeRows.value, nodePage.value, NODE_PAGE_SIZE));
watch(search, () => { nodePage.value = 1; });

const expandedNodes = ref(new Set<string>(documentQuery.getAll("expand").filter(Boolean)));
const expandedBanks = ref(new Set<string>(documentQuery.getAll("bank").filter(Boolean)));
function toggled(current: Set<string>, key: string): Set<string> {
  const next = new Set(current);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
function toggleNode(nodeID: string): void {
  expandedNodes.value = toggled(expandedNodes.value, nodeID);
}
function toggleBank(key: string): void {
  expandedBanks.value = toggled(expandedBanks.value, key);
}
/* A search opens every matching node, because the operator asked for lines,
 * not for nodes; without a search a node opens only when asked. */
function nodeOpen(row: NodeRow): boolean {
  return searching.value || expandedNodes.value.has(row.group.node_id);
}
function bankOpen(bank: Bank): boolean {
  return expandedBanks.value.has(bank.key);
}

type FleetEntry = { kind: "bank"; bank: Bank } | { kind: "line"; line: Line; bank?: Bank };
function fleetEntries(row: NodeRow): FleetEntry[] {
  const entries: FleetEntry[] = [];
  for (const bank of row.banks) {
    entries.push({ kind: "bank", bank });
    if (bankOpen(bank)) for (const line of bank.lines) entries.push({ kind: "line", line, bank });
  }
  for (const line of row.singles) entries.push({ kind: "line", line });
  return entries;
}

const nodeNames = computed(() => new Map(lines.value.map((group) => [group.node_id, group.node_name || group.node_id])));
function nodeNameOf(id: string): string {
  return nodeNames.value.get(id) ?? id;
}
function bankTargets(bank: Bank): string {
  const names = bank.targetNodeIDs.map(nodeNameOf);
  const shown = names.slice(0, 3).join(", ");
  const rest = names.length > 3 ? ` and ${names.length - 3} more` : "";
  const off = bank.offFleet ? `${names.length ? "; " : ""}${bank.offFleet} off-fleet` : "";
  return `${shown}${rest}${off}` || "no resolved target";
}
function roleLabel(line: Line): string {
  const role = lineRole(line);
  if (role === "orphan") return "no outbound";
  return role;
}
function serviceLabel(verdict: ServiceVerdict): string {
  return ({
    running: "running",
    down: "down",
    restarting: "restarting",
    partial: "partly reported",
    unknown: "not reported",
  } as const)[verdict];
}
function serviceTone(verdict: ServiceVerdict): "healthy" | "warning" | "error" | "neutral" {
  return ({ running: "healthy", down: "error", restarting: "warning", partial: "warning", unknown: "neutral" } as const)[verdict];
}
function lineServiceLabel(line: Line): string {
  const state = (line.service_state ?? "").trim();
  if (state && state !== "unknown") return state;
  // "not reported" is a probe that never ran; "unproven" is a probe that ran
  // and refused to guess. The tile and the proof line say unproven, so the
  // cell has to say it too, and the note is the evidence on hover.
  return line.service_note ? "unproven" : "not reported";
}
function lineServiceTitle(line: Line): string | undefined {
  if (line.service_note) return normalizeServiceNote(line.service_note).text;
  return line.service_checked_at ? `checked ${line.service_checked_at}` : undefined;
}
/** The node row's verdict word, with the same unproven rule as its lines. */
function nodeServiceLabel(row: NodeRow): string {
  if (row.service === "unknown" && row.group.lines.some((line) => line.service_note)) return "unproven";
  return serviceLabel(row.service);
}
function nodeServiceTitle(row: NodeRow): string | undefined {
  const noted = row.group.lines.find((line) => line.service_note);
  return noted?.service_note ? normalizeServiceNote(noted.service_note).text : undefined;
}

/* The proof line: when the page last heard from the control plane. The
 * plugin holds no timer (refreshPolicy.test.ts guards that), so the time is
 * absolute and the label is true for as long as the tab is open. */
const refreshedAt = ref<number>();
const observedAtLabel = computed(() => {
  if (!refreshedAt.value) return "";
  const date = new Date(refreshedAt.value);
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
});
const livenessLine = computed(() => {
  const service = fleetSummary.value.service;
  if (!service.reported && liveness.value.unprovenNodes) {
    return liveness.value.refusedPath
      ? `liveness unproven: the probe refused ${liveness.value.refusedPath} on ${liveness.value.unprovenNodes} nodes`
      : `liveness unproven on ${liveness.value.unprovenNodes} nodes`;
  }
  if (!service.reported) return "liveness not reported by any node";
  const parts = [`${service.running} running`];
  if (service.down) parts.push(`${service.down} down`);
  if (service.restarting) parts.push(`${service.restarting} restarting`);
  if (service.unknown) parts.push(`${service.unknown} not reported`);
  return `liveness: ${parts.join(", ")}`;
});

function attentionRow(item: AttentionItem): { group: LineGroup; line: Line } | undefined {
  if (!item.lineHashID) return undefined;
  for (const group of lines.value) {
    const line = group.lines.find((value) => value.line_hash_id === item.lineHashID);
    if (line) return { group, line };
  }
  return undefined;
}
/* A line's evidence lives in the host: the Connections lens filtered to the
 * node and, where the line has a uuid, to that line. The host decides whether
 * the route is one a plugin may open; this side only asks. */
const hostOrigin = hostOriginFromHash(typeof location === "undefined" ? "" : location.hash);
const canOpenEvidence = !!hostOrigin;
function openEvidence(nodeID: string, lens: EvidenceLens, line?: Line): void {
  if (!hostOrigin) return;
  postNavigate(window, evidenceRoute(nodeID, lens, line?.line_uuid), hostOrigin);
}

function openProfiles(): void {
  if (!hostOrigin) return;
  postNavigate(window, "/plugins/latticenet.vpn-core/profiles", hostOrigin);
}
function openAttention(item: AttentionItem): void {
  if (item.action === "rollout") {
    openRollout();
    return;
  }
  if (item.action === "profiles") {
    openProfiles();
    return;
  }
  const found = attentionRow(item);
  if (found) void openLineDetails(found.group, found.line);
}
const allLines = computed(() => lines.value.flatMap((group) => group.lines));
const healthyLines = computed(() => allLines.value.filter((line) => lineStatus(line) === "healthy").length);
const managedLines = computed(() => allLines.value.filter((line) => line.managed).length);
const lineOptions = computed(() => lines.value.flatMap((group) => group.lines.map((line) => ({
  id: line.line_hash_id,
  label: `${group.node_name || group.node_id} / ${line.name}`,
}))));
const enabledUsers = computed(() => users.value.filter((user) => user.enabled).length);
const totalBindings = computed(() => users.value.reduce((count, user) => count + user.bindings.length, 0));
const totalTraffic = computed(() => usage.value.by_user.reduce((sum, row) => sum + (row.used_bytes || 0), 0));
const lineUsage = computed(() => usageByLine(usage.value.rows, lines.value));
const canCreateUser = computed(() => canCall(init.value, SERVICES.admin, "create"));
const canUpdateUser = computed(() => canCall(init.value, SERVICES.admin, "update"));
const canDeleteUser = computed(() => canCall(init.value, SERVICES.admin, "delete"));
const canBindUser = computed(() => canCall(init.value, SERVICES.admin, "bind"));
const canUnbindUser = computed(() => canCall(init.value, SERVICES.admin, "unbind"));
const hasUserMutations = computed(() => [
  canCreateUser.value,
  canUpdateUser.value,
  canDeleteUser.value,
  canBindUser.value,
  canUnbindUser.value,
].some(Boolean));
const showUserActions = computed(() => canUpdateUser.value || canDeleteUser.value || canBindUser.value || canUnbindUser.value);
const canViewLineDetails = computed(() => canCall(init.value, SERVICES.lines, "get"));
const canReadChains = computed(() => canCall(init.value, SERVICES.lines, "chains"));
const canPlanChain = computed(() => canCall(init.value, SERVICES.lines, "plan_chain"));
const canPlanRemoveChain = computed(() => canCall(init.value, SERVICES.lines, "plan_remove_chain"));
const canReadProfileSettings = computed(() => canCall(init.value, SERVICES.profiles, "settings"));
const canConfigureProfile = computed(() => canCall(init.value, SERVICES.profiles, "configure"));
const canPlanLineUsers = computed(() => ["plan_add", "plan_update", "plan_remove"]
  .every((method) => canCall(init.value, SERVICES.admin, method)));
const canRotateCredentials = computed(() => canCall(init.value, SERVICES.admin, "rotate"));
const canSyncMetadata = computed(() => canCall(init.value, SERVICES.lines, "sync_metadata"));
const canReattachLine = computed(() => canCall(init.value, SERVICES.lines, "reattach"));
const canReadManaged = computed(() => canCall(init.value, SERVICES.lines, "managed"));
const canRollout = computed(() => canCall(init.value, SERVICES.lines, "rollout"));
const overlayStats = computed(() => overlayCoverage(lines.value));
const unresolvedDefs = computed(() => unresolvedOverlayDefs(managedDefs.value, lines.value));
const rolloutableUsers = computed(() => users.value.filter((user) =>
  user.enabled && user.credentials.some((cred) => cred.protocol === "vless" && cred.has_secret)));

async function pluginCall<T>(service: string, method: string, payload: unknown = {}): Promise<T> {
  if (!bridge || !canCall(init.value, service, method)) {
    throw new Error(`This session is not allowed to run ${method}, so nothing was sent to any node.`);
  }
  return bridge.call<T>(service, method, payload).promise;
}

let lineWorkspaceLoader: LineWorkspaceLoader | undefined;
const busyChainSources = ref<ReadonlySet<string>>(new Set());

function setChainBusy(sourceLineUUID: string, busy: boolean): void {
  const next = new Set(busyChainSources.value);
  if (busy) next.add(sourceLineUUID);
  else next.delete(sourceLineUUID);
  busyChainSources.value = next;
}

async function planLineChain(sourceLineUUID: string, targetLineUUID: string): Promise<void> {
  if (!canPlanChain.value || busyChainSources.value.has(sourceLineUUID)) return;
  setChainBusy(sourceLineUUID, true);
  try {
    const result = await pluginCall<{ approval?: { id?: string }; preview?: { summary?: string } }>(SERVICES.lines, "plan_chain", {
      source_line_uuid: sourceLineUUID,
      target_line_uuid: targetLineUUID,
    });
    const approvalId = result.approval?.id ?? "";
    notice.value = `Chain planned${approvalId ? ` as approval ${approvalId}` : ""}. ${result.preview?.summary || "Review it in Operations, then Approvals. No topology changed."}`;
    await loadCurrent(true);
  } catch (cause) {
    error.value = safeErrorMessage(cause, "Line chain could not be planned");
  } finally {
    setChainBusy(sourceLineUUID, false);
  }
}

async function planLineChainRemoval(sourceLineUUID: string): Promise<void> {
  if (!canPlanRemoveChain.value || busyChainSources.value.has(sourceLineUUID)) return;
  setChainBusy(sourceLineUUID, true);
  try {
    const result = await pluginCall<{ approval?: { id?: string }; preview?: { summary?: string } }>(SERVICES.lines, "plan_remove_chain", {
      source_line_uuid: sourceLineUUID,
    });
    const approvalId = result.approval?.id ?? "";
    notice.value = `Chain removal planned${approvalId ? ` as approval ${approvalId}` : ""}. ${result.preview?.summary || "Review it in Operations, then Approvals. The current link stays until Lattice observes the removal."}`;
    await loadCurrent(true);
  } catch (cause) {
    error.value = safeErrorMessage(cause, "Line chain removal could not be planned");
  } finally {
    setChainBusy(sourceLineUUID, false);
  }
}

async function loadCurrent(background = false): Promise<void> {
  if (!init.value) return;
  if (background) refreshing.value = true;
  else loading.value = true;
  error.value = "";
  try {
    switch (route.value) {
      case "lines": {
        const calls: Promise<void>[] = [];
        if (canReadChains.value) {
          lineWorkspaceLoader ??= new LineWorkspaceLoader(pluginCall);
          calls.push(lineWorkspaceLoader.refresh().then((snapshot) => {
            if (!snapshot) throw new Error(lineWorkspaceLoader?.error || "Line topology unavailable");
            lines.value = [...snapshot.groups];
            chains.value = [...snapshot.chains];
            if (lineWorkspaceLoader?.error) error.value = `The topology below is the last good read, not the current one. The newest refresh failed: ${lineWorkspaceLoader.error}`;
          }));
        } else {
          calls.push(pluginCall<{ groups: LineGroup[] }>(SERVICES.lines, "list")
            .then((result) => { lines.value = result.groups ?? []; chains.value = []; }));
        }
        if (canReadManaged.value) {
          calls.push(pluginCall<{ managed_lines: ManagedLineDef[] }>(SERVICES.lines, "managed")
            .then((result) => { managedDefs.value = result.managed_lines ?? []; }));
        } else {
          managedDefs.value = [];
        }
        if (canRollout.value) {
          calls.push(pluginCall<{ users: VpnUser[] }>(SERVICES.users, "list")
            .then((result) => { users.value = result.users ?? []; }));
        }
        await Promise.all(calls);
        break;
      }
      case "users": {
        const [userResult, lineResult] = await Promise.all([
          pluginCall<{ users: VpnUser[] }>(SERVICES.users, "list"),
          pluginCall<{ groups: LineGroup[] }>(SERVICES.lines, "list"),
        ]);
        users.value = userResult.users ?? [];
        lines.value = lineResult.groups ?? [];
        break;
      }
      case "profiles": {
        const result = await pluginCall<{ profiles: Profile[] }>(SERVICES.profiles, "query");
        profiles.value = result.profiles ?? [];
        break;
      }
      case "usage": {
        // The line listing names the hashes the collector reports against. It
        // is the same cached read model the Lines view uses, so this costs a
        // cache read on the server, not a second fleet walk.
        const [usageResult, lineResult] = await Promise.all([
          pluginCall<UsageResult>(SERVICES.usage, "query"),
          pluginCall<{ groups: LineGroup[] }>(SERVICES.lines, "list"),
        ]);
        usage.value = { ...usageResult, rows: usageResult.rows ?? [] };
        lines.value = lineResult.groups ?? [];
        break;
      }
    }
    refreshedAt.value = Date.now();
  } catch (cause) {
    error.value = safeErrorMessage(cause, "This page could not be loaded, and nothing came back to say why.");
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

// design-17 S3: the managed-line rollout. The modal collects the account and
// candidate port; the compile only files approvals. Nothing touches a node
// until the operator approves the batch (the result panel says exactly that).
const rolloutOpen = ref(false);
const rolloutBusy = ref(false);
const rolloutError = ref("");
const rolloutResult = ref<RolloutResult>();
const rolloutUserId = ref("");
const rolloutPort = ref(24443);

// The rollout touches every eligible node in the fleet at once, so it gets a
// second step that names the nodes it will file approvals against. The first
// step collects the inputs; nothing is sent until the named list is confirmed.
const rolloutConfirm = ref(false);
const rolloutNodeNames = computed(() => lines.value.map((group) => group.node_name || group.node_id));

function openRollout(): void {
  rolloutUserId.value = rolloutableUsers.value[0]?.id ?? "";
  rolloutPort.value = 24443;
  rolloutError.value = "";
  rolloutResult.value = undefined;
  rolloutConfirm.value = false;
  rolloutOpen.value = true;
}

function closeRollout(): void {
  rolloutOpen.value = false;
  rolloutConfirm.value = false;
}

async function runRollout(): Promise<void> {
  if (!rolloutUserId.value || rolloutBusy.value || !rolloutConfirm.value) return;
  rolloutBusy.value = true;
  rolloutError.value = "";
  try {
    const result = await pluginCall<RolloutResult>(SERVICES.lines, "rollout", {
      user_id: rolloutUserId.value,
      candidate_port: rolloutPort.value || undefined,
    });
    rolloutResult.value = result;
    await loadCurrent(true);
  } catch (cause) {
    rolloutError.value = safeErrorMessage(cause, "Rollout could not be planned");
  } finally {
    rolloutBusy.value = false;
  }
}

const userDialogOpen = ref(false);
const editingUser = ref<VpnUser>();
const savingUser = ref(false);
const userForm = reactive({
  email: "",
  name: "",
  enabled: true,
  quotaGiB: "",
  expiresAt: "",
  group: "",
  comment: "",
  protocol: "vless",
  secret: "",
  flow: "",
});

function openCreateUser(): void {
  editingUser.value = undefined;
  Object.assign(userForm, { email: "", name: "", enabled: true, quotaGiB: "", expiresAt: "", group: "", comment: "", protocol: "vless", secret: "", flow: "" });
  userDialogOpen.value = true;
}

function openEditUser(user: VpnUser): void {
  editingUser.value = user;
  Object.assign(userForm, {
    email: user.email,
    name: user.name ?? "",
    enabled: user.enabled,
    quotaGiB: user.quota_bytes ? String(user.quota_bytes / 1024 / 1024 / 1024) : "",
    expiresAt: formatDateTimeLocal(user.expires_at),
    group: user.group ?? "",
    comment: user.comment ?? "",
    protocol: user.credentials[0]?.protocol ?? "vless",
    secret: "",
    flow: user.credentials[0]?.flow ?? "",
  });
  userDialogOpen.value = true;
}

async function saveUser(): Promise<void> {
  if (!userForm.email.trim() || savingUser.value) return;
  if (editingUser.value ? !canUpdateUser.value : !canCreateUser.value) return;
  savingUser.value = true;
  error.value = "";
  try {
    const payload: Record<string, unknown> = {
      email: userForm.email.trim(), name: userForm.name.trim(), enabled: userForm.enabled,
      group: userForm.group.trim(), comment: userForm.comment.trim(),
    };
    // Blank means "leave it alone", the way the expiry field below already
    // behaves. Sending 0 for a box the operator never touched is how renaming
    // a quota'd account made it unlimited.
    const quota = quotaBytesFromInput(userForm.quotaGiB);
    if (quota !== undefined) payload.quota_bytes = quota;
    const expiresAt = parseDateTimeLocal(userForm.expiresAt);
    if (expiresAt) payload.expires_at = expiresAt;
    if (editingUser.value) {
      payload.id = editingUser.value.id;
      await pluginCall(SERVICES.admin, "update", payload);
      notice.value = `${userForm.email.trim()} updated`;
    } else {
      const credential: Record<string, string> = { protocol: userForm.protocol };
      if (["vless", "vmess", "tuic"].includes(userForm.protocol)) credential.uuid = userForm.secret.trim();
      else credential.password = userForm.secret;
      if (userForm.flow.trim()) credential.flow = userForm.flow.trim();
      payload.credentials = [credential];
      await pluginCall(SERVICES.admin, "create", payload);
      notice.value = `${userForm.email.trim()} created`;
    }
    userDialogOpen.value = false;
    await loadCurrent(true);
  } catch (cause) {
    error.value = safeErrorMessage(cause, "User could not be saved");
  } finally {
    savingUser.value = false;
  }
}

const bindingUser = ref<VpnUser>();
const bindingLine = ref("");
const bindingBusy = ref(false);

async function bindLine(): Promise<void> {
  if (!bindingUser.value || !bindingLine.value || bindingBusy.value || !canBindUser.value) return;
  bindingBusy.value = true;
  try {
    await pluginCall(SERVICES.admin, "bind", { user_id: bindingUser.value.id, line_hash_id: bindingLine.value });
    notice.value = "Line binding added";
    bindingLine.value = "";
    await loadCurrent(true);
  } catch (cause) {
    error.value = safeErrorMessage(cause, "Binding could not be added");
  } finally {
    bindingBusy.value = false;
  }
}

/** The bound-identity list could not be refreshed, so it must not be read as empty. */
const usersUnavailable = ref(false);

const unbindBusy = ref(false);
async function unbindLine(lineHash: string): Promise<void> {
  if (!bindingUser.value || !canUnbindUser.value || unbindBusy.value) return;
  unbindBusy.value = true;
  try {
    await pluginCall(SERVICES.admin, "unbind", { user_id: bindingUser.value.id, line_hash_id: lineHash });
    notice.value = "Line binding removed";
    await loadCurrent(true);
  } catch (cause) {
    error.value = safeErrorMessage(cause, "Binding could not be removed");
  } finally {
    unbindBusy.value = false;
  }
}

const deleteTarget = ref<VpnUser>();
const deletingUser = ref(false);
async function deleteUser(): Promise<void> {
  if (!deleteTarget.value || !canDeleteUser.value || deletingUser.value) return;
  deletingUser.value = true;
  try {
    await pluginCall(SERVICES.admin, "delete", { id: deleteTarget.value.id });
    notice.value = `${deleteTarget.value.email} deleted`;
    deleteTarget.value = undefined;
    await loadCurrent(true);
  } catch (cause) {
    error.value = safeErrorMessage(cause, "User could not be deleted");
  } finally {
    deletingUser.value = false;
  }
}

function currentBindingUser(): VpnUser | undefined {
  return users.value.find((user) => user.id === bindingUser.value?.id);
}

function formatDate(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatDateTimeLocal(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseDateTimeLocal(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

const lineDetailOpen = ref(false);
const lineDetailBusy = ref(false);
const lineDetailError = ref("");
const lineDetail = ref<Line>();
const lineDetailNodeName = ref("");

async function openLineDetails(group: LineGroup, line: Line): Promise<void> {
  if (!canViewLineDetails.value) return;
  lineDetail.value = line;
  lineDetailNodeName.value = group.node_name || group.node_id;
  lineDetailError.value = "";
  lineApprovals.value = [];
  lineUsersError.value = "";
  lineUserAdd.value = "";
  lineDetailOpen.value = true;
  lineDetailBusy.value = true;
  try {
    const result = await pluginCall<{ line: Line }>(SERVICES.lines, "get", { line_hash_id: line.line_hash_id });
    if (result.line) lineDetail.value = result.line;
  } catch (cause) {
    lineDetailError.value = safeErrorMessage(cause, "Line details are unavailable");
  } finally {
    lineDetailBusy.value = false;
  }
  // Best effort: the on-node user section lists bound identities.
  try {
    await ensureUsersLoaded();
    usersUnavailable.value = false;
  } catch {
    // Not `users = []`. An empty list renders as "No identities bound to this
    // line yet", which is a claim about the line, not about the request that
    // failed. Keep whatever was already loaded and say the list is unavailable.
    usersUnavailable.value = true;
  }
}

function closeLineDetails(): void {
  lineDetailOpen.value = false;
  lineDetailBusy.value = false;
  lineDetailError.value = "";
  lineDetail.value = undefined;
  lineDetailNodeName.value = "";
}

// ── On-node line users (design-15 D3, managed + adopted tracks) ───────────────
// Every action queues a reviewed plan; nothing reaches the node until approval.
const lineUsersBusy = ref(false);
const lineUsersError = ref("");
const lineUserAdd = ref("");
const lineApprovals = ref<{ id: string; summary: string }[]>([]);

const lineDetailBoundUsers = computed(() => {
  const line = lineDetail.value;
  if (!line) return [] as VpnUser[];
  return users.value.filter((user) => user.bindings.some((binding) => binding.line_hash_id === line.line_hash_id && binding.enabled));
});
const lineDetailBindableUsers = computed(() => {
  const line = lineDetail.value;
  if (!line) return [] as VpnUser[];
  return users.value.filter((user) => user.enabled && !user.bindings.some((binding) => binding.line_hash_id === line.line_hash_id));
});

async function ensureUsersLoaded(): Promise<void> {
  if (users.value.length || !canCall(init.value, SERVICES.users, "list")) return;
  const result = await pluginCall<{ users: VpnUser[] }>(SERVICES.users, "list");
  users.value = result.users ?? [];
}

interface LinePlanResult {
  approval?: { id: string; plan?: string };
}

function recordLineApproval(result: LinePlanResult, fallback: string): void {
  let summary = fallback;
  try {
    summary = JSON.parse(result.approval?.plan ?? "{}").summary ?? fallback;
  } catch {
    summary = fallback;
  }
  if (result.approval?.id) lineApprovals.value = [{ id: result.approval.id, summary }, ...lineApprovals.value];
}

async function planLineUser(op: "plan_add" | "plan_update" | "plan_remove", userId: string): Promise<void> {
  const line = lineDetail.value;
  if (!line || lineUsersBusy.value) return;
  lineUsersBusy.value = true;
  lineUsersError.value = "";
  try {
    const result = await pluginCall<LinePlanResult>(SERVICES.admin, op, { user_id: userId, line_hash_id: line.line_hash_id });
    recordLineApproval(result, op === "plan_add" ? "queue user add" : op === "plan_update" ? "queue user update" : "queue user remove");
    notice.value = "On-node action queued. Approve it in the Approvals console, then rediscover";
    await loadCurrent(true);
  } catch (cause) {
    lineUsersError.value = safeErrorMessage(cause, "The on-node action could not be planned");
  } finally {
    lineUsersBusy.value = false;
  }
}

async function bindAndApplyToLine(): Promise<void> {
  const line = lineDetail.value;
  if (!line || !lineUserAdd.value || lineUsersBusy.value) return;
  const userId = lineUserAdd.value;
  await planLineUser("plan_add", userId);
  lineUserAdd.value = "";
}

const syncBusy = ref(false);
const reattachUUID = ref("");
const reattachBusy = ref(false);

async function syncSidecar(): Promise<void> {
  const line = lineDetail.value;
  if (!line || syncBusy.value) return;
  syncBusy.value = true;
  lineUsersError.value = "";
  try {
    const result = await pluginCall<LinePlanResult>(SERVICES.lines, "sync_metadata", { node_id: line.node_id });
    recordLineApproval(result, "queue sidecar sync");
    notice.value = "Sidecar sync queued. Approve it in the Approvals console";
  } catch (cause) {
    lineUsersError.value = safeErrorMessage(cause, "Sidecar sync could not be queued");
  } finally {
    syncBusy.value = false;
  }
}

async function reattachLineUUID(): Promise<void> {
  const line = lineDetail.value;
  const next = reattachUUID.value.trim();
  if (!line || !next || reattachBusy.value) return;
  reattachBusy.value = true;
  lineUsersError.value = "";
  try {
    await pluginCall(SERVICES.lines, "reattach", { line_hash_id: line.line_hash_id, line_uuid: next });
    notice.value = "Line identity reattached in the control plane. The node still holds the old identity until you sync it, using the button above.";
    reattachUUID.value = "";
    await loadCurrent(true);
    const refreshed = await pluginCall<{ line: Line }>(SERVICES.lines, "get", { line_hash_id: line.line_hash_id });
    if (refreshed.line) lineDetail.value = refreshed.line;
  } catch (cause) {
    lineUsersError.value = safeErrorMessage(cause, "Line identity could not be reattached");
  } finally {
    reattachBusy.value = false;
  }
}

// ── Credential rotation (one-time reveal) ────────────────────────────────────
const rotateUser = ref<VpnUser>();
const rotateProtocol = ref("");
const rotateBusy = ref(false);
const rotateRevealed = ref<{ email: string; protocol: string; secret: string }>();

function openRotate(user: VpnUser): void {
  rotateUser.value = user;
  rotateProtocol.value = user.credentials[0]?.protocol ?? "";
}

async function rotateCredential(): Promise<void> {
  if (!rotateUser.value || !rotateProtocol.value || rotateBusy.value) return;
  rotateBusy.value = true;
  try {
    const result = await pluginCall<{ protocol: string; revealed_credential: string }>(
      SERVICES.admin, "rotate", { user_id: rotateUser.value.id, protocol: rotateProtocol.value });
    rotateRevealed.value = { email: rotateUser.value.email, protocol: result.protocol, secret: result.revealed_credential };
    rotateUser.value = undefined;
    notice.value = `${result.protocol} credential rotated. Re-apply it to its lines to take effect on nodes`;
    await loadCurrent(true);
  } catch (cause) {
    error.value = safeErrorMessage(cause, "Credential could not be rotated");
  } finally {
    rotateBusy.value = false;
  }
}


const profileSettingsOpen = ref(false);
const profileSettingsBusy = ref(false);
const profileSettingsSaving = ref(false);
const profileSettingsError = ref("");
const profileSettings = ref<ProfileSettings>();
const profileReconfigureCommand = ref("");
const profileForm = reactive<ProfilePluginConfig>({
  singbox_discover: false,
  singbox_bin: "",
  proxy_usage_file: "",
  proxy_usage_url: "",
  proxy_usage_xray_api: "",
  proxy_usage_xray_bin: "",
  proxy_usage_xray_pattern: "",
  singbox_stats_api: "",
});

function applyProfileSettings(value: ProfileSettings): void {
  profileSettings.value = value;
  Object.assign(profileForm, {
    singbox_discover: value.saved.singbox_discover,
    singbox_bin: value.saved.singbox_bin ?? "",
    proxy_usage_file: value.saved.proxy_usage_file ?? "",
    proxy_usage_url: value.saved.proxy_usage_url ?? "",
    proxy_usage_xray_api: value.saved.proxy_usage_xray_api ?? "",
    proxy_usage_xray_bin: value.saved.proxy_usage_xray_bin ?? "",
    proxy_usage_xray_pattern: value.saved.proxy_usage_xray_pattern ?? "",
    singbox_stats_api: value.saved.singbox_stats_api ?? "",
  });
}

async function openProfileSettings(profile: Profile): Promise<void> {
  if (!canReadProfileSettings.value || profileSettingsBusy.value) return;
  profileSettingsOpen.value = true;
  profileSettingsBusy.value = true;
  profileSettingsError.value = "";
  profileReconfigureCommand.value = "";
  try {
    const result = await pluginCall<ProfileSettings>(SERVICES.profiles, "settings", { node_id: profile.node_id });
    applyProfileSettings(result);
  } catch (cause) {
    profileSettingsError.value = safeErrorMessage(cause, "Node settings are unavailable");
  } finally {
    profileSettingsBusy.value = false;
  }
}

function closeProfileSettings(): void {
  profileSettingsOpen.value = false;
  profileSettingsBusy.value = false;
  profileSettingsSaving.value = false;
  profileSettingsError.value = "";
  profileSettings.value = undefined;
  profileReconfigureCommand.value = "";
}

async function saveProfileSettings(): Promise<void> {
  if (!profileSettings.value || !canConfigureProfile.value || profileSettingsSaving.value) return;
  profileSettingsSaving.value = true;
  profileSettingsError.value = "";
  profileReconfigureCommand.value = "";
  try {
    const result = await pluginCall<{
      command?: string;
      settings: ProfileSettings;
    }>(SERVICES.profiles, "configure", {
      node_id: profileSettings.value.node_id,
      ...profileForm,
    });
    applyProfileSettings(result.settings);
    profileReconfigureCommand.value = result.command ?? "";
    notice.value = `Settings saved for ${profileSettings.value.node_name || profileSettings.value.node_id}. If a reconfigure command is shown, that node keeps running the old settings until someone runs it there.`;
    await loadCurrent(true);
  } catch (cause) {
    profileSettingsError.value = safeErrorMessage(cause, "Node settings could not be saved");
  } finally {
    profileSettingsSaving.value = false;
  }
}

// ── overlays ─────────────────────────────────────────────────────────────
// The frame is a viewport, so an overlay is centred against the window in CSS
// and the document-coordinate anchor in src/overlayAnchor.ts is inert.
// Whether the current route has anything to show. An empty screen after a
// failed call is not an empty fleet, and telling the operator to go configure
// discovery when the request 503'd sends them after the wrong problem.
const hasRouteData = computed(() => ({
  lines: allLines.value.length > 0,
  users: users.value.length > 0,
  profiles: profiles.value.length > 0,
  usage: usage.value.by_user.length > 0 || usage.value.by_node.length > 0 || usage.value.rows.length > 0 || usage.value.collectors.length > 0,
}[route.value] ?? false));

const overlayAnchorTop = ref(MIN_ANCHOR_TOP);
const overlayStyle = computed(() => ({ "--overlay-anchor-top": `${overlayAnchorTop.value}px` }));

// Which overlay is open, not merely whether one is. Rotating a credential
// closes the confirm dialog and opens the reveal in the same tick; a boolean
// stays true across that swap, so the reveal would never be focused or
// clamped. A changing key fires the watcher on every handover.
const openOverlayKey = computed(() => {
  if (rotateRevealed.value) return "rotate-revealed";
  if (deleteTarget.value) return "delete";
  if (rotateUser.value) return "rotate";
  if (bindingUser.value) return "bindings";
  if (rolloutOpen.value) return "rollout";
  if (userDialogOpen.value) return "user";
  if (profileSettingsOpen.value) return "profile-settings";
  if (lineDetailOpen.value) return "line-detail";
  return "";
});
const overlayOpen = computed(() => openOverlayKey.value !== "");

function recordAnchor(event: Event): void {
  // A click inside an open overlay must not move the anchor, or the next one
  // opens against a place the operator never pointed at.
  if (overlayOpen.value || isInsideOverlay(event.target)) return;
  overlayAnchorTop.value = anchorTopFrom(event);
}

function closeTopOverlay(): void {
  // rotateRevealed is deliberately not dismissible here: it is the one-time
  // display of a secret, and losing it to a stray Escape means rotating again.
  if (deleteTarget.value) deleteTarget.value = undefined;
  else if (rotateUser.value) rotateUser.value = undefined;
  else if (bindingUser.value) bindingUser.value = undefined;
  else if (rolloutOpen.value) closeRollout();
  else if (userDialogOpen.value) userDialogOpen.value = false;
  else if (profileSettingsOpen.value) closeProfileSettings();
  else if (lineDetailOpen.value) closeLineDetails();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && overlayOpen.value) closeTopOverlay();
}

watch(openOverlayKey, async (key) => {
  if (!key) return;
  await nextTick();
  const panel = document.querySelector<HTMLElement>(".overlay-scrim .modal");
  if (!panel) return;
  // Clamp only once the real height is known; clamping against a guessed
  // height pushes short dialogs up for no reason.
  overlayAnchorTop.value = clampAnchorTop(overlayAnchorTop.value, panel.offsetHeight, document.documentElement.scrollHeight);
  // Escape only reaches a focused element, and a dialog the operator cannot
  // dismiss with Escape is the worst one to get wrong.
  panel.focus();
});

// Nothing here measures this document's height. The host frame is a viewport
// the host sizes itself, so a page that reported its own height was running a
// full synchronous layout of an 8800px document on every body resize and
// throwing the answer away.
onMounted(() => {
  document.addEventListener("pointerdown", recordAnchor, true);
  window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", recordAnchor, true);
  window.removeEventListener("keydown", onKeydown);
  bridge?.dispose();
});
</script>

<template>
  <main class="workspace">
    <header class="page-header">
      <div class="title-mark"><component :is="routeMeta.icon" :size="19" aria-hidden="true" /></div>
      <div class="title-copy">
        <div class="title-line"><h1>{{ routeMeta.title }}</h1><span class="plugin-label">VPN Core plugin</span></div>
        <p>{{ routeMeta.description }}</p>
      </div>
      <button class="button button-secondary" type="button" :disabled="loading || refreshing" @click="loadCurrent(true)">
        <LoaderCircle v-if="refreshing" class="spin" :size="15" aria-hidden="true" />
        <RefreshCw v-else :size="15" aria-hidden="true" />
        Refresh
      </button>
    </header>

    <div v-if="bootError || error" class="alert" role="alert">
      <CircleAlert :size="17" aria-hidden="true" />
      <span><strong>{{ bootError ? 'This page has no console session' : `${routeMeta.title} did not fully load` }}</strong>{{ bootError || error }}</span>
      <button v-if="!bootError" class="button button-secondary button-compact" type="button" :disabled="refreshing" @click="loadCurrent(true)">
        <LoaderCircle v-if="refreshing" class="spin" :size="13" aria-hidden="true" /> Try again
      </button>
      <button class="icon-button" type="button" aria-label="Dismiss error" title="Dismiss error" @click="error = ''; bootError = ''"><X :size="15" /></button>
    </div>
    <div v-if="notice" class="alert alert-success" aria-live="polite">
      <ShieldCheck :size="17" aria-hidden="true" /><span>{{ notice }}</span>
      <button class="icon-button" type="button" aria-label="Dismiss notice" title="Dismiss notice" @click="notice = ''"><X :size="15" /></button>
    </div>

    <div v-if="loading" class="stack" role="status" :aria-label="`Loading ${routeMeta.title.toLowerCase()}`">
      <div class="skeleton-strip" aria-hidden="true">
        <div v-for="cell in 4" :key="cell"><span class="skeleton-bar short" /><span class="skeleton-bar tall" /></div>
      </div>
      <div class="data-panel" aria-hidden="true">
        <div class="skeleton-rows">
          <div v-for="row in 8" :key="row">
            <span class="skeleton-bar" /><span class="skeleton-bar short" /><span class="skeleton-bar short" /><span class="skeleton-bar short" />
          </div>
        </div>
      </div>
      <p class="empty-inline"><LoaderCircle class="spin" :size="14" /> Loading {{ routeMeta.title.toLowerCase() }}</p>
    </div>

    <div v-else-if="(bootError || error) && !hasRouteData" class="empty-state">
      <CircleAlert :size="26" aria-hidden="true" />
      <strong>Nothing could be loaded</strong>
      <p>This is not an empty fleet, it is an unanswered question. The message above says what stopped it.</p>
      <div v-if="!bootError" class="empty-actions"><button class="button button-secondary" type="button" :disabled="refreshing" @click="loadCurrent(true)"><RefreshCw :size="15" aria-hidden="true" /> Try again</button></div>
    </div>

    <template v-else-if="route === 'lines'">
      <p class="proof-line" aria-live="polite">
        <span v-if="refreshedAt">observed at {{ observedAtLabel }}</span>
        <span v-else>not observed yet</span>
        <span>· {{ fleetSummary.nodes }} {{ fleetSummary.nodes === 1 ? 'node reports' : 'nodes report' }}</span>
        <span>· {{ livenessLine }}</span>
        <span v-if="refreshing">· refreshing</span>
      </p>
      <section class="summary-strip" aria-label="Line summary" style="--stat-count: 5">
        <div><span>Lines</span><strong>{{ fleetSummary.lines }}</strong><small>{{ fleetSummary.configErrors ? `${fleetSummary.configErrors} reporting a config error` : 'none reporting a config error' }}</small></div>
        <div :data-tone="fleetSummary.lines && !fleetSummary.managed ? 'warning' : undefined"><span>Lattice-managed</span><strong>{{ fleetSummary.managed }}</strong><small>{{ fleetSummary.lines - fleetSummary.managed }} discovered only</small></div>
        <div><span>Roles</span><strong>{{ fleetSummary.relays }} relay · {{ fleetSummary.exits }} exit</strong><small>{{ fleetSummary.orphans ? `${fleetSummary.orphans} with no outbound` : 'every line has an outbound' }}</small></div>
        <div><span>Nodes</span><strong>{{ fleetSummary.nodes }}</strong><small v-if="canReadManaged">{{ overlayStats.covered }} of {{ overlayStats.total }} carry a managed line</small></div>
        <div :data-tone="fleetSummary.service.down ? 'error' : fleetSummary.service.reported ? undefined : liveness.unprovenNodes ? 'warning' : 'neutral'">
          <span>Service</span>
          <strong v-if="fleetSummary.service.reported">{{ fleetSummary.service.running }} running<template v-if="fleetSummary.service.down"> · {{ fleetSummary.service.down }} down</template></strong>
          <strong v-else-if="liveness.unprovenNodes">unproven</strong>
          <strong v-else>not reported</strong>
          <small v-if="fleetSummary.service.reported">{{ fleetSummary.service.unknown ? `${fleetSummary.service.unknown} lines not reported` : 'every line reported' }}</small>
          <small v-else-if="liveness.unprovenNodes">{{ liveness.refusedPath ? `the probe refused ${liveness.refusedPath} on ${liveness.unprovenNodes} nodes` : `the probe could not prove it on ${liveness.unprovenNodes} nodes` }}</small>
          <small v-else>config verdict only; the probe ships with agent 0.3.9</small>
        </div>
      </section>
      <section class="toolbar">
        <div class="lens-switch" role="tablist" aria-label="Lines lens">
          <button class="lens-tab" role="tab" type="button" :aria-selected="lens === 'fleet'" @click="lens = 'fleet'">Fleet</button>
          <button class="lens-tab" role="tab" type="button" :aria-selected="lens === 'topology'" @click="lens = 'topology'">Topology</button>
          <button class="lens-tab" role="tab" type="button" :aria-selected="lens === 'attention'" @click="lens = 'attention'">
            Attention<span v-if="attention.length" class="lens-count" :data-tone="attentionTone">{{ attention.length }}</span>
          </button>
        </div>
        <input v-model="search" class="search-input" type="search" aria-label="Search lines" placeholder="Search node, line, endpoint, outbound or error" />
        <span v-if="searching" class="permission-note">{{ nodeRows.length }} of {{ lines.length }} nodes match</span>
        <span class="toolbar-spacer" />
        <button v-if="canRollout" class="button button-primary" type="button" @click="openRollout"><Plus :size="15" /> Roll out managed lines</button>
      </section>
      <section v-if="unresolvedDefs.length" class="data-panel overlay-strip" aria-label="Managed line rollout status">
        <div v-for="def in unresolvedDefs" :key="def.line_uuid" class="overlay-def">
          <span class="badge" :data-tone="overlayTone(def.status)">{{ def.status }}</span>
          <strong>{{ def.node_id }}</strong>
          <span class="mono">{{ def.tag }} · :{{ def.port }}</span>
          <span v-if="def.last_error" class="error-text">{{ def.last_error }}</span>
          <span v-else-if="def.status === 'planned'" class="muted">awaiting approval</span>
        </div>
      </section>

      <section v-if="lens === 'fleet'" class="data-panel fleet-panel" role="tabpanel">
        <header class="panel-header">
          <div><h2>Fleet</h2><p>Every node that reports an inbound, with its lines folded underneath. A bank is a set of relay lines of one protocol that all dial out.</p></div>
          <span class="count">{{ nodeRows.length }} {{ nodeRows.length === 1 ? 'node' : 'nodes' }} · {{ fleetSummary.lines }} lines</span>
        </header>
        <div v-if="nodeRows.length" class="table-wrap"><table class="fleet-table">
          <thead><tr>
            <th class="fleet-name">Node / line</th>
            <th>Role</th>
            <th>Endpoint</th>
            <th>Reality SNI</th>
            <th class="num">Users</th>
            <th>Outbound</th>
            <th>Config</th>
            <th>Service</th>
            <th v-if="canViewLineDetails" class="actions-cell">Actions</th>
          </tr></thead>
          <tbody v-for="row in nodePageData.rows" :key="row.group.node_id" :data-open="nodeOpen(row) ? 'true' : 'false'">
            <tr class="node-row">
              <td class="fleet-name">
                <button class="node-toggle" type="button" :aria-expanded="nodeOpen(row)" :aria-controls="`node-${row.group.node_id}`" @click="toggleNode(row.group.node_id)">
                  <ChevronRight class="node-chevron" :size="14" aria-hidden="true" />
                  <strong :title="row.group.node_name || row.group.node_id">{{ row.group.node_name || row.group.node_id }}</strong>
                </button>
                <small :title="row.group.node_id">{{ row.group.node_id }}</small>
                <!-- On a phone the verdict columns sit off to the right; the
                     red state has to be readable without a sideways scroll. -->
                <span class="narrow-status">
                  <span class="status-dot" :data-tone="row.config">{{ row.config === 'healthy' ? 'ok' : row.config }}</span>
                  <span class="badge" :data-tone="serviceTone(row.service)" :title="nodeServiceTitle(row)">{{ nodeServiceLabel(row) }}</span>
                </span>
              </td>
              <td colspan="5" class="node-summary">
                <span>{{ row.lines.length }} {{ row.lines.length === 1 ? 'line' : 'lines' }}</span>
                <span v-if="row.counts.relays">· {{ row.counts.relays }} relay</span>
                <span v-if="row.counts.exits">· {{ row.counts.exits }} exit</span>
                <span v-if="row.counts.orphans" class="error-text">· {{ row.counts.orphans }} with no outbound</span>
                <span v-if="row.counts.managed">· {{ row.counts.managed }} managed</span>
                <span v-for="bank in row.banks" :key="bank.key" class="muted">· bank of {{ bank.lines.length }} {{ bank.type }} → {{ bank.targetNodeIDs.length }} {{ bank.targetNodeIDs.length === 1 ? 'node' : 'nodes' }}</span>
              </td>
              <td><span class="status-dot" :data-tone="row.config">{{ row.config === 'healthy' ? 'ok' : row.config }}</span></td>
              <td><span class="badge" :data-tone="serviceTone(row.service)" :title="nodeServiceTitle(row)">{{ nodeServiceLabel(row) }}</span></td>
              <td v-if="canViewLineDetails" class="actions-cell">
                <button v-if="canOpenEvidence" class="button button-secondary button-compact" type="button" :title="`Connections observed on ${row.group.node_name || row.group.node_id}`" @click="openEvidence(row.group.node_id, 'connections')"><Waypoints :size="13" aria-hidden="true" /> Evidence</button>
              </td>
            </tr>
            <template v-if="nodeOpen(row)">
              <template v-for="entry in fleetEntries(row)" :key="entry.kind === 'bank' ? entry.bank.key : entry.line.line_hash_id">
                <tr v-if="entry.kind === 'bank'" class="bank-row" :id="`node-${row.group.node_id}`">
                  <td class="fleet-name">
                    <button class="node-toggle bank-toggle" type="button" :aria-expanded="bankOpen(entry.bank)" @click="toggleBank(entry.bank.key)">
                      <ChevronRight class="node-chevron" :size="14" aria-hidden="true" />
                      <strong>{{ entry.bank.lines.length }} {{ entry.bank.type }} relays</strong>
                    </button>
                    <small class="mono">ports {{ entry.bank.portRange.min }} to {{ entry.bank.portRange.max }}</small>
                  </td>
                  <td><span class="badge" data-tone="info">bank</span></td>
                  <td class="mono endpoint-cell">{{ formatLineEndpoint(entry.bank.lines[0]).split(':')[0] }}<small>{{ entry.bank.lines.length }} listeners, ports {{ entry.bank.portRange.min }} to {{ entry.bank.portRange.max }}</small></td>
                  <td class="mono">{{ formatLineDomain(entry.bank.lines[0]) }}</td>
                  <td class="num">{{ entry.bank.lines.reduce((sum, line) => sum + (line.user_known ? line.user_count : 0), 0) }}</td>
                  <td :title="bankTargets(entry.bank)">→ {{ entry.bank.targetNodeIDs.length }} {{ entry.bank.targetNodeIDs.length === 1 ? 'node' : 'nodes' }}<small>{{ bankTargets(entry.bank) }}</small></td>
                  <td><span class="status-dot" :data-tone="entry.bank.config">{{ entry.bank.config === 'healthy' ? 'ok' : entry.bank.config }}</span></td>
                  <td><span class="badge" :data-tone="serviceTone(entry.bank.service)">{{ serviceLabel(entry.bank.service) }}</span></td>
                  <td v-if="canViewLineDetails" class="actions-cell" />
                </tr>
                <tr v-else class="line-row" :class="{ 'line-in-bank': !!entry.bank }">
                  <td class="fleet-name">
                    <strong :title="entry.line.name">{{ entry.line.name }}</strong>
                    <small :title="`${entry.line.type || 'unknown'} / ${entry.line.line_hash_id}`">{{ entry.line.type || 'unknown' }} / {{ entry.line.line_hash_id }}</small>
                    <span class="narrow-status">
                      <span class="mono">:{{ entry.line.listen_port || '?' }}</span>
                      <span class="status-dot" :data-tone="lineStatus(entry.line)">{{ entry.line.status || (entry.line.last_error ? 'error' : 'not reported') }}</span>
                      <span class="badge" :data-tone="lineServiceTone(entry.line)" :title="lineServiceTitle(entry.line)">{{ lineServiceLabel(entry.line) }}</span>
                    </span>
                  </td>
                  <td><span class="badge" :data-tone="lineRole(entry.line) === 'orphan' ? 'error' : 'neutral'">{{ roleLabel(entry.line) }}</span><span v-if="entry.line.managed" class="badge" data-tone="info" :title="entry.line.overlay_user ? `Bound account: ${entry.line.overlay_user}` : lineOwnership(entry.line)">{{ entry.line.overlay ? 'lattice-managed' : lineOwnership(entry.line) }}</span></td>
                  <!-- The port is the distinguishing value on a node that
                       carries twelve lines of one host; it leads. -->
                  <td class="mono endpoint-cell" :title="`public ${formatLineEndpoint(entry.line)}, listen ${formatLineListen(entry.line)}`"><span class="endpoint-port">:{{ entry.line.listen_port || '?' }}</span> {{ formatLineEndpoint(entry.line).split(':')[0] }}<small>listen {{ formatLineListen(entry.line) }}</small></td>
                  <td class="mono" :title="formatLineDomain(entry.line)">{{ formatLineDomain(entry.line) }}</td>
                  <td class="num" :title="entry.line.user_known ? undefined : 'The node did not report a user count for this line'">{{ entry.line.user_known ? entry.line.user_count : 'unknown' }}</td>
                  <td class="mono outbound-cell" :title="entry.line.outbound_ref || undefined">{{ entry.line.outbound_ref || '-' }}<small v-if="entry.line.outbound_server">{{ entry.line.outbound_server }}<span v-if="entry.line.outbound_port">:{{ entry.line.outbound_port }}</span></small></td>
                  <td><span class="status-dot" :data-tone="lineStatus(entry.line)" :title="entry.line.status || (entry.line.last_error ? 'error' : 'not reported')">{{ entry.line.status || (entry.line.last_error ? 'error' : 'not reported') }}</span><small v-if="entry.line.last_error" class="error-text" :title="lineErrorText(entry.line)">{{ lineErrorText(entry.line) }}</small></td>
                  <td><span class="badge" :data-tone="lineServiceTone(entry.line)" :title="lineServiceTitle(entry.line)">{{ lineServiceLabel(entry.line) }}</span></td>
                  <td v-if="canViewLineDetails" class="actions-cell">
                    <div class="row-actions">
                      <button class="button button-secondary button-compact" type="button" @click="openLineDetails(row.group, entry.line)">Details</button>
                      <button v-if="canOpenEvidence" class="icon-button bordered" type="button" :aria-label="`Connections through ${entry.line.name}`" :title="`Connections through ${entry.line.name}`" @click="openEvidence(row.group.node_id, 'connections', entry.line)"><Waypoints :size="14" aria-hidden="true" /></button>
                    </div>
                  </td>
                </tr>
              </template>
            </template>
          </tbody>
        </table></div>
        <div v-else-if="searching" class="empty-state">
          <Radar :size="26" aria-hidden="true" />
          <strong>No line matches that search</strong>
          <p>Nothing in {{ fleetSummary.lines }} lines across {{ lines.length }} nodes matches <span class="mono">{{ search.trim() }}</span>. The search covers node, line name, protocol, host, status, outbound reference and error text.</p>
          <div class="empty-actions"><button class="button button-secondary" type="button" @click="search = ''">Clear the search</button></div>
        </div>
        <div v-else class="empty-state">
          <Radar :size="26" aria-hidden="true" />
          <strong>No lines are visible yet</strong>
          <p>A line appears once a node agent reports its inbounds. If nodes are online and this stays empty, the usual causes are in this order:</p>
          <ol>
            <li>The node profile has sing-box discovery switched off. Turn it on under Node Profiles.</li>
            <li>The agent cannot run the manager binary, so it has nothing to read. Check task execution on the profile.</li>
            <li>The node has no inbound configured at all.</li>
          </ol>
        </div>
        <footer v-if="nodePageData.pages > 1" class="table-pagination" aria-label="Fleet pagination">
          <span>Nodes {{ nodePageData.from }} to {{ nodePageData.to }} of {{ nodePageData.total }}, searched across every one of them</span>
          <button class="button button-secondary button-compact" type="button" :disabled="nodePageData.page === 1" @click="nodePage = nodePageData.page - 1">Previous</button>
          <span>Page {{ nodePageData.page }} of {{ nodePageData.pages }}</span>
          <button class="button button-secondary button-compact" type="button" :disabled="nodePageData.page === nodePageData.pages" @click="nodePage = nodePageData.page + 1">Next</button>
        </footer>
      </section>

      <template v-else-if="lens === 'topology'">
        <LineChainWorkspace v-if="canReadChains" :groups="lines" :chains="chains" :can-plan="canPlanChain" :can-remove="canPlanRemoveChain" :busy-sources="busyChainSources" @plan="planLineChain" @remove="planLineChainRemoval" />
        <section v-else class="data-panel" role="tabpanel">
          <div class="empty-state">
            <Radar :size="26" aria-hidden="true" />
            <strong>This session cannot read chains</strong>
            <p>The topology lens needs <span class="mono">lines.chains</span>, which this session's token does not carry. The fleet lens still shows every line and its outbound.</p>
          </div>
        </section>
      </template>

      <section v-else class="data-panel attention-panel" role="tabpanel">
        <header class="panel-header">
          <div><h2>Attention</h2><p>Every claim this page can prove that needs a hand, with the row that proves it and the action that clears it.</p></div>
          <span class="count">{{ attention.length }} {{ attention.length === 1 ? 'item' : 'items' }}</span>
        </header>
        <ol v-if="attention.length" class="attention-list">
          <li v-for="item in attention" :key="item.key" class="attention-item" :data-severity="item.severity">
            <span class="status-dot" :data-tone="item.severity === 'error' ? 'error' : item.severity === 'warning' ? 'warning' : 'neutral'">{{ item.severity }}</span>
            <div class="attention-body">
              <strong>{{ item.claim }}</strong>
              <p>{{ item.evidence }}</p>
            </div>
            <div class="attention-actions">
              <button v-if="item.action === 'details' && canViewLineDetails" class="button button-secondary button-compact" type="button" @click="openAttention(item)">Details</button>
              <button v-else-if="item.action === 'rollout' && canRollout" class="button button-secondary button-compact" type="button" @click="openAttention(item)">Roll out</button>
              <button v-else-if="item.action === 'profiles' && canOpenEvidence" class="button button-secondary button-compact" type="button" title="Open Node Profiles, where each node's sing-box integration is configured" @click="openAttention(item)">Node Profiles</button>
              <span v-else-if="item.action === 'profiles'" class="muted">Node Profiles, in this plugin's navigation</span>
            </div>
          </li>
        </ol>
        <div v-else class="empty-state">
          <Radar :size="26" aria-hidden="true" />
          <strong>Nothing needs attention</strong>
          <p>Every line reports a clean config, every relay resolves to a fleet endpoint, and the lines that report liveness are running.</p>
        </div>
      </section>
    </template>

    <template v-else-if="route === 'users'">
      <section class="summary-strip" aria-label="User summary">
        <div><span>Identities</span><strong>{{ users.length }}</strong></div>
        <div><span>Enabled</span><strong>{{ enabledUsers }}</strong></div>
        <div><span>Bindings</span><strong>{{ totalBindings }}</strong></div>
        <div><span>Protocols</span><strong>{{ new Set(users.flatMap((user) => user.credentials.map((credential) => credential.protocol))).size }}</strong></div>
      </section>
      <section class="toolbar toolbar-end">
        <span v-if="!hasUserMutations" class="permission-note"><KeyRound :size="14" /> Read-only session</span>
        <button v-if="canCreateUser" class="button button-primary" type="button" @click="openCreateUser"><Plus :size="15" /> New identity</button>
      </section>
      <section class="data-panel"><div v-if="users.length" class="table-wrap"><table><thead><tr><th>Identity</th><th>Status</th><th>Credentials</th><th>Bindings</th><th>Quota</th><th>Expires</th><th v-if="showUserActions" class="actions-cell">Actions</th></tr></thead>
        <tbody><tr v-for="user in users" :key="user.id">
          <td><strong>{{ user.email }}</strong><small>{{ user.name || user.id }}<span v-if="user.migrated"> / migrated</span></small></td>
          <td><span class="status-dot" :data-tone="user.enabled ? 'healthy' : 'warning'">{{ user.enabled ? 'enabled' : 'disabled' }}</span></td>
          <td><span v-for="credential in user.credentials" :key="credential.protocol" class="badge credential">{{ credential.protocol }}<KeyRound v-if="credential.has_secret" :size="11" /></span><span v-if="!user.credentials.length">-</span></td>
          <td>{{ user.bindings.length }}</td><td>{{ user.quota_bytes ? formatBytes(user.quota_bytes) : 'No quota set' }}</td><td>{{ formatDate(user.expires_at) }}</td>
          <td v-if="showUserActions" class="actions-cell"><div class="icon-actions">
            <button v-if="canUpdateUser" class="icon-button bordered" type="button" aria-label="Edit identity" title="Edit identity" @click="openEditUser(user)"><Pencil :size="14" /></button>
            <button v-if="canRotateCredentials && user.credentials.length" class="icon-button bordered" type="button" aria-label="Rotate a credential" title="Rotate a credential" @click="openRotate(user)"><KeyRound :size="14" /></button>
            <button v-if="canBindUser || canUnbindUser" class="icon-button bordered" type="button" aria-label="Manage line bindings" title="Manage line bindings" @click="bindingUser = user"><Link2 :size="14" /></button>
            <button v-if="canDeleteUser" class="icon-button bordered destructive" type="button" aria-label="Delete identity" title="Delete identity" @click="deleteTarget = user"><Trash2 :size="14" /></button>
          </div></td>
        </tr></tbody></table></div>
        <div v-else class="empty-state">
          <UserRound :size="26" aria-hidden="true" />
          <strong>No VPN identities yet</strong>
          <p>An identity holds the protocol credential and the set of lines it may use. Nothing on a node changes when one is created: binding an identity to a line files an approval, and the node is only touched once that approval is granted.</p>
          <div v-if="canCreateUser" class="empty-actions"><button class="button button-primary" type="button" @click="openCreateUser"><Plus :size="15" /> Create the first identity</button></div>
          <p v-else class="empty-inline">This session cannot create identities.</p>
        </div>
      </section>
    </template>

    <template v-else-if="route === 'profiles'">
      <section class="summary-strip" aria-label="Profile summary">
        <div><span>Profiles</span><strong>{{ profiles.length }}</strong></div>
        <div><span>Managed</span><strong>{{ profiles.filter((profile) => profile.managed).length }}</strong></div>
        <div><span>Applied</span><strong>{{ profiles.filter((profile) => profile.applied).length }}</strong></div>
        <div><span>Runtime errors</span><strong>{{ profiles.filter((profile) => profile.last_error || profile.discovery_error || profile.collector?.status === 'error').length }}</strong></div>
      </section>
      <section class="data-panel"><div v-if="profiles.length" class="table-wrap"><table><thead><tr><th>Node</th><th>Core</th><th>Ownership</th><th>Inbounds</th><th>Discovered</th><th>Collector</th><th>Runtime path</th><th v-if="canReadProfileSettings" class="actions-cell">Actions</th></tr></thead>
        <tbody><tr v-for="profile in profiles" :key="profile.node_id">
          <td><strong>{{ profile.node_name || profile.node_id }}</strong><small>{{ profile.node_id }}</small></td>
          <td><span class="badge">{{ profile.core || 'unknown' }} {{ profile.core_version || '' }}</span></td>
          <td><span class="status-dot" :data-tone="profile.applied ? 'healthy' : profile.managed ? 'warning' : 'neutral'">{{ profile.managed ? (profile.applied ? 'managed / applied' : 'managed / pending') : 'observed' }}</span></td>
          <td>{{ profile.inbound_count }}</td><td>{{ profile.discovered_count }}</td>
          <td><span class="status-dot" :data-tone="profile.collector?.status === 'error' ? 'error' : profile.collector?.status === 'ok' ? 'healthy' : 'neutral'">{{ profile.collector?.status || 'not reported' }}</span></td>
          <td class="mono path-cell">{{ profile.config_path || '-' }}<small v-if="profile.last_error || profile.discovery_error" class="error-text">{{ profile.last_error || profile.discovery_error }}</small></td>
          <td v-if="canReadProfileSettings" class="actions-cell"><button class="icon-button bordered" type="button" aria-label="Configure sing-box integration" title="Configure sing-box integration" @click="openProfileSettings(profile)"><Pencil :size="14" /></button></td>
        </tr></tbody></table></div>
        <div v-else class="empty-state">
          <ServerCog :size="26" aria-hidden="true" />
          <strong>No node profiles</strong>
          <p>A profile appears once a node either runs a Lattice-managed core or reports a discovery result. If the fleet has nodes but this is empty, their agents have not reported a sing-box or Xray runtime yet.</p>
        </div>
      </section>
    </template>

    <template v-else-if="route === 'usage'">
      <section class="summary-strip" aria-label="Usage summary"><div><span>Tracked users</span><strong>{{ usage.by_user.length }}</strong></div><div><span>Traffic</span><strong>{{ formatBytes(totalTraffic) }}</strong></div><div><span>Reporting nodes</span><strong>{{ usage.by_node.length }}</strong></div><div><span>Collector errors</span><strong>{{ usage.collectors.filter((collector) => collector.status === 'error').length }}</strong></div></section>
      <section class="split-layout">
        <article class="data-panel"><header class="panel-header"><div><h2>By node</h2><p>Latest collector snapshots</p></div><Activity :size="17" aria-hidden="true" /></header>
          <div v-if="usage.by_node.length" class="table-wrap"><table style="min-width: 420px"><thead><tr><th>Node</th><th class="num">Users</th><th class="num">Traffic</th><th>Reported</th></tr></thead><tbody><tr v-for="node in usage.by_node" :key="node.node_id"><td><strong :title="node.node_name || node.node_id">{{ node.node_name || node.node_id }}</strong><small :title="node.node_id">{{ node.node_id }}</small></td><td class="num">{{ node.user_count }}</td><td class="mono num">{{ formatBytes(node.used_bytes) }}</td><td>{{ formatDate(node.at) }}</td></tr></tbody></table></div>
          <div v-else class="empty-state"><Activity :size="24" aria-hidden="true" /><strong>No node has reported traffic</strong><p>A node reports once its profile names a usage source: a stats file, a collector URL, the Xray API, or the sing-box experimental API. Set one under Node Profiles.</p></div>
        </article>
        <article class="data-panel"><header class="panel-header"><div><h2>By identity</h2><p>Monotonic account totals</p></div><Users :size="17" aria-hidden="true" /></header>
          <div v-if="usage.by_user.length" class="table-wrap"><table style="min-width: 420px"><thead><tr><th>Identity</th><th>Status</th><th class="num">Used</th><th class="num">Quota</th></tr></thead><tbody><tr v-for="user in usage.by_user" :key="user.user_id"><td><strong :title="user.email || user.user_id">{{ user.email || user.user_id }}</strong><small :title="user.user_id">{{ user.user_id }}</small></td><td><span class="status-dot" :data-tone="user.status === 'active' ? 'healthy' : user.status === 'over_quota' ? 'error' : 'neutral'">{{ user.status || 'unknown' }}</span></td><td class="mono num">{{ formatBytes(user.used_bytes) }}</td><td class="mono num">{{ user.quota_bytes ? formatBytes(user.quota_bytes) : 'No quota set' }}</td></tr></tbody></table></div>
          <div v-else class="empty-state"><Users :size="24" aria-hidden="true" /><strong>No per-identity totals</strong><p>Per-identity accounting needs a collector that reports per-user counters. Without one, only node totals are available.</p></div>
        </article>
      </section>
      <!-- Per-line traffic. The server computes this and has always returned
           it; the plugin used to declare a result type without `rows` and drop
           it on parse. Rendered only when a collector actually attributed
           bytes to a line, and the unattributed remainder is stated rather
           than quietly excluded. -->
      <section v-if="usage.rows.length" class="data-panel" aria-labelledby="usage-by-line">
        <header class="panel-header">
          <div><h2 id="usage-by-line">By line</h2><p>Traffic a collector attributed to a specific inbound.</p></div>
          <span class="count">{{ lineUsage.lines.length }} lines</span>
        </header>
        <div v-if="lineUsage.lines.length" class="table-wrap">
          <table style="min-width: 520px">
            <thead><tr><th>Node</th><th>Line</th><th class="num">Identities</th><th class="num">Traffic</th></tr></thead>
            <tbody>
              <tr v-for="entry in lineUsage.lines" :key="`${entry.nodeID}:${entry.lineHashID}`">
                <td><strong :title="entry.nodeName || entry.nodeID">{{ entry.nodeName || entry.nodeID }}</strong><small :title="entry.nodeID">{{ entry.nodeID }}</small></td>
                <td>
                  <strong :title="entry.label">{{ entry.label }}</strong>
                  <small class="mono" :title="entry.lineHashID">{{ entry.lineHashID }}<span v-if="!entry.resolved"> · no longer in the fleet listing</span></small>
                </td>
                <td class="num">{{ entry.users }}</td>
                <td class="mono num">{{ formatBytes(entry.bytes) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty-state">
          <Gauge :size="24" aria-hidden="true" />
          <strong>No collector attributes traffic to a line</strong>
          <p>{{ usage.rows.length }} usage rows arrived and every one of them is a node total for an account, with no line attached. Per-line accounting needs a collector that reports per-inbound counters: the sing-box experimental stats API, or the Xray API with a stat pattern that names the inbound. Set one under Node Profiles.</p>
        </div>
        <p v-if="lineUsage.lines.length && lineUsage.unattributedBytes > 0" class="permission-note">
          {{ formatBytes(lineUsage.unattributedBytes) }} of {{ formatBytes(lineUsage.attributedBytes + lineUsage.unattributedBytes) }} is not in this table: {{ lineUsage.unattributedNodes.join(', ') }} report node totals without a line, so their traffic cannot be placed on an inbound.
        </p>
      </section>
      <section class="data-panel collectors"><header class="panel-header"><div><h2>Collectors</h2><p>Source health and last checks</p></div></header><div v-if="usage.collectors.length" class="collector-grid"><div v-for="collector in usage.collectors" :key="collector.node_id"><span class="status-dot" :data-tone="collector.status === 'error' ? 'error' : collector.status === 'ok' ? 'healthy' : 'neutral'">{{ collector.status || 'unknown' }}</span><strong>{{ collector.node_name || collector.node_id }}</strong><small>{{ collector.source || 'unspecified' }} / {{ formatDate(collector.checked_at) }}</small><p v-if="collector.error" class="error-text">{{ collector.error }}</p></div></div>
        <div v-else class="empty-state"><Gauge :size="24" aria-hidden="true" /><strong>No collector is configured</strong><p>No node profile points at a usage source, so traffic on those nodes is unmeasured rather than zero. Open Node Profiles, edit a node, and set a usage file, collector URL, Xray API or sing-box stats API.</p></div>
      </section>
    </template>

    <div v-if="userDialogOpen" class="overlay-scrim" :style="overlayStyle" @mousedown.self="userDialogOpen = false"><section tabindex="-1" class="modal" role="dialog" aria-modal="true" aria-labelledby="user-dialog-title"><header><div><h2 id="user-dialog-title">{{ editingUser ? 'Edit identity' : 'New identity' }}</h2><p>{{ editingUser ? 'Existing secrets stay unchanged.' : 'Create one initial protocol credential.' }}</p></div><button class="icon-button" type="button" aria-label="Close" @click="userDialogOpen = false"><X :size="17" /></button></header><div class="form-grid">
      <label class="field field-wide"><span>Email identity</span><input v-model="userForm.email" type="email" autocomplete="off" /></label><label class="field"><span>Display name</span><input v-model="userForm.name" type="text" /></label><label class="field"><span>Group</span><input v-model="userForm.group" type="text" /></label><label class="field"><span>Quota (GiB)</span><input v-model="userForm.quotaGiB" type="number" min="0" step="1" placeholder="Unlimited" /></label><label class="field"><span>Expires at</span><input v-model="userForm.expiresAt" type="datetime-local" /><small class="field-help">{{ editingUser ? 'Blank leaves the current expiry unchanged.' : 'Optional expiry for this identity.' }}</small></label><label class="toggle-field"><input v-model="userForm.enabled" type="checkbox" /><span>Identity enabled</span></label>
      <template v-if="!editingUser"><label class="field"><span>Protocol</span><select v-model="userForm.protocol"><option v-for="protocol in ['vless','vmess','trojan','shadowsocks','hysteria2','tuic','anytls']" :key="protocol" :value="protocol">{{ protocol }}</option></select></label><label class="field"><span>{{ ['vless','vmess','tuic'].includes(userForm.protocol) ? 'UUID' : 'Password' }}</span><input v-model="userForm.secret" type="password" autocomplete="new-password" /></label><label class="field field-wide"><span>Flow override</span><input v-model="userForm.flow" type="text" placeholder="Optional" /></label></template>
      <label class="field field-wide"><span>Comment</span><textarea v-model="userForm.comment" rows="3" /></label></div><footer><button class="button button-secondary" type="button" @click="userDialogOpen = false">Cancel</button><button class="button button-primary" type="button" :disabled="savingUser || !userForm.email.trim()" @click="saveUser"><LoaderCircle v-if="savingUser" class="spin" :size="15" />{{ editingUser ? 'Save changes' : 'Create identity' }}</button></footer></section></div>

    <div v-if="rolloutOpen" class="overlay-scrim" :style="overlayStyle" @mousedown.self="closeRollout"><section tabindex="-1" class="modal" role="dialog" aria-modal="true" aria-labelledby="rollout-title"><header><div><h2 id="rollout-title">Roll out managed lines</h2><p>One lattice-owned VLESS+REALITY line per node, bound to one account. This only files an approval batch: nothing changes on any node until you approve it.</p></div><button class="icon-button" type="button" aria-label="Close" @click="closeRollout"><X :size="17" /></button></header>
      <template v-if="!rolloutResult && !rolloutConfirm">
        <div class="form-grid">
          <label class="field"><span>Account to bind</span><select v-model="rolloutUserId"><option value="" disabled>Select an account</option><option v-for="user in rolloutableUsers" :key="user.id" :value="user.id">{{ user.email }}</option></select><small v-if="!rolloutableUsers.length" class="field-help">No enabled identity carries a VLESS credential, so there is nothing to bind a managed line to. Create one under Users first.</small></label>
          <label class="field"><span>Candidate port</span><input v-model.number="rolloutPort" type="number" min="1" max="65535" /><small class="field-help">Used on every node when free; taken ports plan upward per node.</small></label>
        </div>
        <div v-if="rolloutError" class="alert" role="alert"><CircleAlert :size="17" aria-hidden="true" /><span>{{ rolloutError }}</span></div>
        <footer>
          <button class="button button-secondary" type="button" @click="closeRollout">Cancel</button>
          <button class="button button-primary" type="button" :disabled="!rolloutUserId || !rolloutNodeNames.length" @click="rolloutConfirm = true">Review {{ rolloutNodeNames.length }} nodes</button>
        </footer>
      </template>
      <template v-else-if="!rolloutResult">
        <p>This files one approval per eligible node, binding <strong>{{ rolloutableUsers.find((user) => user.id === rolloutUserId)?.email || rolloutUserId }}</strong> to a new VLESS with REALITY line on candidate port <strong class="mono">{{ rolloutPort }}</strong>. Nothing is applied until the batch is approved.</p>
        <ul class="confirm-names" aria-label="Nodes this rollout will consider">
          <li v-for="name in rolloutNodeNames" :key="name">{{ name }}</li>
        </ul>
        <div v-if="rolloutError" class="alert" role="alert"><CircleAlert :size="17" aria-hidden="true" /><span>{{ rolloutError }}</span></div>
        <footer>
          <button class="button button-secondary" type="button" :disabled="rolloutBusy" @click="rolloutConfirm = false">Back</button>
          <button class="button button-primary" type="button" :disabled="!rolloutUserId || rolloutBusy" @click="runRollout"><LoaderCircle v-if="rolloutBusy" class="spin" :size="15" /> Plan for {{ rolloutNodeNames.length }} nodes</button>
        </footer>
      </template>
      <template v-else>
        <div class="alert" :class="rolloutResult.planned?.length ? 'alert-success' : 'alert-warning'" aria-live="polite">
          <ShieldCheck v-if="rolloutResult.planned?.length" :size="17" aria-hidden="true" />
          <CircleAlert v-else :size="17" aria-hidden="true" />
          <span>{{ rolloutSummaryLine(rolloutResult) }}</span>
        </div>
        <p v-if="rolloutResult.skipped?.length" class="muted">Skipped nodes, with the reason the server gave:</p>
        <ul v-if="rolloutResult.skipped?.length" class="confirm-names" aria-label="Skipped nodes">
          <li v-for="item in rolloutResult.skipped" :key="item.node_id">{{ item.node_id }}: {{ item.reason }}</li>
        </ul>
        <p class="muted">Next: Operations, then Approvals. One event card covers the whole batch.</p>
        <footer><button class="button button-secondary" type="button" @click="closeRollout">Done</button></footer>
      </template>
    </section></div>
    <div v-if="bindingUser" class="overlay-scrim" :style="overlayStyle" @mousedown.self="bindingUser = undefined"><section tabindex="-1" class="modal" role="dialog" aria-modal="true"><header><div><h2>Line bindings</h2><p>{{ bindingUser.email }}</p></div><button class="icon-button" type="button" aria-label="Close" @click="bindingUser = undefined"><X :size="17" /></button></header><div v-if="canBindUser" class="binding-add"><select v-model="bindingLine"><option value="">Select an unbound line</option><option v-for="line in lineOptions.filter((option) => !currentBindingUser()?.bindings.some((binding) => binding.line_hash_id === option.id))" :key="line.id" :value="line.id">{{ line.label }}</option></select><button class="button button-primary" type="button" :disabled="!bindingLine || bindingBusy" @click="bindLine"><Plus :size="15" /> Bind</button></div><div class="binding-list"><div v-for="binding in currentBindingUser()?.bindings" :key="binding.line_hash_id"><span>{{ lineOptions.find((line) => line.id === binding.line_hash_id)?.label || binding.line_hash_id }}</span><button v-if="canUnbindUser" class="icon-button bordered destructive" type="button" aria-label="Remove binding" title="Remove binding" :disabled="unbindBusy" @click="unbindLine(binding.line_hash_id)"><Trash2 :size="14" /></button></div><p v-if="!currentBindingUser()?.bindings.length" class="empty-inline">No lines are bound to this identity, so its credential authenticates nowhere. Bind one above.</p><p v-if="!canBindUser && !canUnbindUser" class="empty-inline">This session cannot change bindings.</p></div></section></div>

    <div v-if="deleteTarget" class="overlay-scrim" :style="overlayStyle" @mousedown.self="deleteTarget = undefined"><section tabindex="-1" class="modal modal-small" role="alertdialog" aria-modal="true"><header><div><h2>Delete identity</h2><p>This removes the credentials and line bindings Lattice holds for this identity. It sends nothing to a node: the account keeps working on each line until that line is planned and applied again.</p></div></header><p>Delete <strong>{{ deleteTarget.email }}</strong> and its {{ deleteTarget.bindings.length }} line binding(s)?</p><footer><button class="button button-secondary" type="button" @click="deleteTarget = undefined">Cancel</button><button class="button button-danger" type="button" :disabled="deletingUser" @click="deleteUser"><Trash2 :size="15" /> Delete</button></footer></section></div>

    <div v-if="rotateUser" class="overlay-scrim" :style="overlayStyle" @mousedown.self="rotateUser = undefined"><section tabindex="-1" class="modal modal-small" role="dialog" aria-modal="true"><header><div><h2>Rotate credential</h2><p>{{ rotateUser.email }}, bound to {{ rotateUser.bindings.length }} line(s). The old secret keeps working on each of them until that line is planned and applied with the new one.</p></div><button class="icon-button" type="button" aria-label="Close" @click="rotateUser = undefined"><X :size="17" /></button></header>
      <label class="field"><span>Protocol credential</span><select v-model="rotateProtocol"><option v-for="credential in rotateUser.credentials" :key="credential.protocol" :value="credential.protocol">{{ credential.protocol }}</option></select></label>
      <footer><button class="button button-secondary" type="button" @click="rotateUser = undefined">Cancel</button><button class="button button-primary" type="button" :disabled="rotateBusy || !rotateProtocol" @click="rotateCredential"><LoaderCircle v-if="rotateBusy" class="spin" :size="15" /> Rotate</button></footer></section></div>

    <div v-if="rotateRevealed" class="overlay-scrim" :style="overlayStyle"><section tabindex="-1" class="modal modal-small" role="dialog" aria-modal="true"><header><div><h2>New {{ rotateRevealed.protocol }} credential</h2><p>{{ rotateRevealed.email }}. Shown once and never retrievable again.</p></div></header>
      <label class="field field-wide"><span>Secret (copy now)</span><textarea class="command-output mono" :value="rotateRevealed.secret" readonly rows="2" @focus="($event.target as HTMLTextAreaElement).select()" /></label>
      <footer><button class="button button-primary" type="button" @click="rotateRevealed = undefined">I have saved it</button></footer></section></div>

    <div v-if="lineDetailOpen && lineDetail" class="overlay-scrim" :style="overlayStyle" @mousedown.self="closeLineDetails()"><section tabindex="-1" class="modal modal-large" role="dialog" aria-modal="true" aria-labelledby="line-detail-title"><header><div><h2 id="line-detail-title">Line details</h2><p>{{ lineDetailNodeName }}</p></div><button class="icon-button" type="button" aria-label="Close" @click="closeLineDetails()"><X :size="17" /></button></header><div class="detail-body">
      <div v-if="lineDetailError" class="alert" role="alert"><CircleAlert :size="17" aria-hidden="true" /><span>{{ lineDetailError }}</span></div>
      <div class="detail-grid">
        <div><span>Line</span><strong>{{ lineDetail.name }}</strong><small>{{ lineDetail.line_hash_id }}</small></div>
        <div><span>Protocol</span><strong>{{ lineDetail.type || 'unknown' }}</strong><small>{{ lineDetail.core }}</small></div>
        <div><span>Endpoint</span><strong class="mono">{{ formatLineEndpoint(lineDetail) }}</strong><small>Public address</small></div>
        <div><span>Listen</span><strong class="mono">{{ formatLineListen(lineDetail) }}</strong><small>Bind address</small></div>
        <div><span>Reality SNI</span><strong class="mono">{{ formatLineDomain(lineDetail) }}</strong><small>Server name</small></div>
        <div><span>Outbound ref</span><strong class="mono">{{ lineDetail.outbound_ref || '-' }}</strong><small v-if="lineDetail.outbound_server">{{ lineDetail.outbound_server }}<span v-if="lineDetail.outbound_port">:{{ lineDetail.outbound_port }}</span></small></div>
        <div><span>Ownership</span><strong>{{ lineOwnership(lineDetail) }}</strong><small>{{ lineDetail.source }}</small></div>
        <div><span>Status</span><strong>{{ lineDetail.status || (lineDetail.last_error ? 'error' : 'not reported') }}</strong><small>{{ lineDetail.user_known ? `${lineDetail.user_count} users` : 'user count unavailable' }}</small></div>
      </div>
      <div v-if="lineDetailBusy" class="loading-state loading-inline"><LoaderCircle class="spin" :size="18" /> Refreshing line details</div>
      <section class="detail-section"><h3>Line identity</h3><dl class="detail-pairs"><dt>Chain identity</dt><dd class="mono">{{ lineDetail.line_uuid || 'not allocated yet, so this line cannot be either end of a chain' }}</dd><template v-if="lineDetail.downstream_line_uuid"><dt>Downstream identity</dt><dd class="mono">{{ lineDetail.downstream_line_uuid }}</dd></template></dl>
        <div v-if="canSyncMetadata && !lineDetail.managed" class="icon-actions"><button class="button button-secondary button-compact" type="button" :disabled="syncBusy" title="File an approval that writes this line's identity file on its node" @click="syncSidecar"><LoaderCircle v-if="syncBusy" class="spin" :size="13" /> Write identity to the node</button></div>
        <div v-if="canReattachLine" class="binding-add"><input v-model="reattachUUID" class="mono" type="text" autocomplete="off" spellcheck="false" placeholder="Existing UUIDv4 to reattach" /><button class="button button-secondary button-compact" type="button" :disabled="reattachBusy || !reattachUUID.trim()" @click="reattachLineUUID"><LoaderCircle v-if="reattachBusy" class="spin" :size="13" /> Reattach identity</button></div>
      </section>
      <section v-if="canPlanLineUsers" class="detail-section"><h3>On-node users</h3>
        <p class="field-help">Each action here files an approval and changes nothing yet. Once you approve it, applying {{ lineDetail.managed ? 'rewrites the whole core config on that node and reloads it' : 'changes this one user record on that node in place' }}.</p>
        <div v-if="lineUsersError" class="alert" role="alert"><CircleAlert :size="17" aria-hidden="true" /><span>{{ lineUsersError }}</span></div>
        <div class="binding-list">
          <div v-for="user in lineDetailBoundUsers" :key="user.id">
            <span>{{ user.email }}<small v-if="user.name"> ({{ user.name }})</small></span>
            <span class="icon-actions">
              <button class="button button-secondary button-compact" type="button" :disabled="lineUsersBusy" title="File an approval to update this identity on this line" @click="planLineUser('plan_update', user.id)">Update</button>
              <button class="button button-secondary button-compact destructive" type="button" :disabled="lineUsersBusy" title="File an approval to remove this identity from this line" @click="planLineUser('plan_remove', user.id)">Remove</button>
            </span>
          </div>
          <p v-if="usersUnavailable" class="empty-inline" role="status">The identity list could not be loaded, so bindings for this line are not shown.</p>
          <p v-else-if="!lineDetailBoundUsers.length" class="empty-inline">No identities bound to this line yet.</p>
        </div>
        <div v-if="lineDetailBindableUsers.length" class="binding-add">
          <select v-model="lineUserAdd"><option value="">Select an identity to add</option><option v-for="user in lineDetailBindableUsers" :key="user.id" :value="user.id">{{ user.email }}</option></select>
          <button class="button button-primary" type="button" :disabled="!lineUserAdd || lineUsersBusy" @click="bindAndApplyToLine"><Plus :size="15" /> Queue add</button>
        </div>
        <ul v-if="lineApprovals.length" class="detail-list">
          <li v-for="item in lineApprovals" :key="item.id"><span class="mono">{{ item.id }}</span>: {{ item.summary }} <em>(pending approval)</em></li>
        </ul>
      </section>
      <section class="detail-section"><h3>Error</h3><p :class="{ 'error-text': lineDetail.last_error }">{{ lineErrorText(lineDetail) }}</p></section>
      <section v-if="lineDetail.jump_edges?.length" class="detail-section"><h3>Relay targets</h3><ul class="detail-list"><li v-for="target in lineDetail.jump_edges" :key="target" class="mono">{{ target }} <span v-if="lineDetail.declared_jump_edges?.includes(target)" class="badge" data-tone="info">declared</span></li></ul></section>
      <section v-if="lineDetail.metadata && Object.keys(lineDetail.metadata).length" class="detail-section"><h3>Metadata</h3><dl class="detail-pairs"><template v-for="(value, key) in lineDetail.metadata" :key="key"><dt class="mono">{{ key }}</dt><dd>{{ value || '-' }}</dd></template></dl></section>
    </div></section></div>

    <div v-if="profileSettingsOpen" class="overlay-scrim" :style="overlayStyle" @mousedown.self="closeProfileSettings()"><section tabindex="-1" class="modal modal-large" role="dialog" aria-modal="true" aria-labelledby="profile-settings-title"><header><div><h2 id="profile-settings-title">sing-box integration</h2><p>{{ profileSettings?.node_name || profileSettings?.node_id || 'Node profile' }}</p></div><button class="icon-button" type="button" aria-label="Close" @click="closeProfileSettings()"><X :size="17" /></button></header>
      <div class="detail-body">
        <div v-if="profileSettingsError" class="alert" role="alert"><CircleAlert :size="17" aria-hidden="true" /><span>{{ profileSettingsError }}</span></div>
        <div v-if="profileSettingsBusy" class="loading-state loading-inline"><LoaderCircle class="spin" :size="18" /> Loading node settings</div>
        <template v-else-if="profileSettings">
          <section class="detail-section"><h3>Native execution prerequisites</h3><div class="prerequisite-strip">
            <span class="badge" :data-tone="profileSettings.prerequisites.allow_exec && !profileSettings.prerequisites.no_exec ? 'info' : 'neutral'">Task execution {{ profileSettings.prerequisites.allow_exec && !profileSettings.prerequisites.no_exec ? 'allowed' : 'blocked' }}</span>
            <span class="badge" :data-tone="profileSettings.prerequisites.allow_root_exec ? 'info' : 'neutral'">Root execution {{ profileSettings.prerequisites.allow_root_exec ? 'allowed' : 'blocked' }}</span>
            <span class="badge" :data-tone="profileSettings.reconfigure_required ? 'warning' : 'neutral'">{{ profileSettings.reconfigure_required ? 'Agent reconfigure required' : 'Saved and reported settings match' }}</span>
          </div></section>
          <div class="form-grid profile-form">
            <label class="toggle-field field-wide"><input v-model="profileForm.singbox_discover" type="checkbox" /><span>Discover sing-box installations on this node</span></label>
            <label class="field field-wide"><span>Manager binary</span><input v-model="profileForm.singbox_bin" class="mono" type="text" placeholder="/usr/local/bin/sb" autocomplete="off" /></label>
            <label class="field"><span>Usage file</span><input v-model="profileForm.proxy_usage_file" class="mono" type="text" placeholder="/var/lib/sing-box/usage.json" autocomplete="off" /></label>
            <label class="field"><span>Usage URL</span><input v-model="profileForm.proxy_usage_url" class="mono" type="url" placeholder="Absolute HTTPS collector URL" autocomplete="off" /></label>
            <label class="field"><span>Xray API</span><input v-model="profileForm.proxy_usage_xray_api" class="mono" type="text" placeholder="127.0.0.1:10085" autocomplete="off" /></label>
            <label class="field"><span>Xray binary</span><input v-model="profileForm.proxy_usage_xray_bin" class="mono" type="text" placeholder="/usr/local/bin/xray" autocomplete="off" /></label>
            <label class="field field-wide"><span>Xray stat pattern</span><input v-model="profileForm.proxy_usage_xray_pattern" class="mono" type="text" autocomplete="off" /></label>
            <label class="field field-wide"><span>sing-box stats API</span><input v-model="profileForm.singbox_stats_api" class="mono" type="text" placeholder="127.0.0.1:8080" autocomplete="off" /><small class="field-help">sing-box's experimental stats API, on loopback. Without it there are no per-identity usage numbers for this node.</small></label>
          </div>
          <section v-if="profileReconfigureCommand" class="detail-section"><h3>Generated agent command</h3><textarea class="command-output mono" :value="profileReconfigureCommand" readonly aria-label="Generated agent reconfiguration command" /></section>
        </template>
      </div>
      <footer><button class="button button-secondary" type="button" @click="closeProfileSettings()">Close</button><button v-if="profileSettings && canConfigureProfile" class="button button-primary" type="button" :disabled="profileSettingsSaving" @click="saveProfileSettings"><LoaderCircle v-if="profileSettingsSaving" class="spin" :size="15" /> Save settings</button></footer>
    </section></div>
  </main>
</template>
