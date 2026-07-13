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
  lineStatus,
  safeErrorMessage,
  type Line,
  type LineGroup,
  type VpnUser,
} from "./vpnModel";

const SERVICES = {
  lines: "latticenet.vpn-core/lines",
  users: "latticenet.vpn-core/users",
  admin: "latticenet.vpn-core/users-admin",
  profiles: "latticenet.vpn-core/profiles",
  subscriptions: "latticenet.vpn-core/subscriptions",
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

interface Subscription {
  user_id: string;
  email?: string;
  enabled: boolean;
  eligible: boolean;
  has_sub_token: boolean;
  binding_count: number;
  credential_count: number;
  expires_at?: string;
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
const subscriptions = ref<Subscription[]>([]);
const usage = ref<UsageResult>({ by_user: [], by_node: [], collectors: [], per_line: false });

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
  subscriptions: { title: "Subscriptions", description: "Secret-free delivery eligibility for every VPN identity.", icon: Link2 },
  usage: { title: "Usage", description: "Traffic accounting by user and reporting node.", icon: Gauge },
}[route.value] ?? { title: "VPN Core", description: "sing-box management", icon: Radar }));
const canAdmin = computed(() => ["create", "update", "delete", "bind", "unbind"].every((method) => canCall(init.value, SERVICES.admin, method)));
const visibleLineGroups = computed(() => filterLineGroups(lines.value, search.value));
const allLines = computed(() => lines.value.flatMap((group) => group.lines));
const healthyLines = computed(() => allLines.value.filter((line) => lineStatus(line) === "healthy").length);
const managedLines = computed(() => allLines.value.filter((line) => line.managed).length);
const lineOptions = computed(() => lines.value.flatMap((group) => group.lines.map((line) => ({
  id: line.line_hash_id,
  label: `${group.node_name || group.node_id} / ${line.name}`,
}))));
const enabledUsers = computed(() => users.value.filter((user) => user.enabled).length);
const totalBindings = computed(() => users.value.reduce((count, user) => count + user.bindings.length, 0));
const eligibleSubscriptions = computed(() => subscriptions.value.filter((subscription) => subscription.eligible).length);
const totalTraffic = computed(() => usage.value.by_user.reduce((sum, row) => sum + (row.used_bytes || 0), 0));

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
        const result = await pluginCall<{ groups: LineGroup[] }>(SERVICES.lines, "list");
        lines.value = result.groups ?? [];
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
      case "subscriptions": {
        const result = await pluginCall<{ subscriptions: Subscription[] }>(SERVICES.subscriptions, "query");
        subscriptions.value = result.subscriptions ?? [];
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

const userDialogOpen = ref(false);
const editingUser = ref<VpnUser>();
const savingUser = ref(false);
const userForm = reactive({
  email: "",
  name: "",
  enabled: true,
  quotaGiB: "",
  group: "",
  comment: "",
  protocol: "vless",
  secret: "",
  flow: "",
});

function openCreateUser(): void {
  editingUser.value = undefined;
  Object.assign(userForm, { email: "", name: "", enabled: true, quotaGiB: "", group: "", comment: "", protocol: "vless", secret: "", flow: "" });
  userDialogOpen.value = true;
}

function openEditUser(user: VpnUser): void {
  editingUser.value = user;
  Object.assign(userForm, {
    email: user.email,
    name: user.name ?? "",
    enabled: user.enabled,
    quotaGiB: user.quota_bytes ? String(user.quota_bytes / 1024 / 1024 / 1024) : "",
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
  savingUser.value = true;
  error.value = "";
  try {
    const quota = Number(userForm.quotaGiB);
    const payload: Record<string, unknown> = {
      email: userForm.email.trim(), name: userForm.name.trim(), enabled: userForm.enabled,
      quota_bytes: Number.isFinite(quota) && quota > 0 ? Math.round(quota * 1024 * 1024 * 1024) : 0,
      group: userForm.group.trim(), comment: userForm.comment.trim(),
    };
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
  if (!bindingUser.value || !bindingLine.value || bindingBusy.value) return;
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
  if (!bindingUser.value) return;
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
  if (!deleteTarget.value) return;
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

function displayEndpoint(line: Line): string {
  const host = line.domain || line.public_host || line.listen_host || "-";
  return line.listen_port ? `${host}:${line.listen_port}` : host;
}

function formatDate(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

async function resize(): Promise<void> {
  await nextTick();
  bridge?.resize(document.documentElement.scrollHeight);
}

let observer: ResizeObserver | undefined;
let poller: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  observer = new ResizeObserver(() => { void resize(); });
  observer.observe(document.body);
  poller = setInterval(() => { if (!loading.value && !userDialogOpen.value && !bindingUser.value && !deleteTarget.value) void loadCurrent(true); }, 20_000);
  void resize();
});

onBeforeUnmount(() => {
  observer?.disconnect();
  if (poller) clearInterval(poller);
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
      </section>
      <section class="toolbar"><input v-model="search" class="search-input" type="search" placeholder="Search node, line, protocol or status" /></section>
      <section v-if="visibleLineGroups.length" class="stack">
        <article v-for="group in visibleLineGroups" :key="group.node_id" class="data-panel">
          <header class="panel-header"><div><h2>{{ group.node_name || group.node_id }}</h2><p>{{ group.node_id }}</p></div><span class="count">{{ group.lines.length }} lines</span></header>
          <div class="table-wrap"><table><thead><tr><th>Line</th><th>Protocol</th><th>Endpoint</th><th>Source</th><th>Users</th><th>Status</th></tr></thead>
            <tbody><tr v-for="line in group.lines" :key="line.line_hash_id">
              <td><strong>{{ line.name }}</strong><small>{{ line.core }} / {{ line.line_hash_id }}</small></td>
              <td><span class="badge">{{ line.type || 'unknown' }}</span></td>
              <td class="mono">{{ displayEndpoint(line) }}</td>
              <td><span class="badge" :data-tone="line.managed ? 'info' : 'neutral'">{{ line.source }}</span></td>
              <td>{{ line.user_known ? line.user_count : '-' }}</td>
              <td><span class="status-dot" :data-tone="lineStatus(line)">{{ line.last_error || line.status || 'ok' }}</span></td>
            </tr></tbody></table></div>
        </article>
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
        <span v-if="!canAdmin" class="permission-note"><KeyRound :size="14" /> Read-only session</span>
        <button v-else class="button button-primary" type="button" @click="openCreateUser"><Plus :size="15" /> New identity</button>
      </section>
      <section class="data-panel"><div class="table-wrap"><table><thead><tr><th>Identity</th><th>Status</th><th>Credentials</th><th>Bindings</th><th>Quota</th><th class="actions-cell">Actions</th></tr></thead>
        <tbody><tr v-for="user in users" :key="user.id">
          <td><strong>{{ user.email }}</strong><small>{{ user.name || user.id }}<span v-if="user.migrated"> / migrated</span></small></td>
          <td><span class="status-dot" :data-tone="user.enabled ? 'healthy' : 'warning'">{{ user.enabled ? 'enabled' : 'disabled' }}</span></td>
          <td><span v-for="credential in user.credentials" :key="credential.protocol" class="badge credential">{{ credential.protocol }}<KeyRound v-if="credential.has_secret" :size="11" /></span><span v-if="!user.credentials.length">-</span></td>
          <td>{{ user.bindings.length }}</td><td>{{ user.quota_bytes ? formatBytes(user.quota_bytes) : 'Unlimited' }}</td>
          <td class="actions-cell"><div v-if="canAdmin" class="icon-actions">
            <button class="icon-button bordered" type="button" aria-label="Edit identity" title="Edit identity" @click="openEditUser(user)"><Pencil :size="14" /></button>
            <button class="icon-button bordered" type="button" aria-label="Manage line bindings" title="Manage line bindings" @click="bindingUser = user"><Link2 :size="14" /></button>
            <button class="icon-button bordered destructive" type="button" aria-label="Delete identity" title="Delete identity" @click="deleteTarget = user"><Trash2 :size="14" /></button>
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
      <section class="data-panel"><div class="table-wrap"><table><thead><tr><th>Node</th><th>Core</th><th>Ownership</th><th>Inbounds</th><th>Discovered</th><th>Collector</th><th>Runtime path</th></tr></thead>
        <tbody><tr v-for="profile in profiles" :key="profile.node_id">
          <td><strong>{{ profile.node_name || profile.node_id }}</strong><small>{{ profile.node_id }}</small></td>
          <td><span class="badge">{{ profile.core || 'unknown' }} {{ profile.core_version || '' }}</span></td>
          <td><span class="status-dot" :data-tone="profile.applied ? 'healthy' : profile.managed ? 'warning' : 'neutral'">{{ profile.managed ? (profile.applied ? 'managed / applied' : 'managed / pending') : 'observed' }}</span></td>
          <td>{{ profile.inbound_count }}</td><td>{{ profile.discovered_count }}</td>
          <td><span class="status-dot" :data-tone="profile.collector?.status === 'error' ? 'error' : profile.collector?.status === 'ok' ? 'healthy' : 'neutral'">{{ profile.collector?.status || 'not configured' }}</span></td>
          <td class="mono path-cell">{{ profile.config_path || '-' }}<small v-if="profile.last_error || profile.discovery_error" class="error-text">{{ profile.last_error || profile.discovery_error }}</small></td>
        </tr></tbody></table></div>
        <div v-if="!profiles.length" class="empty-state"><ServerCog :size="28" /><strong>No node profiles</strong><span>Profiles appear when a node is managed or reports discovery.</span></div>
      </section>
    </template>

    <template v-else-if="route === 'subscriptions'">
      <section class="summary-strip" aria-label="Subscription summary"><div><span>Identities</span><strong>{{ subscriptions.length }}</strong></div><div><span>Eligible</span><strong>{{ eligibleSubscriptions }}</strong></div><div><span>Token ready</span><strong>{{ subscriptions.filter((item) => item.has_sub_token).length }}</strong></div><div><span>Bound lines</span><strong>{{ subscriptions.reduce((sum, item) => sum + item.binding_count, 0) }}</strong></div></section>
      <section class="data-panel"><div class="table-wrap"><table><thead><tr><th>Identity</th><th>Eligibility</th><th>Source token</th><th>Credentials</th><th>Bindings</th><th>Expires</th></tr></thead>
        <tbody><tr v-for="subscription in subscriptions" :key="subscription.user_id"><td><strong>{{ subscription.email || subscription.user_id }}</strong><small>{{ subscription.user_id }}</small></td><td><span class="status-dot" :data-tone="subscription.eligible ? 'healthy' : 'warning'">{{ subscription.eligible ? 'eligible' : 'ineligible' }}</span></td><td><span class="badge" :data-tone="subscription.has_sub_token ? 'info' : 'neutral'">{{ subscription.has_sub_token ? 'ready' : 'missing' }}</span></td><td>{{ subscription.credential_count }}</td><td>{{ subscription.binding_count }}</td><td>{{ formatDate(subscription.expires_at) }}</td></tr></tbody></table></div>
        <div v-if="!subscriptions.length" class="empty-state"><Link2 :size="28" /><strong>No subscription sources</strong><span>Eligible identities remain source-only until a publisher plugin is installed.</span></div>
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
      <label class="field field-wide"><span>Email identity</span><input v-model="userForm.email" type="email" autocomplete="off" /></label><label class="field"><span>Display name</span><input v-model="userForm.name" type="text" /></label><label class="field"><span>Group</span><input v-model="userForm.group" type="text" /></label><label class="field"><span>Quota (GiB)</span><input v-model="userForm.quotaGiB" type="number" min="0" step="1" placeholder="Unlimited" /></label><label class="toggle-field"><input v-model="userForm.enabled" type="checkbox" /><span>Identity enabled</span></label>
      <template v-if="!editingUser"><label class="field"><span>Protocol</span><select v-model="userForm.protocol"><option v-for="protocol in ['vless','vmess','trojan','shadowsocks','hysteria2','tuic','anytls']" :key="protocol" :value="protocol">{{ protocol }}</option></select></label><label class="field"><span>{{ ['vless','vmess','tuic'].includes(userForm.protocol) ? 'UUID' : 'Password' }}</span><input v-model="userForm.secret" type="password" autocomplete="new-password" /></label><label class="field field-wide"><span>Flow override</span><input v-model="userForm.flow" type="text" placeholder="Optional" /></label></template>
      <label class="field field-wide"><span>Comment</span><textarea v-model="userForm.comment" rows="3" /></label></div><footer><button class="button button-secondary" type="button" @click="userDialogOpen = false">Cancel</button><button class="button button-primary" type="button" :disabled="savingUser || !userForm.email.trim()" @click="saveUser"><LoaderCircle v-if="savingUser" class="spin" :size="15" />{{ editingUser ? 'Save changes' : 'Create identity' }}</button></footer></section></div>

    <div v-if="bindingUser" class="modal-backdrop" @mousedown.self="bindingUser = undefined"><section class="modal" role="dialog" aria-modal="true"><header><div><h2>Line bindings</h2><p>{{ bindingUser.email }}</p></div><button class="icon-button" type="button" aria-label="Close" @click="bindingUser = undefined"><X :size="17" /></button></header><div class="binding-add"><select v-model="bindingLine"><option value="">Select an unbound line</option><option v-for="line in lineOptions.filter((option) => !currentBindingUser()?.bindings.some((binding) => binding.line_hash_id === option.id))" :key="line.id" :value="line.id">{{ line.label }}</option></select><button class="button button-primary" type="button" :disabled="!bindingLine || bindingBusy" @click="bindLine"><Plus :size="15" /> Bind</button></div><div class="binding-list"><div v-for="binding in currentBindingUser()?.bindings" :key="binding.line_hash_id"><span>{{ lineOptions.find((line) => line.id === binding.line_hash_id)?.label || binding.line_hash_id }}</span><button class="icon-button bordered destructive" type="button" aria-label="Remove binding" title="Remove binding" @click="unbindLine(binding.line_hash_id)"><Trash2 :size="14" /></button></div><p v-if="!currentBindingUser()?.bindings.length" class="empty-inline">No lines bound to this identity.</p></div></section></div>

    <div v-if="deleteTarget" class="modal-backdrop" @mousedown.self="deleteTarget = undefined"><section class="modal modal-small" role="alertdialog" aria-modal="true"><header><div><h2>Delete identity</h2><p>This removes plugin-owned credentials and line bindings.</p></div></header><p>Delete <strong>{{ deleteTarget.email }}</strong>?</p><footer><button class="button button-secondary" type="button" @click="deleteTarget = undefined">Cancel</button><button class="button button-danger" type="button" @click="deleteUser"><Trash2 :size="15" /> Delete</button></footer></section></div>
  </main>
</template>
