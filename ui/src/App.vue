<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import {
  Activity,
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
  X,
} from "@lucide/vue";

import { BridgeClient, canCall, type HostInit } from "./bridge";
import {
  filterLineGroups,
  formatBytes,
  formatLineDomain,
  formatLineEndpoint,
  formatLineListen,
  lineErrorText,
  lineOwnership,
  lineStatus,
  overlayCoverage,
  overlayTone,
  rolloutSummaryLine,
  safeErrorMessage,
  unresolvedOverlayDefs,
  type Line,
  type LineGroup,
  type ManagedLineDef,
  type RolloutResult,
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
  collectors: UsageCollector[];
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
const users = ref<VpnUser[]>([]);
const profiles = ref<Profile[]>([]);
const usage = ref<UsageResult>({ by_user: [], by_node: [], collectors: [], per_line: false });
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
const visibleLines = computed(() => visibleLineGroups.value.flatMap((group) => group.lines.map((line) => ({
  group,
  line,
}))));
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
  if (!bridge || !canCall(init.value, service, method)) throw new Error(`Method ${service}.${method} is not available for this session`);
  return bridge.call<T>(service, method, payload).promise;
}

async function loadCurrent(background = false): Promise<void> {
  if (!init.value) return;
  if (background) refreshing.value = true;
  else loading.value = true;
  error.value = "";
  try {
    switch (route.value) {
      case "lines": {
        const calls: Promise<void>[] = [
          pluginCall<{ groups: LineGroup[] }>(SERVICES.lines, "list")
            .then((result) => { lines.value = result.groups ?? []; }),
        ];
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
      case "usage":
        usage.value = await pluginCall<UsageResult>(SERVICES.usage, "query");
        break;
    }
  } catch (cause) {
    error.value = safeErrorMessage(cause);
  } finally {
    loading.value = false;
    refreshing.value = false;
    await resize();
  }
}

// design-17 S3: the managed-line rollout. The modal collects the account and
// candidate port; the compile only files approvals — nothing touches a node
// until the operator approves the batch (the result panel says exactly that).
const rolloutOpen = ref(false);
const rolloutBusy = ref(false);
const rolloutError = ref("");
const rolloutResult = ref<RolloutResult>();
const rolloutUserId = ref("");
const rolloutPort = ref(24443);

function openRollout(): void {
  rolloutUserId.value = rolloutableUsers.value[0]?.id ?? "";
  rolloutPort.value = 24443;
  rolloutError.value = "";
  rolloutResult.value = undefined;
  rolloutOpen.value = true;
}

async function runRollout(): Promise<void> {
  if (!rolloutUserId.value || rolloutBusy.value) return;
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
    await resize();
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
    const quota = Number(userForm.quotaGiB);
    const payload: Record<string, unknown> = {
      email: userForm.email.trim(), name: userForm.name.trim(), enabled: userForm.enabled,
      quota_bytes: Number.isFinite(quota) && quota > 0 ? Math.round(quota * 1024 * 1024 * 1024) : 0,
      group: userForm.group.trim(), comment: userForm.comment.trim(),
    };
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

async function unbindLine(lineHash: string): Promise<void> {
  if (!bindingUser.value || !canUnbindUser.value) return;
  try {
    await pluginCall(SERVICES.admin, "unbind", { user_id: bindingUser.value.id, line_hash_id: lineHash });
    notice.value = "Line binding removed";
    await loadCurrent(true);
  } catch (cause) {
    error.value = safeErrorMessage(cause, "Binding could not be removed");
  }
}

const deleteTarget = ref<VpnUser>();
async function deleteUser(): Promise<void> {
  if (!deleteTarget.value || !canDeleteUser.value) return;
  try {
    await pluginCall(SERVICES.admin, "delete", { id: deleteTarget.value.id });
    notice.value = `${deleteTarget.value.email} deleted`;
    deleteTarget.value = undefined;
    await loadCurrent(true);
  } catch (cause) {
    error.value = safeErrorMessage(cause, "User could not be deleted");
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
  } catch {
    users.value = [];
  }
  await resize();
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
    notice.value = "On-node action queued — approve it in the Approvals console, then rediscover";
    await loadCurrent(true);
  } catch (cause) {
    lineUsersError.value = safeErrorMessage(cause, "The on-node action could not be planned");
  } finally {
    lineUsersBusy.value = false;
    await resize();
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
    notice.value = "Sidecar sync queued — approve it in the Approvals console";
  } catch (cause) {
    lineUsersError.value = safeErrorMessage(cause, "Sidecar sync could not be queued");
  } finally {
    syncBusy.value = false;
    await resize();
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
    notice.value = "Line identity reattached — approve the queued sidecar sync before treating it as converged";
    reattachUUID.value = "";
    await loadCurrent(true);
    const refreshed = await pluginCall<{ line: Line }>(SERVICES.lines, "get", { line_hash_id: line.line_hash_id });
    if (refreshed.line) lineDetail.value = refreshed.line;
  } catch (cause) {
    lineUsersError.value = safeErrorMessage(cause, "Line identity could not be reattached");
  } finally {
    reattachBusy.value = false;
    await resize();
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
    notice.value = `${result.protocol} credential rotated — re-apply it to its lines to take effect on nodes`;
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
    await resize();
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
    notice.value = `${profileSettings.value.node_name || profileSettings.value.node_id} plugin settings saved`;
    await loadCurrent(true);
  } catch (cause) {
    profileSettingsError.value = safeErrorMessage(cause, "Node settings could not be saved");
  } finally {
    profileSettingsSaving.value = false;
    await resize();
  }
}

async function resize(): Promise<void> {
  await nextTick();
  bridge?.resize(document.documentElement.scrollHeight);
}

let observer: ResizeObserver | undefined;
onMounted(() => {
  observer = new ResizeObserver(() => { void resize(); });
  observer.observe(document.body);
  void resize();
});

onBeforeUnmount(() => {
  observer?.disconnect();
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
      <CircleAlert :size="17" aria-hidden="true" /><span>{{ bootError || error }}</span>
      <button class="icon-button" type="button" aria-label="Dismiss error" title="Dismiss error" @click="error = ''; bootError = ''"><X :size="15" /></button>
    </div>
    <div v-if="notice" class="alert alert-success" aria-live="polite">
      <ShieldCheck :size="17" aria-hidden="true" /><span>{{ notice }}</span>
      <button class="icon-button" type="button" aria-label="Dismiss notice" title="Dismiss notice" @click="notice = ''"><X :size="15" /></button>
    </div>

    <div v-if="loading" class="loading-state"><LoaderCircle class="spin" :size="20" /> Loading {{ routeMeta.title.toLowerCase() }}</div>

    <template v-else-if="route === 'lines'">
      <section class="summary-strip" aria-label="Line summary">
        <div><span>Total lines</span><strong>{{ allLines.length }}</strong></div>
        <div><span>Healthy</span><strong>{{ healthyLines }}</strong></div>
        <div><span>Managed</span><strong>{{ managedLines }}</strong></div>
        <div><span>Nodes</span><strong>{{ lines.length }}</strong></div>
        <div v-if="canReadManaged"><span>Lattice-managed</span><strong>{{ overlayStats.covered }} / {{ overlayStats.total }} nodes</strong></div>
      </section>
      <section class="toolbar">
        <input v-model="search" class="search-input" type="search" placeholder="Search node, line, status, outbound or error" />
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
      <section v-if="visibleLines.length" class="data-panel">
        <div class="table-wrap"><table><thead><tr><th>Node</th><th>Line</th><th>Core</th><th>Source</th><th>Ownership</th><th>Endpoint</th><th>Listen</th><th>Reality SNI</th><th>Users</th><th>Outbound ref</th><th>Status</th><th>Error</th><th v-if="canViewLineDetails" class="actions-cell">Actions</th></tr></thead>
          <tbody><tr v-for="{ group, line } in visibleLines" :key="line.line_hash_id">
            <td><strong>{{ group.node_name || group.node_id }}</strong><small>{{ group.node_id }}</small></td>
            <td><strong>{{ line.name }}</strong><small>{{ line.type || 'unknown' }} / {{ line.line_hash_id }}</small></td>
            <td><span class="badge">{{ line.core || 'unknown' }}</span></td>
            <td><span class="badge" :data-tone="line.managed ? 'info' : 'neutral'">{{ line.source }}</span></td>
            <td><span class="badge" :data-tone="line.managed ? 'info' : 'neutral'">{{ lineOwnership(line) }}</span><span v-if="line.overlay" class="badge" :data-tone="overlayTone(line.overlay_status)" :title="line.overlay_user ? `Bound account: ${line.overlay_user}` : undefined">lattice-managed</span></td>
            <td class="mono">{{ formatLineEndpoint(line) }}</td>
            <td class="mono">{{ formatLineListen(line) }}</td>
            <td class="mono">{{ formatLineDomain(line) }}</td>
            <td>{{ line.user_known ? line.user_count : 'unknown' }}</td>
            <td class="mono">{{ line.outbound_ref || '-' }}<small v-if="line.outbound_server">{{ line.outbound_server }}<span v-if="line.outbound_port">:{{ line.outbound_port }}</span></small></td>
            <td><span class="status-dot" :data-tone="lineStatus(line)">{{ line.status || (line.last_error ? 'error' : 'ok') }}</span></td>
            <td :class="{ 'error-text': line.last_error }">{{ lineErrorText(line) }}</td>
            <td v-if="canViewLineDetails" class="actions-cell"><button class="button button-secondary button-compact" type="button" @click="openLineDetails(group, line)">Details</button></td>
          </tr></tbody></table></div>
      </section>
      <div v-else class="empty-state"><Radar :size="28" /><strong>No matching lines</strong><span>Managed or discovered endpoints will appear here.</span></div>
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
      <section class="data-panel"><div class="table-wrap"><table><thead><tr><th>Identity</th><th>Status</th><th>Credentials</th><th>Bindings</th><th>Quota</th><th>Expires</th><th v-if="showUserActions" class="actions-cell">Actions</th></tr></thead>
        <tbody><tr v-for="user in users" :key="user.id">
          <td><strong>{{ user.email }}</strong><small>{{ user.name || user.id }}<span v-if="user.migrated"> / migrated</span></small></td>
          <td><span class="status-dot" :data-tone="user.enabled ? 'healthy' : 'warning'">{{ user.enabled ? 'enabled' : 'disabled' }}</span></td>
          <td><span v-for="credential in user.credentials" :key="credential.protocol" class="badge credential">{{ credential.protocol }}<KeyRound v-if="credential.has_secret" :size="11" /></span><span v-if="!user.credentials.length">-</span></td>
          <td>{{ user.bindings.length }}</td><td>{{ user.quota_bytes ? formatBytes(user.quota_bytes) : 'Unlimited' }}</td><td>{{ formatDate(user.expires_at) }}</td>
          <td v-if="showUserActions" class="actions-cell"><div class="icon-actions">
            <button v-if="canUpdateUser" class="icon-button bordered" type="button" aria-label="Edit identity" title="Edit identity" @click="openEditUser(user)"><Pencil :size="14" /></button>
            <button v-if="canRotateCredentials && user.credentials.length" class="icon-button bordered" type="button" aria-label="Rotate a credential" title="Rotate a credential" @click="openRotate(user)"><KeyRound :size="14" /></button>
            <button v-if="canBindUser || canUnbindUser" class="icon-button bordered" type="button" aria-label="Manage line bindings" title="Manage line bindings" @click="bindingUser = user"><Link2 :size="14" /></button>
            <button v-if="canDeleteUser" class="icon-button bordered destructive" type="button" aria-label="Delete identity" title="Delete identity" @click="deleteTarget = user"><Trash2 :size="14" /></button>
          </div></td>
        </tr></tbody></table></div>
        <div v-if="!users.length" class="empty-state"><UserRound :size="28" /><strong>No VPN identities</strong><span>Create an identity to attach credentials and lines.</span></div>
      </section>
    </template>

    <template v-else-if="route === 'profiles'">
      <section class="summary-strip" aria-label="Profile summary">
        <div><span>Profiles</span><strong>{{ profiles.length }}</strong></div>
        <div><span>Managed</span><strong>{{ profiles.filter((profile) => profile.managed).length }}</strong></div>
        <div><span>Applied</span><strong>{{ profiles.filter((profile) => profile.applied).length }}</strong></div>
        <div><span>Runtime errors</span><strong>{{ profiles.filter((profile) => profile.last_error || profile.discovery_error || profile.collector?.status === 'error').length }}</strong></div>
      </section>
      <section class="data-panel"><div class="table-wrap"><table><thead><tr><th>Node</th><th>Core</th><th>Ownership</th><th>Inbounds</th><th>Discovered</th><th>Collector</th><th>Runtime path</th><th v-if="canReadProfileSettings" class="actions-cell">Actions</th></tr></thead>
        <tbody><tr v-for="profile in profiles" :key="profile.node_id">
          <td><strong>{{ profile.node_name || profile.node_id }}</strong><small>{{ profile.node_id }}</small></td>
          <td><span class="badge">{{ profile.core || 'unknown' }} {{ profile.core_version || '' }}</span></td>
          <td><span class="status-dot" :data-tone="profile.applied ? 'healthy' : profile.managed ? 'warning' : 'neutral'">{{ profile.managed ? (profile.applied ? 'managed / applied' : 'managed / pending') : 'observed' }}</span></td>
          <td>{{ profile.inbound_count }}</td><td>{{ profile.discovered_count }}</td>
          <td><span class="status-dot" :data-tone="profile.collector?.status === 'error' ? 'error' : profile.collector?.status === 'ok' ? 'healthy' : 'neutral'">{{ profile.collector?.status || 'not configured' }}</span></td>
          <td class="mono path-cell">{{ profile.config_path || '-' }}<small v-if="profile.last_error || profile.discovery_error" class="error-text">{{ profile.last_error || profile.discovery_error }}</small></td>
          <td v-if="canReadProfileSettings" class="actions-cell"><button class="icon-button bordered" type="button" aria-label="Configure sing-box integration" title="Configure sing-box integration" @click="openProfileSettings(profile)"><Pencil :size="14" /></button></td>
        </tr></tbody></table></div>
        <div v-if="!profiles.length" class="empty-state"><ServerCog :size="28" /><strong>No node profiles</strong><span>Profiles appear when a node is managed or reports discovery.</span></div>
      </section>
    </template>

    <template v-else-if="route === 'usage'">
      <section class="summary-strip" aria-label="Usage summary"><div><span>Tracked users</span><strong>{{ usage.by_user.length }}</strong></div><div><span>Traffic</span><strong>{{ formatBytes(totalTraffic) }}</strong></div><div><span>Reporting nodes</span><strong>{{ usage.by_node.length }}</strong></div><div><span>Collector errors</span><strong>{{ usage.collectors.filter((collector) => collector.status === 'error').length }}</strong></div></section>
      <section class="split-layout">
        <article class="data-panel"><header class="panel-header"><div><h2>By node</h2><p>Latest collector snapshots</p></div><Activity :size="17" /></header><div class="table-wrap"><table><thead><tr><th>Node</th><th>Users</th><th>Traffic</th><th>Reported</th></tr></thead><tbody><tr v-for="node in usage.by_node" :key="node.node_id"><td><strong>{{ node.node_name || node.node_id }}</strong><small>{{ node.node_id }}</small></td><td>{{ node.user_count }}</td><td class="mono">{{ formatBytes(node.used_bytes) }}</td><td>{{ formatDate(node.at) }}</td></tr></tbody></table></div></article>
        <article class="data-panel"><header class="panel-header"><div><h2>By identity</h2><p>Monotonic account totals</p></div><Users :size="17" /></header><div class="table-wrap"><table><thead><tr><th>Identity</th><th>Status</th><th>Used</th><th>Quota</th></tr></thead><tbody><tr v-for="user in usage.by_user" :key="user.user_id"><td><strong>{{ user.email || user.user_id }}</strong><small>{{ user.user_id }}</small></td><td><span class="status-dot" :data-tone="user.status === 'active' ? 'healthy' : user.status === 'over_quota' ? 'error' : 'neutral'">{{ user.status || 'unknown' }}</span></td><td class="mono">{{ formatBytes(user.used_bytes) }}</td><td class="mono">{{ user.quota_bytes ? formatBytes(user.quota_bytes) : 'Unlimited' }}</td></tr></tbody></table></div></article>
      </section>
      <section v-if="usage.collectors.length" class="data-panel collectors"><header class="panel-header"><div><h2>Collectors</h2><p>Source health and last checks</p></div></header><div class="collector-grid"><div v-for="collector in usage.collectors" :key="collector.node_id"><span class="status-dot" :data-tone="collector.status === 'error' ? 'error' : collector.status === 'ok' ? 'healthy' : 'neutral'">{{ collector.status || 'unknown' }}</span><strong>{{ collector.node_name || collector.node_id }}</strong><small>{{ collector.source || 'unspecified' }} / {{ formatDate(collector.checked_at) }}</small><p v-if="collector.error" class="error-text">{{ collector.error }}</p></div></div></section>
    </template>

    <div v-if="userDialogOpen" class="modal-backdrop" @mousedown.self="userDialogOpen = false"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="user-dialog-title"><header><div><h2 id="user-dialog-title">{{ editingUser ? 'Edit identity' : 'New identity' }}</h2><p>{{ editingUser ? 'Existing secrets stay unchanged.' : 'Create one initial protocol credential.' }}</p></div><button class="icon-button" type="button" aria-label="Close" @click="userDialogOpen = false"><X :size="17" /></button></header><div class="form-grid">
      <label class="field field-wide"><span>Email identity</span><input v-model="userForm.email" type="email" autocomplete="off" /></label><label class="field"><span>Display name</span><input v-model="userForm.name" type="text" /></label><label class="field"><span>Group</span><input v-model="userForm.group" type="text" /></label><label class="field"><span>Quota (GiB)</span><input v-model="userForm.quotaGiB" type="number" min="0" step="1" placeholder="Unlimited" /></label><label class="field"><span>Expires at</span><input v-model="userForm.expiresAt" type="datetime-local" /><small class="field-help">{{ editingUser ? 'Blank leaves the current expiry unchanged.' : 'Optional expiry for this identity.' }}</small></label><label class="toggle-field"><input v-model="userForm.enabled" type="checkbox" /><span>Identity enabled</span></label>
      <template v-if="!editingUser"><label class="field"><span>Protocol</span><select v-model="userForm.protocol"><option v-for="protocol in ['vless','vmess','trojan','shadowsocks','hysteria2','tuic','anytls']" :key="protocol" :value="protocol">{{ protocol }}</option></select></label><label class="field"><span>{{ ['vless','vmess','tuic'].includes(userForm.protocol) ? 'UUID' : 'Password' }}</span><input v-model="userForm.secret" type="password" autocomplete="new-password" /></label><label class="field field-wide"><span>Flow override</span><input v-model="userForm.flow" type="text" placeholder="Optional" /></label></template>
      <label class="field field-wide"><span>Comment</span><textarea v-model="userForm.comment" rows="3" /></label></div><footer><button class="button button-secondary" type="button" @click="userDialogOpen = false">Cancel</button><button class="button button-primary" type="button" :disabled="savingUser || !userForm.email.trim()" @click="saveUser"><LoaderCircle v-if="savingUser" class="spin" :size="15" />{{ editingUser ? 'Save changes' : 'Create identity' }}</button></footer></section></div>

    <div v-if="rolloutOpen" class="modal-backdrop" @mousedown.self="rolloutOpen = false"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="rollout-title"><header><div><h2 id="rollout-title">Roll out managed lines</h2><p>One lattice-owned VLESS+REALITY line per node, bound to one account. This only files an approval batch — nothing changes on any node until you approve it.</p></div><button class="icon-button" type="button" aria-label="Close" @click="rolloutOpen = false"><X :size="17" /></button></header>
      <template v-if="!rolloutResult">
        <div class="form-grid">
          <label>Account to bind<select v-model="rolloutUserId"><option value="" disabled>Select an account</option><option v-for="user in rolloutableUsers" :key="user.id" :value="user.id">{{ user.email }}</option></select></label>
          <label>Candidate port<input v-model.number="rolloutPort" type="number" min="1" max="65535" /><small>Used on every node when free; taken ports plan upward per node.</small></label>
        </div>
        <p v-if="rolloutError" class="alert" role="alert">{{ rolloutError }}</p>
        <footer><button class="button button-primary" type="button" :disabled="!rolloutUserId || rolloutBusy" @click="runRollout"><LoaderCircle v-if="rolloutBusy" class="spin" :size="15" /> Plan the rollout</button></footer>
      </template>
      <template v-else>
        <p class="alert alert-success" aria-live="polite">{{ rolloutSummaryLine(rolloutResult) }}</p>
        <ul v-if="rolloutResult.skipped?.length" class="detail-list">
          <li v-for="item in rolloutResult.skipped" :key="item.node_id"><strong>{{ item.node_id }}</strong> — {{ item.reason }}</li>
        </ul>
        <p class="muted">Next: Operations → Approvals — one event card covers the whole batch.</p>
        <footer><button class="button button-secondary" type="button" @click="rolloutOpen = false">Done</button></footer>
      </template>
    </section></div>
    <div v-if="bindingUser" class="modal-backdrop" @mousedown.self="bindingUser = undefined"><section class="modal" role="dialog" aria-modal="true"><header><div><h2>Line bindings</h2><p>{{ bindingUser.email }}</p></div><button class="icon-button" type="button" aria-label="Close" @click="bindingUser = undefined"><X :size="17" /></button></header><div v-if="canBindUser" class="binding-add"><select v-model="bindingLine"><option value="">Select an unbound line</option><option v-for="line in lineOptions.filter((option) => !currentBindingUser()?.bindings.some((binding) => binding.line_hash_id === option.id))" :key="line.id" :value="line.id">{{ line.label }}</option></select><button class="button button-primary" type="button" :disabled="!bindingLine || bindingBusy" @click="bindLine"><Plus :size="15" /> Bind</button></div><div class="binding-list"><div v-for="binding in currentBindingUser()?.bindings" :key="binding.line_hash_id"><span>{{ lineOptions.find((line) => line.id === binding.line_hash_id)?.label || binding.line_hash_id }}</span><button v-if="canUnbindUser" class="icon-button bordered destructive" type="button" aria-label="Remove binding" title="Remove binding" @click="unbindLine(binding.line_hash_id)"><Trash2 :size="14" /></button></div><p v-if="!currentBindingUser()?.bindings.length" class="empty-inline">No lines bound to this identity.</p><p v-if="!canBindUser && !canUnbindUser" class="empty-inline">This session cannot change bindings.</p></div></section></div>

    <div v-if="deleteTarget" class="modal-backdrop" @mousedown.self="deleteTarget = undefined"><section class="modal modal-small" role="alertdialog" aria-modal="true"><header><div><h2>Delete identity</h2><p>This removes plugin-owned credentials and line bindings.</p></div></header><p>Delete <strong>{{ deleteTarget.email }}</strong>?</p><footer><button class="button button-secondary" type="button" @click="deleteTarget = undefined">Cancel</button><button class="button button-danger" type="button" @click="deleteUser"><Trash2 :size="15" /> Delete</button></footer></section></div>

    <div v-if="rotateUser" class="modal-backdrop" @mousedown.self="rotateUser = undefined"><section class="modal modal-small" role="dialog" aria-modal="true"><header><div><h2>Rotate credential</h2><p>{{ rotateUser.email }} — the old secret stops working once the new one is applied to its lines.</p></div><button class="icon-button" type="button" aria-label="Close" @click="rotateUser = undefined"><X :size="17" /></button></header>
      <label class="field"><span>Protocol credential</span><select v-model="rotateProtocol"><option v-for="credential in rotateUser.credentials" :key="credential.protocol" :value="credential.protocol">{{ credential.protocol }}</option></select></label>
      <footer><button class="button button-secondary" type="button" @click="rotateUser = undefined">Cancel</button><button class="button button-primary" type="button" :disabled="rotateBusy || !rotateProtocol" @click="rotateCredential"><LoaderCircle v-if="rotateBusy" class="spin" :size="15" /> Rotate</button></footer></section></div>

    <div v-if="rotateRevealed" class="modal-backdrop"><section class="modal modal-small" role="dialog" aria-modal="true"><header><div><h2>New {{ rotateRevealed.protocol }} credential</h2><p>{{ rotateRevealed.email }} — shown once and never retrievable again.</p></div></header>
      <label class="field field-wide"><span>Secret (copy now)</span><textarea class="command-output mono" :value="rotateRevealed.secret" readonly rows="2" @focus="($event.target as HTMLTextAreaElement).select()" /></label>
      <footer><button class="button button-primary" type="button" @click="rotateRevealed = undefined">I have saved it</button></footer></section></div>

    <div v-if="lineDetailOpen && lineDetail" class="modal-backdrop" @mousedown.self="closeLineDetails()"><section class="modal modal-large" role="dialog" aria-modal="true" aria-labelledby="line-detail-title"><header><div><h2 id="line-detail-title">Line details</h2><p>{{ lineDetailNodeName }}</p></div><button class="icon-button" type="button" aria-label="Close" @click="closeLineDetails()"><X :size="17" /></button></header><div class="detail-body">
      <div v-if="lineDetailError" class="alert" role="alert"><CircleAlert :size="17" aria-hidden="true" /><span>{{ lineDetailError }}</span></div>
      <div class="detail-grid">
        <div><span>Line</span><strong>{{ lineDetail.name }}</strong><small>{{ lineDetail.line_hash_id }}</small></div>
        <div><span>Protocol</span><strong>{{ lineDetail.type || 'unknown' }}</strong><small>{{ lineDetail.core }}</small></div>
        <div><span>Endpoint</span><strong class="mono">{{ formatLineEndpoint(lineDetail) }}</strong><small>Public address</small></div>
        <div><span>Listen</span><strong class="mono">{{ formatLineListen(lineDetail) }}</strong><small>Bind address</small></div>
        <div><span>Reality SNI</span><strong class="mono">{{ formatLineDomain(lineDetail) }}</strong><small>Server name</small></div>
        <div><span>Outbound ref</span><strong class="mono">{{ lineDetail.outbound_ref || '-' }}</strong><small v-if="lineDetail.outbound_server">{{ lineDetail.outbound_server }}<span v-if="lineDetail.outbound_port">:{{ lineDetail.outbound_port }}</span></small></div>
        <div><span>Ownership</span><strong>{{ lineOwnership(lineDetail) }}</strong><small>{{ lineDetail.source }}</small></div>
        <div><span>Status</span><strong>{{ lineDetail.status || (lineDetail.last_error ? 'error' : 'ok') }}</strong><small>{{ lineDetail.user_known ? `${lineDetail.user_count} users` : 'user count unavailable' }}</small></div>
      </div>
      <div v-if="lineDetailBusy" class="loading-state loading-inline"><LoaderCircle class="spin" :size="18" /> Refreshing line details</div>
      <section class="detail-section"><h3>Line identity</h3><dl class="detail-pairs"><dt class="mono">line_uuid</dt><dd class="mono">{{ lineDetail.line_uuid || 'pending allocation' }}</dd><template v-if="lineDetail.downstream_line_uuid"><dt class="mono">downstream_line_uuid</dt><dd class="mono">{{ lineDetail.downstream_line_uuid }}</dd></template></dl>
        <div v-if="canSyncMetadata && !lineDetail.managed" class="icon-actions"><button class="button button-secondary button-compact" type="button" :disabled="syncBusy" title="Queue a reviewed sidecar apply for this node" @click="syncSidecar"><LoaderCircle v-if="syncBusy" class="spin" :size="13" /> Sync sidecar to node</button></div>
        <div v-if="canReattachLine" class="binding-add"><input v-model="reattachUUID" class="mono" type="text" autocomplete="off" spellcheck="false" placeholder="Existing UUIDv4 to reattach" /><button class="button button-secondary button-compact" type="button" :disabled="reattachBusy || !reattachUUID.trim()" @click="reattachLineUUID"><LoaderCircle v-if="reattachBusy" class="spin" :size="13" /> Reattach identity</button></div>
      </section>
      <section v-if="canPlanLineUsers" class="detail-section"><h3>On-node users</h3>
        <p class="field-help">Actions queue a reviewed {{ lineDetail.managed ? 'whole-config render and reload' : 'sb user add/del' }}. Nothing changes on the node until approved; successful apply then reconciles runtime discovery.</p>
        <div v-if="lineUsersError" class="alert" role="alert"><CircleAlert :size="17" aria-hidden="true" /><span>{{ lineUsersError }}</span></div>
        <div class="binding-list">
          <div v-for="user in lineDetailBoundUsers" :key="user.id">
            <span>{{ user.email }}<small v-if="user.name"> ({{ user.name }})</small></span>
            <span class="icon-actions">
              <button class="button button-secondary button-compact" type="button" :disabled="lineUsersBusy" title="Queue a reviewed user update for this line" @click="planLineUser('plan_update', user.id)">Update</button>
              <button class="button button-secondary button-compact destructive" type="button" :disabled="lineUsersBusy" title="Queue sb user del for this line" @click="planLineUser('plan_remove', user.id)">Remove</button>
            </span>
          </div>
          <p v-if="!lineDetailBoundUsers.length" class="empty-inline">No identities bound to this line yet.</p>
        </div>
        <div v-if="lineDetailBindableUsers.length" class="binding-add">
          <select v-model="lineUserAdd"><option value="">Select an identity to add</option><option v-for="user in lineDetailBindableUsers" :key="user.id" :value="user.id">{{ user.email }}</option></select>
          <button class="button button-primary" type="button" :disabled="!lineUserAdd || lineUsersBusy" @click="bindAndApplyToLine"><Plus :size="15" /> Queue add</button>
        </div>
        <ul v-if="lineApprovals.length" class="detail-list">
          <li v-for="item in lineApprovals" :key="item.id"><span class="mono">{{ item.id }}</span> — {{ item.summary }} <em>(pending approval)</em></li>
        </ul>
      </section>
      <section class="detail-section"><h3>Error</h3><p :class="{ 'error-text': lineDetail.last_error }">{{ lineErrorText(lineDetail) }}</p></section>
      <section v-if="lineDetail.jump_edges?.length" class="detail-section"><h3>Relay targets</h3><ul class="detail-list"><li v-for="target in lineDetail.jump_edges" :key="target" class="mono">{{ target }} <span v-if="lineDetail.declared_jump_edges?.includes(target)" class="badge" data-tone="info">declared</span></li></ul></section>
      <section v-if="lineDetail.metadata && Object.keys(lineDetail.metadata).length" class="detail-section"><h3>Metadata</h3><dl class="detail-pairs"><template v-for="(value, key) in lineDetail.metadata" :key="key"><dt class="mono">{{ key }}</dt><dd>{{ value || '-' }}</dd></template></dl></section>
    </div></section></div>

    <div v-if="profileSettingsOpen" class="modal-backdrop" @mousedown.self="closeProfileSettings()"><section class="modal modal-large" role="dialog" aria-modal="true" aria-labelledby="profile-settings-title"><header><div><h2 id="profile-settings-title">sing-box integration</h2><p>{{ profileSettings?.node_name || profileSettings?.node_id || 'Node profile' }}</p></div><button class="icon-button" type="button" aria-label="Close" @click="closeProfileSettings()"><X :size="17" /></button></header>
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
            <label class="field field-wide"><span>sing-box stats API</span><input v-model="profileForm.singbox_stats_api" class="mono" type="text" placeholder="127.0.0.1:8080" autocomplete="off" /><small class="field-help">Loopback experimental API (sb stats on) — enables per-user stats (ADR-004).</small></label>
          </div>
          <section v-if="profileReconfigureCommand" class="detail-section"><h3>Generated agent command</h3><textarea class="command-output mono" :value="profileReconfigureCommand" readonly aria-label="Generated agent reconfiguration command" /></section>
        </template>
      </div>
      <footer><button class="button button-secondary" type="button" @click="closeProfileSettings()">Close</button><button v-if="profileSettings && canConfigureProfile" class="button button-primary" type="button" :disabled="profileSettingsSaving" @click="saveProfileSettings"><LoaderCircle v-if="profileSettingsSaving" class="spin" :size="15" /> Save settings</button></footer>
    </section></div>
  </main>
</template>
