<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import {
  CircleAlert,
  Gauge,
  KeyRound,
  LoaderCircle,
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
import { attentionItems, livenessSummary, summarizeFleet, type AttentionItem } from "./fleetRows";
import LineChainWorkspace from "./LineChainWorkspace.vue";
import { lineBytes, lineStateOf, type GroupBy, type LineTrafficIndex } from "./lineGroups";
import { chainPath, hopRoleLabel } from "./linePath";
import LinesOverview from "./LinesOverview.vue";
import LinesTable from "./LinesTable.vue";
import {
  createStateSender,
  decodePageState,
  documentPageState,
  encodePageState,
  writeDocumentState,
  type LinesView,
  type PageState,
  type StateSender,
  type VpnPageState,
} from "./pageState";
import { bytesByLine, egressByLine, roleTotals, trafficByNode, type UsagePrevious, type UsageSeries } from "./trafficModel";
import UsageScreen from "./UsageScreen.vue";
import UserSheet from "./UserSheet.vue";
import { blankIdentityForm, quotaInput, saveIdentity, type IdentityForm, type IdentityInitial } from "./identityForm";
import UsersTable from "./UsersTable.vue";
import ProfileSheet from "./ProfileSheet.vue";
import ProfilesTable from "./ProfilesTable.vue";
import { profileHead, type Profile, type ProfilePluginConfig, type ProfileSettings } from "./profilesModel";
import {
  expiryDate,
  expiryInput,
  formatDay,
  lineOptions,
  usersAttention,
  usersSummary,
  type UserOutcome,
  type UserSort,
  type UsersAttentionItem,
  type UsersGroupBy,
  type UsersView,
} from "./usersModel";
import {
  attributionLabel,
  measurementLabel,
  roleLabel,
  usageAfterFailedRead,
  USAGE_PERIODS,
  periodLabel,
  type UsageLineRow,
  type StackBy,
  type UsagePeriod,
  type UsageView,
} from "./usageModel";
import { evidenceRoute, hostOriginFromHash, postNavigate, type EvidenceLens } from "./navigate";
import { LineWorkspaceLoader } from "./lineWorkspace";
import { MIN_ANCHOR_TOP, anchorTopFrom, clampAnchorTop, isInsideOverlay } from "./overlayAnchor";
import { useObservedAge } from "./observedAge";
import {
  formatBytes,
  formatLineDomain,
  formatLineEndpoint,
  formatLineListen,
  lineErrorText,
  lineOwnership,
  overlayTone,
  rolloutSummaryLine,
  safeErrorMessage,
  unresolvedOverlayDefs,
  type Line,
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
  /**
   * The attributed per-line rows. This is what the Usage screen renders: each
   * row says who the server placed the bytes on, on what evidence, and whether
   * the figure feeds a quota. The four collections above are the older
   * aggregate model and are kept so an older server still renders.
   */
  lines?: UsageLineRow[];
  /**
   * Bytes counted in more than one node total because they crossed a chain.
   * Stated, never reconciled: node totals count every hop and user totals
   * count the entry only, and both are correct.
   */
  double_counted_via_chains_bytes?: number;
  period?: string;
  from?: string;
  to?: string;
  /** Daily bytes per node and role. Omitted by a server older than design-22. */
  series?: UsageSeries;
  /** The equal-length window before this one, for today, 7d and 30d; omitted otherwise. */
  previous?: UsagePrevious;
}

const init = ref<HostInit>();
const bootError = ref("");
const error = ref("");
const notice = ref("");
const loading = ref(true);
const refreshing = ref(false);
const lines = ref<LineGroup[]>([]);
const chains = ref<LineChain[]>([]);
const users = ref<VpnUser[]>([]);
const profiles = ref<Profile[]>([]);
const emptyUsage = (): UsageResult => ({ by_user: [], by_node: [], rows: [], collectors: [], per_line: false, lines: [] });
const usage = ref<UsageResult>(emptyUsage());
/** The period `usage` was read for; undefined until a read succeeds. */
const usageReadPeriod = ref<UsagePeriod>();
/* The period is the operator's choice and it drives the server call, so it
 * lives here rather than inside the screen: a refresh must reload the period
 * being looked at, not the default one. */
/* Before the host says where the operator was, the page starts from its own
 * document query: empty under any real console, set only when a host that
 * keeps no page state let the frame keep it (see pageState.ts). */
const startState = decodePageState(documentPageState());
const usagePeriod = ref<UsagePeriod>(startState.period);
const managedDefs = ref<ManagedLineDef[]>([]);

let bridge: BridgeClient | undefined;
try {
  bridge = new BridgeClient(window);
  bridge.init.then(async (value) => {
    init.value = value;
    adoptPageState(value);
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
  lines: { title: "Lines", description: "Where traffic enters, which node it leaves from, and every line on the way.", icon: Radar },
  users: { title: "Users", description: "Who may sign in, with which credential, on which lines, until when.", icon: Users },
  profiles: { title: "Node Profiles", description: "What each node runs and whether its usage collector reports.", icon: ServerCog },
  usage: { title: "Usage", description: "Traffic over time, per exit, and who it belongs to where that is known.", icon: Gauge },
}[route.value] ?? { title: "VPN Core", description: "sing-box management", icon: Radar }));
// ── layers ───────────────────────────────────────────────────────────────
// Lines has four layers over one dataset and Usage four over its own. The
// layer (`view`), the open line (`open`), the table's grouping (`group`) and
// search (`q`), and Usage's period and chart stacking are the page's state,
// and the console keeps it in its own address (pageState.ts), so a reload
// lands where the operator was and a link names a state.
const linesView = ref<LinesView>(startState.linesView);
const usageView = ref<UsageView>(startState.usageView);
const groupBy = ref<GroupBy>(startState.group);
const search = ref(startState.q);
const usageStack = ref<StackBy>(startState.stack);
/** The object named by the address (a line, an identity, a node profile), opened once the listing that holds it arrives. */
const pendingOpen = ref(startState.open);
/* Users keeps the subset the attention list points at, its grouping and its
 * sort; the search and the open identity are the shared `q` and `open`. */
const usersView = ref<UsersView>(startState.usersView);
const usersGroup = ref<UsersGroupBy>(startState.usersGroup);
const usersSort = ref<UserSort>(startState.usersSort);

function applyPageState(state: VpnPageState): void {
  linesView.value = state.linesView;
  usageView.value = state.usageView;
  groupBy.value = state.group;
  search.value = state.q;
  pendingOpen.value = state.open;
  usagePeriod.value = state.period;
  usageStack.value = state.stack;
  usersView.value = state.usersView;
  usersGroup.value = state.usersGroup;
  usersSort.value = state.usersSort;
}

/* The open object in the address: the panel that is open, or, until the
 * listing arrives, the one the address asked for. */
const openInAddress = computed(() => {
  if (route.value === "users") return userOpenId.value || pendingOpen.value;
  if (route.value === "profiles") return profileOpenId.value || pendingOpen.value;
  return lineDetailOpen.value ? (lineDetail.value?.line_hash_id ?? "") : pendingOpen.value;
});

const pageState = computed<PageState>(() => encodePageState(route.value, {
  linesView: linesView.value,
  usageView: usageView.value,
  group: groupBy.value,
  q: search.value,
  // Until the listing arrives, an object the address asked for stays asked for.
  open: openInAddress.value,
  period: usagePeriod.value,
  stack: usageStack.value,
  usersView: usersView.value,
  usersGroup: usersGroup.value,
  usersSort: usersSort.value,
}));

/* The state goes out only after init, and only once the operator changes
 * something: before init the page has not seen the address, and right after
 * it the page's reading of that address (defaults filled in, unknown values
 * dropped) is not a reason to rewrite a pasted link. */
let stateSender: StateSender | undefined;
let hostKeepsState = false;

function adoptPageState(value: HostInit): void {
  hostKeepsState = value.pageState !== undefined;
  if (value.pageState) applyPageState(decodePageState(value.pageState));
  const client = bridge;
  stateSender?.dispose();
  stateSender = createStateSender((state) => client?.sendState(state), { baseline: pageState.value });
  publishPageState(pageState.value);
}

function publishPageState(state: PageState): void {
  if (!stateSender) return;
  // A host that keeps no page state ignores the message; the frame's own
  // query is then the only place the state can survive a frame reload.
  if (!hostKeepsState) writeDocumentState(state);
  stateSender.push(state);
}

const fleetSummary = computed(() => summarizeFleet(lines.value));
const attention = computed(() => attentionItems(lines.value));
const attentionErrors = computed(() => attention.value.filter((item) => item.severity === "error").length);
const attentionWarnings = computed(() => attention.value.filter((item) => item.severity === "warning").length);
const attentionTone = computed(() => attentionErrors.value ? "error" : attentionWarnings.value ? "warning" : "neutral");
/* What needs a hand: errors and warnings. Information items (no line is
 * managed, a liveness note) are legitimate states; they stay in the Attention
 * list but do not count toward its badge or take a place on the overview. */
const actionable = computed(() => attention.value.filter((item) => item.severity !== "info"));
/* One statement of what the probes said, so the proof line and the attention
 * row cannot disagree about it. */
const liveness = computed(() => livenessSummary(lines.value));

function nodeNameOf(id: string): string {
  const group = lines.value.find((value) => value.node_id === id);
  return group?.node_name || id;
}
/* The overview's node rows and map boxes open that node's lines: the Lines
 * layer, searched to the node, which lists them flat. */
function showLinesOf(nodeID: string): void {
  search.value = nodeNameOf(nodeID);
  linesView.value = "lines";
}
function showAllLines(): void {
  search.value = "";
  linesView.value = "lines";
}

// ── seven days of traffic for Lines ──────────────────────────────────────
const LINES_PERIOD: UsagePeriod = "7d";
const LINES_PERIOD_LABEL = "7 days";
const lineUsage = ref<UsageResult>();
const lineUsageError = ref("");
/* Known means read and measured: a fleet where no collector reports has
 * unknown traffic, and a zero there would be a claim nobody measured. */
const lineCollectorsReporting = computed(() => (lineUsage.value?.collectors ?? []).filter((row) => row.status === "ok").length);
const lineUsageKnown = computed(() => !!lineUsage.value && !lineUsageError.value
  && (lineCollectorsReporting.value > 0 || (lineUsage.value.lines ?? []).length > 0));
const lineTraffic = computed<LineTrafficIndex>(() => ({
  known: lineUsageKnown.value,
  byLine: bytesByLine(lineUsage.value?.lines),
  egressByLine: egressByLine(lineUsage.value?.lines),
  reportingNodes: new Set((lineUsage.value?.collectors ?? []).filter((row) => row.status === "ok").map((row) => row.node_id)),
}));
const lineNodeTraffic = computed(() => trafficByNode(lineUsage.value?.lines));
const lineEgress = computed(() => (lineUsageKnown.value ? roleTotals(lineUsage.value?.lines).egress : undefined));
const lineUsageNote = computed(() => {
  if (lineUsageError.value) return `Traffic is unknown, not zero: the usage read failed (${lineUsageError.value}).`;
  if (lineUsage.value) return "Traffic is unknown, not zero: no node reports usage. Set a usage source under Node Profiles.";
  return "Traffic is unknown, not zero: this session cannot read usage.";
});
const collectorsLine = computed(() => {
  if (lineUsageError.value || !lineUsage.value) return "traffic unknown";
  const all = lineUsage.value?.collectors ?? [];
  const ok = all.filter((row) => row.status === "ok").length;
  return ok === all.length ? `${all.length} collectors ok` : `${ok} of ${all.length} collectors ok`;
});

/* The proof line: when the page last heard from the control plane, as the
 * console says it ("observed 13s ago"), with the absolute time in a title.
 * The age ticks on a display clock that reads nothing (observedAge.ts); the
 * data is still read only when the operator asks (refreshPolicy.test.ts). */
const refreshedAt = ref<number>();
const observed = useObservedAge(() => refreshedAt.value);
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

function findLine(hash: string | undefined): { group: LineGroup; line: Line } | undefined {
  if (!hash) return undefined;
  for (const group of lines.value) {
    const line = group.lines.find((value) => value.line_hash_id === hash);
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
function openUsers(): void {
  if (!hostOrigin) return;
  postNavigate(window, "/plugins/latticenet.vpn-core/users", hostOrigin);
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
  const found = findLine(item.lineHashID);
  if (found) void openLineDetails(found.group, found.line);
}
/* Which attention actions this session can take, and what the button says.
 * A line's panel opens for any session; the actions inside it keep their gates. */
function canActOn(item: AttentionItem): boolean {
  if (item.action === "details") return !!findLine(item.lineHashID);
  if (item.action === "rollout") return canRollout.value;
  if (item.action === "profiles") return canOpenEvidence;
  return false;
}
function actionLabelOf(item: AttentionItem): string {
  return ({ details: "Open line", rollout: "Roll out", profiles: "Node Profiles", none: "" } as const)[item.action];
}
const allLines = computed(() => lines.value.flatMap((group) => group.lines));

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
const canViewLineDetails = computed(() => canCall(init.value, SERVICES.lines, "get"));
const canReadChains = computed(() => canCall(init.value, SERVICES.lines, "chains"));
const canPlanChain = computed(() => canCall(init.value, SERVICES.lines, "plan_chain"));
const canPlanRemoveChain = computed(() => canCall(init.value, SERVICES.lines, "plan_remove_chain"));
const canReadProfileSettings = computed(() => canCall(init.value, SERVICES.profiles, "settings"));
const canConfigureProfile = computed(() => canCall(init.value, SERVICES.profiles, "configure"));
const canPlanLineUsers = computed(() => ["plan_add", "plan_update", "plan_remove"]
  .every((method) => canCall(init.value, SERVICES.admin, method)));
const canRotateCredentials = computed(() => canCall(init.value, SERVICES.admin, "rotate"));
const canUsageQuery = computed(() => canCall(init.value, SERVICES.admin, "usage_query"));
const canSyncMetadata = computed(() => canCall(init.value, SERVICES.lines, "sync_metadata"));
const canReattachLine = computed(() => canCall(init.value, SERVICES.lines, "reattach"));
const canReadManaged = computed(() => canCall(init.value, SERVICES.lines, "managed"));
const canRollout = computed(() => canCall(init.value, SERVICES.lines, "rollout"));
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
        // Seven days of usage for the traffic cells, the map's widths and the
        // egress figure. Losing it costs those and nothing else, so it never
        // fails the page, and every figure it feeds says "unknown" instead.
        if (canCall(init.value, SERVICES.usage, "query")) {
          calls.push(pluginCall<UsageResult>(SERVICES.usage, "query", { period: LINES_PERIOD })
            .then((result) => { lineUsage.value = result; lineUsageError.value = ""; })
            .catch((cause) => { lineUsage.value = undefined; lineUsageError.value = safeErrorMessage(cause, "the usage read failed"); }));
        } else {
          lineUsage.value = undefined;
          lineUsageError.value = "";
        }
        await Promise.all(calls);
        if (pendingOpen.value) {
          const found = findLine(pendingOpen.value);
          pendingOpen.value = "";
          if (found) void openLineDetails(found.group, found.line);
        }
        break;
      }
      case "users": {
        // The line listing only names bindings and feeds the picker. Losing it
        // costs those, and the panel says so, so it never fails the page.
        const [userResult, lineResult] = await Promise.allSettled([
          pluginCall<{ users: VpnUser[] }>(SERVICES.users, "list"),
          pluginCall<{ groups: LineGroup[] }>(SERVICES.lines, "list"),
        ]);
        if (lineResult.status === "fulfilled") {
          lines.value = lineResult.value.groups ?? [];
          usersLinesError.value = "";
        } else {
          usersLinesError.value = safeErrorMessage(lineResult.reason, "the line list could not be read");
        }
        if (userResult.status === "rejected") throw userResult.reason;
        users.value = userResult.value.users ?? [];
        if (pendingOpen.value) {
          // Opened even when no identity has the id: the panel then says it is gone.
          userOpenId.value = pendingOpen.value;
          pendingOpen.value = "";
        }
        break;
      }
      case "profiles": {
        const result = await pluginCall<{ profiles: Profile[] }>(SERVICES.profiles, "query");
        profiles.value = result.profiles ?? [];
        if (pendingOpen.value) {
          const id = pendingOpen.value;
          pendingOpen.value = "";
          profileOpenId.value = id;
          if (profiles.value.some((profile) => profile.node_id === id)) void loadProfileSettings(id);
        }
        break;
      }
      case "usage": {
        // The line listing names the hashes the collector reports against and
        // the user listing carries each quota. Both are the same cached read
        // models the other views use, so this costs cache reads on the server
        // rather than a second fleet walk.
        const period = usagePeriod.value;
        let usageResult: UsageResult;
        let lineResult: { groups: LineGroup[] };
        try {
          [usageResult, lineResult] = await Promise.all([
            pluginCall<UsageResult>(SERVICES.usage, "query", { period }),
            pluginCall<{ groups: LineGroup[] }>(SERVICES.lines, "list"),
          ]);
        } catch (cause) {
          usage.value = usageAfterFailedRead(usage.value, usageReadPeriod.value, period, emptyUsage());
          if (usageReadPeriod.value !== period) usageReadPeriod.value = undefined;
          throw cause;
        }
        usageReadPeriod.value = period;
        usage.value = { ...usageResult, rows: usageResult.rows ?? [], lines: usageResult.lines ?? [], collectors: usageResult.collectors ?? [] };
        lines.value = lineResult.groups ?? [];
        // Quotas belong to the identity, not to the usage rows, so the screen
        // needs the user listing to say "91% of 500 GiB". Losing it costs the
        // quota column and nothing else, so it must not fail the whole page.
        try {
          const userResult = await pluginCall<{ users: VpnUser[] }>(SERVICES.users, "list");
          users.value = userResult.users ?? [];
        } catch {
          users.value = [];
        }
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

async function setUsagePeriod(period: UsagePeriod): Promise<void> {
  if (period === usagePeriod.value || refreshing.value) return;
  usagePeriod.value = period;
  await loadCurrent(true);
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

// ── Users ────────────────────────────────────────────────────────────────
// The page reads the list once per load and holds no timer, so "now" is the
// moment of the read: expiry and "within 30 days" are judged against it.
const usersNow = computed(() => refreshedAt.value ?? Date.now());
const userSummary = computed(() => usersSummary(users.value, usersNow.value));
const userAttention = computed(() => usersAttention(users.value, usersNow.value, formatDay));
const USER_ATTENTION_SHOWN = 3;
const lineChoices = computed(() => lineOptions(lines.value));
/** Why the line list is missing on the Users page, when it is. */
const usersLinesError = ref("");
const userCan = computed(() => ({
  edit: canUpdateUser.value,
  rotate: canRotateCredentials.value,
  bind: canBindUser.value,
  unbind: canUnbindUser.value,
  delete: canDeleteUser.value,
}));
const usersTable = ref<InstanceType<typeof UsersTable>>();

/* The outcome of the last action, shown beside the row it changed and in the
 * identity's panel, until the bridge has a toast. */
const userOutcome = ref<UserOutcome>();
function tellOutcome(user: Pick<VpnUser, "id">, text: string, tone: UserOutcome["tone"] = "success", anchor = user.id): void {
  userOutcome.value = { userId: user.id, anchor, text, tone };
}

const nextExpiryNote = computed(() => {
  const next = userSummary.value.expiring[0];
  const at = next ? expiryDate(next.expires_at) : undefined;
  return next && at ? `next: ${next.email}, ${formatDay(at)}` : "none in the next 30 days";
});

function showUsersView(item: UsersAttentionItem): void {
  search.value = "";
  usersView.value = item.view;
}

/* ── the identity panel, addressed by ?open=<id> ─────────────────────── */
const userOpenId = ref("");
const openUser = computed(() => users.value.find((user) => user.id === userOpenId.value));
const bindingsFocus = ref(0);
let userOpener: HTMLElement | null = null;

function rememberOpener(): HTMLElement | null {
  const active = typeof document === "undefined" ? null : document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

function openUserPanel(user: VpnUser, focusBindings = false): void {
  if (userOpenId.value !== user.id) userOpener = rememberOpener();
  userOpenId.value = user.id;
  if (focusBindings) bindingsFocus.value += 1;
}

/* Focus goes back to the row that opened the panel, or the same identity's
 * row when that element was re-rendered. A delete closes the panel itself
 * and places focus after the reload. */
function closeUserPanel(): void {
  const id = userOpenId.value;
  const opener = userOpener;
  userOpener = null;
  userOpenId.value = "";
  void nextTick(() => {
    if (opener?.isConnected) {
      opener.focus();
      return;
    }
    if (id && typeof document !== "undefined") document.querySelector<HTMLElement>(`[data-user-open="${CSS.escape(id)}"]`)?.focus();
  });
}

/* ── create and edit ─────────────────────────────────────────────────── */
const userDialogOpen = ref(false);
const editingUser = ref<VpnUser>();
const savingUser = ref(false);
const userDialogError = ref("");
/** What the dialog opened with: the quota and the expiry send only on change. */
let initial: IdentityInitial = { quotaGiB: "", expiresAt: "" };
const expiryHelp = computed(() => {
  if (!editingUser.value) return "Optional. Empty means it never expires.";
  if (!initial.expiresAt) return "It has no expiry. Set one here, or leave the field empty.";
  return userForm.expiresAt.trim() ? "Empty the field, or use No expiry, to remove the expiry." : "Saving removes the expiry: the identity will not expire.";
});
const quotaHelp = computed(() => {
  if (!editingUser.value) return "Blank or 0 is unlimited.";
  if (!initial.quotaGiB) return "It has no quota. Enter GiB to set one.";
  return userForm.quotaGiB.trim() ? "Empty the field, or enter 0, to remove the quota." : "Saving removes the quota: the identity will be unlimited.";
});
const userForm = reactive<IdentityForm>(blankIdentityForm());

function openCreateUser(): void {
  editingUser.value = undefined;
  userDialogError.value = "";
  initial = { quotaGiB: "", expiresAt: "" };
  Object.assign(userForm, blankIdentityForm());
  userDialogOpen.value = true;
}

function openEditUser(user: VpnUser): void {
  editingUser.value = user;
  userDialogError.value = "";
  initial = { quotaGiB: quotaInput(user.quota_bytes), expiresAt: expiryInput(user.expires_at) };
  Object.assign(userForm, {
    email: user.email,
    name: user.name ?? "",
    enabled: user.enabled,
    quotaGiB: initial.quotaGiB,
    quotaPeriod: user.quota_period === "monthly" ? "monthly" : "none",
    quotaResetDay: user.quota_reset_day ? String(user.quota_reset_day) : "",
    expiresAt: initial.expiresAt,
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
  userDialogError.value = "";
  try {
    // identityForm.ts builds the payload and owns the field rules; this only
    // sends it and says what happened.
    const user = editingUser.value;
    const { write, createdId } = await saveIdentity(
      (method, payload) => pluginCall(SERVICES.admin, method, payload),
      userForm,
      initial,
      user,
    );
    const email = userForm.email.trim();
    if (user) {
      const notes = [write.removed.quota ? " It no longer has a quota." : "", write.removed.expiry ? " It no longer expires." : ""].join("");
      tellOutcome(user, `${email} saved.${notes}`);
    } else if (createdId) {
      tellOutcome({ id: createdId }, `${email} created. It is bound to no line yet: open it to bind one.`);
    }
    userDialogOpen.value = false;
    await loadCurrent(true);
  } catch (cause) {
    // The form stays open with what was typed; the reason is said inside it.
    userDialogError.value = safeErrorMessage(cause, "The identity could not be saved");
  } finally {
    savingUser.value = false;
  }
}

/** The bound-identity list could not be refreshed, so it must not be read as empty. */
const usersUnavailable = ref(false);

/* ── bindings, from the identity panel ───────────────────────────────── */
const bindingBusy = ref(false);
const unbindBusy = ref(false);

function lineTitle(hash: string): string {
  const option = lineChoices.value.find((value) => value.hash === hash);
  return option ? `${option.node} / ${option.name}` : hash;
}

async function bindLine(user: VpnUser, hash: string): Promise<void> {
  if (!hash || bindingBusy.value || !canBindUser.value) return;
  bindingBusy.value = true;
  try {
    await pluginCall(SERVICES.admin, "bind", { user_id: user.id, line_hash_id: hash });
    tellOutcome(user, `${user.email} is bound to ${lineTitle(hash)}. The node gets the credential when that line is planned and applied.`);
    await loadCurrent(true);
  } catch (cause) {
    tellOutcome(user, `The binding was not added: ${safeErrorMessage(cause, "the server gave no reason")}`, "error");
  } finally {
    bindingBusy.value = false;
  }
}

async function unbindLine(user: VpnUser, hash: string): Promise<void> {
  if (!canUnbindUser.value || unbindBusy.value) return;
  unbindBusy.value = true;
  try {
    await pluginCall(SERVICES.admin, "unbind", { user_id: user.id, line_hash_id: hash });
    tellOutcome(user, `${user.email} is no longer bound to ${lineTitle(hash)}. The credential stays on that node until the line is planned and applied again.`);
    await loadCurrent(true);
  } catch (cause) {
    tellOutcome(user, `The binding was not removed: ${safeErrorMessage(cause, "the server gave no reason")}`, "error");
  } finally {
    unbindBusy.value = false;
  }
}

/* ── delete: breaks the identity's subscription link, so the email is typed ── */
const deleteTarget = ref<VpnUser>();
const deletingUser = ref(false);
const deleteTyped = ref("");
const deleteError = ref("");
const deleteImpact = computed(() => {
  const user = deleteTarget.value;
  if (!user) return [] as string[];
  const bindings = user.bindings.length;
  return [
    "Its subscription link stops answering, so a client that refreshes it loses every line it listed.",
    bindings
      ? `Its ${bindings} line ${bindings === 1 ? "binding goes" : "bindings go"} with it. The credential stays on ${bindings === 1 ? "that line's node" : "those lines' nodes"} until each line is planned and applied again.`
      : "It is bound to no line, so no line loses a binding.",
    "It cannot be undone. A new identity with the same email gets a new credential and a new subscription link.",
  ];
});

function askDeleteUser(user: VpnUser): void {
  deleteTyped.value = "";
  deleteError.value = "";
  deleteTarget.value = user;
}

async function deleteUser(): Promise<void> {
  const user = deleteTarget.value;
  if (!user || !canDeleteUser.value || deletingUser.value || deleteTyped.value.trim() !== user.email) return;
  deletingUser.value = true;
  deleteError.value = "";
  // The row above the deleted one carries the outcome, where the row was.
  const anchor = usersTable.value?.anchorBefore(user.id) ?? "";
  try {
    await pluginCall(SERVICES.admin, "delete", { id: user.id });
    deleteTarget.value = undefined;
    tellOutcome(user, `${user.email} deleted. Its subscription link no longer answers.`, "success", anchor);
    // The panel, if the delete ran from it, closes without handing focus
    // back: its opener is the row that is about to go.
    if (userOpenId.value === user.id) {
      userOpener = null;
      userOpenId.value = "";
    }
    await loadCurrent(true);
    // Whichever way the delete ran, the keyboard goes to the row that now
    // sits where the deleted one was, beside the outcome: the row above it,
    // the first row when it was first, the create action when none is left.
    await nextTick();
    const target =
      (anchor ? document.querySelector<HTMLElement>(`[data-user-open="${CSS.escape(anchor)}"]`) : null) ??
      document.querySelector<HTMLElement>(".users-panel [data-user-open]") ??
      document.querySelector<HTMLElement>(".users-panel .empty-state button");
    target?.focus();
  } catch (cause) {
    deleteError.value = safeErrorMessage(cause, "The identity could not be deleted");
  } finally {
    deletingUser.value = false;
  }
}

/* ── the line panel's read-only parts ───────────────────────────────────── */
const lineDetailPath = computed(() => (lineDetail.value ? chainPath(lines.value, lineDetail.value) : []));
const lineDetailState = computed(() => (lineDetail.value ? lineStateOf(lineDetail.value) : undefined));
const lineDetailRows = computed<UsageLineRow[]>(() =>
  (lineUsage.value?.lines ?? []).filter((row) => !!lineDetail.value && row.line_hash_id === lineDetail.value.line_hash_id));
const lineDetailBytes = computed(() => (lineDetail.value ? lineBytes(lineTraffic.value, lineDetail.value) : undefined));
const lineDetailUp = computed(() => lineDetailRows.value.reduce((sum, row) => sum + (row.uplink || 0), 0));
const lineDetailDown = computed(() => lineDetailRows.value.reduce((sum, row) => sum + (row.downlink || 0), 0));

function formatDate(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

const lineDetailOpen = ref(false);
const lineDetailBusy = ref(false);
const lineDetailError = ref("");
const lineDetail = ref<Line>();
const lineDetailNodeName = ref("");

/* The panel opens from the listing for any session; the detail read, which
 * adds metadata and the declared identity, runs where the session may call it. */
async function openLineDetails(group: LineGroup, line: Line): Promise<void> {
  // Remember what opened the panel, so closing it puts keyboard focus back on
  // that row instead of the top of a 136-row table.
  const active = typeof document === "undefined" ? null : document.activeElement;
  lineDetailOpener = active instanceof HTMLElement && active !== document.body ? active : null;
  lineDetail.value = line;
  lineDetailNodeName.value = group.node_name || group.node_id;
  lineDetailError.value = "";
  lineApprovals.value = [];
  lineUsersError.value = "";
  lineUserAdd.value = "";
  lineDetailOpen.value = true;
  if (canViewLineDetails.value) {
    lineDetailBusy.value = true;
    try {
      const result = await pluginCall<{ line: Line }>(SERVICES.lines, "get", { line_hash_id: line.line_hash_id });
      if (result.line && lineDetail.value?.line_hash_id === line.line_hash_id) lineDetail.value = result.line;
    } catch (cause) {
      lineDetailError.value = safeErrorMessage(cause, "Line details are unavailable");
    } finally {
      lineDetailBusy.value = false;
    }
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

let lineDetailOpener: HTMLElement | null = null;

/* Focus returns to the opener, or, when that element was re-rendered while
 * the panel was open, to the same line's row button. */
function restoreLineFocus(hash: string | undefined): void {
  const opener = lineDetailOpener;
  lineDetailOpener = null;
  if (opener?.isConnected) {
    opener.focus();
    return;
  }
  if (!hash || typeof document === "undefined") return;
  document.querySelector<HTMLElement>(`[data-line-open="${CSS.escape(hash)}"]`)?.focus();
}

function closeLineDetails(): void {
  const hash = lineDetail.value?.line_hash_id;
  void nextTick(() => restoreLineFocus(hash));
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
const rotateError = ref("");
const rotateRevealed = ref<{ email: string; protocol: string; secret: string }>();

function openRotate(user: VpnUser, protocol?: string): void {
  rotateError.value = "";
  rotateUser.value = user;
  rotateProtocol.value = protocol ?? user.credentials[0]?.protocol ?? "";
}

async function rotateCredential(): Promise<void> {
  const user = rotateUser.value;
  if (!user || !rotateProtocol.value || rotateBusy.value) return;
  rotateBusy.value = true;
  rotateError.value = "";
  try {
    const result = await pluginCall<{ protocol: string; revealed_credential: string }>(
      SERVICES.admin, "rotate", { user_id: user.id, protocol: rotateProtocol.value });
    rotateRevealed.value = { email: user.email, protocol: result.protocol, secret: result.revealed_credential };
    rotateUser.value = undefined;
    tellOutcome(user, `${user.email}: new ${result.protocol} secret issued. The old one keeps working on each bound line until that line is planned and applied again.`);
    await loadCurrent(true);
  } catch (cause) {
    rotateError.value = safeErrorMessage(cause, "The credential could not be rotated");
  } finally {
    rotateBusy.value = false;
  }
}

// ── Node Profiles: the panel, addressed by ?open=<node_id> ─────────────────
const profileHeadline = computed(() => profileHead(profiles.value));
const profileOpenId = ref("");
const openProfile = computed(() => profiles.value.find((profile) => profile.node_id === profileOpenId.value));
const profileSettingsBusy = ref(false);
const profileSettingsSaving = ref(false);
const profileSettingsError = ref("");
const profileSettings = ref<ProfileSettings>();
const profileReconfigureCommand = ref("");
const profileSavedAt = ref("");
let profileOpener: HTMLElement | null = null;

async function loadProfileSettings(nodeID: string): Promise<void> {
  profileSettings.value = undefined;
  profileSettingsError.value = "";
  profileReconfigureCommand.value = "";
  profileSavedAt.value = "";
  if (!canReadProfileSettings.value) return;
  profileSettingsBusy.value = true;
  try {
    const result = await pluginCall<ProfileSettings>(SERVICES.profiles, "settings", { node_id: nodeID });
    if (profileOpenId.value === nodeID) profileSettings.value = result;
  } catch (cause) {
    if (profileOpenId.value === nodeID) profileSettingsError.value = safeErrorMessage(cause, "This node's settings could not be read");
  } finally {
    profileSettingsBusy.value = false;
  }
}

function openProfilePanel(profile: Profile): void {
  if (profileOpenId.value === profile.node_id) return;
  profileOpener = rememberOpener();
  profileOpenId.value = profile.node_id;
  void loadProfileSettings(profile.node_id);
}

function closeProfilePanel(): void {
  const id = profileOpenId.value;
  const opener = profileOpener;
  profileOpener = null;
  profileOpenId.value = "";
  profileSettings.value = undefined;
  profileSettingsError.value = "";
  profileReconfigureCommand.value = "";
  void nextTick(() => {
    if (opener?.isConnected) opener.focus();
    else if (id && typeof document !== "undefined") document.querySelector<HTMLElement>(`[data-profile-open="${CSS.escape(id)}"]`)?.focus();
  });
}

async function saveProfileSettings(config: ProfilePluginConfig): Promise<void> {
  const settings = profileSettings.value;
  if (!settings || !canConfigureProfile.value || profileSettingsSaving.value) return;
  profileSettingsSaving.value = true;
  profileSettingsError.value = "";
  profileReconfigureCommand.value = "";
  try {
    const result = await pluginCall<{ command?: string; settings: ProfileSettings }>(SERVICES.profiles, "configure", {
      node_id: settings.node_id,
      ...config,
    });
    profileSettings.value = result.settings;
    profileReconfigureCommand.value = result.command ?? "";
    const date = new Date();
    const pad = (value: number) => value.toString().padStart(2, "0");
    profileSavedAt.value = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    await loadCurrent(true);
  } catch (cause) {
    profileSettingsError.value = safeErrorMessage(cause, "This node's settings could not be saved");
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
  usage: true,
}[route.value] ?? false));

const overlayAnchorTop = ref(MIN_ANCHOR_TOP);
const overlayStyle = computed(() => ({ "--overlay-anchor-top": `${overlayAnchorTop.value}px` }));

// Which overlay is on top, not merely whether one is. Rotating a credential
// closes the confirm dialog and opens the reveal in the same tick; a boolean
// stays true across that swap, so the reveal would never be focused or
// clamped. A changing key fires the watcher on every handover. The side
// panels sit under the dialogs (a dialog opens over the identity's panel),
// in the stylesheet as well as here.
const openOverlayKey = computed(() => {
  if (rotateRevealed.value) return "rotate-revealed";
  if (deleteTarget.value) return "delete";
  if (rotateUser.value) return "rotate";
  if (rolloutOpen.value) return "rollout";
  if (userDialogOpen.value) return "user";
  if (profileOpenId.value) return "profile-detail";
  if (userOpenId.value) return "user-detail";
  if (lineDetailOpen.value) return "line-detail";
  return "";
});
const overlayOpen = computed(() => openOverlayKey.value !== "");
const SIDE_PANELS = new Set(["user-detail", "profile-detail", "line-detail"]);

function recordAnchor(event: Event): void {
  // A click inside an open overlay must not move the anchor, or the next one
  // opens against a place the operator never pointed at.
  if (overlayOpen.value || isInsideOverlay(event.target)) return;
  overlayAnchorTop.value = anchorTopFrom(event);
}

function closeTopOverlay(): void {
  // rotateRevealed is deliberately not dismissible here: it is the one-time
  // display of a secret, and losing it to a stray Escape means rotating again.
  if (rotateRevealed.value) return;
  if (deleteTarget.value) deleteTarget.value = undefined;
  else if (rotateUser.value) rotateUser.value = undefined;
  else if (rolloutOpen.value) closeRollout();
  else if (userDialogOpen.value) userDialogOpen.value = false;
  else if (profileOpenId.value) closeProfilePanel();
  else if (userOpenId.value) closeUserPanel();
  else if (lineDetailOpen.value) closeLineDetails();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && overlayOpen.value) closeTopOverlay();
}

/* A dialog remembers what had focus when it opened (a row menu's trigger, a
 * button in the identity's panel) and gives it back when it closes, so the
 * keyboard is never dropped at the top of the document. The side panels do
 * the same for their rows in their own close functions. */
let dialogOpener: HTMLElement | null = null;
watch(openOverlayKey, async (key, previous) => {
  const closedDialog = !!previous && !SIDE_PANELS.has(previous);
  const returnTo = closedDialog ? dialogOpener : null;
  if (key && !SIDE_PANELS.has(key) && (!previous || SIDE_PANELS.has(previous))) dialogOpener = rememberOpener();
  if (!key || SIDE_PANELS.has(key)) dialogOpener = null;
  await nextTick();
  if (closedDialog && (!key || SIDE_PANELS.has(key)) && returnTo?.isConnected) {
    returnTo.focus();
    return;
  }
  if (!key) return;
  const panel = document.querySelector<HTMLElement>(`[data-overlay="${key}"] .modal`);
  if (!panel) return;
  // Clamp only once the real height is known; clamping against a guessed
  // height pushes short dialogs up for no reason.
  overlayAnchorTop.value = clampAnchorTop(overlayAnchorTop.value, panel.offsetHeight, document.documentElement.scrollHeight);
  // Escape only reaches a focused element, and a dialog the operator cannot
  // dismiss with Escape is the worst one to get wrong. A panel the focus is
  // already inside keeps it.
  if (panel.contains(document.activeElement)) return;
  (panel.querySelector<HTMLElement>("[data-autofocus]") ?? panel).focus();
});

// Nothing here measures this document's height. The host frame is a viewport
// the host sizes itself, so a page that reported its own height was running a
// full synchronous layout of an 8800px document on every body resize and
// throwing the answer away.

/* Here rather than beside pageState: the watcher reads its getter at once,
 * and that getter touches refs declared further down the setup. */
watch(pageState, publishPageState);

onMounted(() => {
  document.addEventListener("pointerdown", recordAnchor, true);
  window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", recordAnchor, true);
  window.removeEventListener("keydown", onKeydown);
  stateSender?.dispose();
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
      <div class="header-actions">
        <div v-if="route === 'usage'" class="period-picker" role="group" aria-label="Usage period">
          <button
            v-for="value in USAGE_PERIODS"
            :key="value"
            class="period-option"
            type="button"
            :aria-pressed="usagePeriod === value"
            :disabled="refreshing"
            @click="setUsagePeriod(value)"
          >{{ periodLabel(value) }}</button>
        </div>
        <button class="button button-secondary" type="button" :disabled="loading || refreshing" @click="loadCurrent(true)">
          <LoaderCircle v-if="refreshing" class="spin" :size="15" aria-hidden="true" />
          <RefreshCw v-else :size="15" aria-hidden="true" />
          Refresh
        </button>
        <button v-if="route === 'lines' && canRollout && allLines.length" class="button button-primary" type="button" @click="openRollout"><Plus :size="15" aria-hidden="true" /> Roll out managed lines</button>
        <span v-if="route === 'users' && init && !hasUserMutations" class="permission-note"><KeyRound :size="14" aria-hidden="true" /> Read-only session</span>
        <!-- With no identity yet the empty state carries the create action; the header does not repeat it. -->
        <button v-if="route === 'users' && canCreateUser && users.length" class="button button-primary" type="button" @click="openCreateUser"><Plus :size="15" aria-hidden="true" /> New identity</button>
      </div>
    </header>

    <!-- A partial failure: the page shows what it read and says what it did not.
         A total one is said once, below, with one way to try again. -->
    <div v-if="error && !bootError && hasRouteData" class="alert" role="alert">
      <CircleAlert :size="17" aria-hidden="true" />
      <span><strong>{{ routeMeta.title }} did not fully load</strong>{{ error }}</span>
      <button class="button button-secondary button-compact" type="button" :disabled="refreshing" @click="loadCurrent(true)">
        <LoaderCircle v-if="refreshing" class="spin" :size="13" aria-hidden="true" /> Try again
      </button>
      <button class="icon-button" type="button" aria-label="Dismiss error" title="Dismiss error" @click="error = ''"><X :size="15" /></button>
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

    <div v-else-if="(bootError || error) && !hasRouteData" class="empty-state failure-state" role="alert">
      <CircleAlert :size="26" aria-hidden="true" />
      <strong>{{ bootError ? 'This page has no console session' : `${routeMeta.title} could not be read` }}</strong>
      <p class="failure-reason">{{ bootError || error }}</p>
      <p>An empty page after a failed read is an unanswered question, not an empty fleet, so no count is shown.</p>
      <div v-if="!bootError" class="empty-actions"><button class="button button-secondary" type="button" :disabled="refreshing" @click="loadCurrent(true)"><LoaderCircle v-if="refreshing" class="spin" :size="15" aria-hidden="true" /><RefreshCw v-else :size="15" aria-hidden="true" /> Try again</button></div>
    </div>

    <template v-else-if="route === 'lines'">
      <p class="proof-line" aria-live="polite">
        <span v-if="refreshedAt" :title="observed.title.value">observed {{ observed.age.value }} ago</span>
        <span v-else>not observed yet</span>
        <span>· {{ fleetSummary.nodes }} {{ fleetSummary.nodes === 1 ? 'node reports' : 'nodes report' }}</span>
        <span>· {{ fleetSummary.lines }} lines</span>
        <span>· {{ collectorsLine }}</span>
        <span>· {{ livenessLine }}</span>
        <span v-if="refreshing">· refreshing</span>
      </p>
      <nav class="layer-tabs" role="tablist" aria-label="Lines layers">
        <button class="layer-tab" role="tab" type="button" :aria-selected="linesView === 'overview'" @click="linesView = 'overview'">Overview</button>
        <button class="layer-tab" role="tab" type="button" :aria-selected="linesView === 'lines'" @click="linesView = 'lines'">Lines<span class="lens-count">{{ fleetSummary.lines }}</span></button>
        <button class="layer-tab" role="tab" type="button" :aria-selected="linesView === 'topology'" @click="linesView = 'topology'">Topology</button>
        <button class="layer-tab" role="tab" type="button" :aria-selected="linesView === 'attention'" @click="linesView = 'attention'">
          Attention<span v-if="actionable.length" class="lens-count" :data-tone="attentionTone">{{ actionable.length }}</span>
        </button>
      </nav>
      <section v-if="unresolvedDefs.length" class="data-panel overlay-strip" aria-label="Managed line rollout status">
        <div v-for="def in unresolvedDefs" :key="def.line_uuid" class="overlay-def">
          <span class="badge" :data-tone="overlayTone(def.status)">{{ def.status }}</span>
          <strong>{{ def.node_id }}</strong>
          <span class="mono">{{ def.tag }} · :{{ def.port }}</span>
          <span v-if="def.last_error" class="error-text">{{ def.last_error }}</span>
          <span v-else-if="def.status === 'planned'" class="muted">awaiting approval</span>
        </div>
      </section>

      <div v-if="linesView === 'overview'" class="layer-body" role="tabpanel" aria-label="Overview">
        <LinesOverview
          :groups="lines"
          :chains="chains"
          :attention="actionable"
          :usage-known="lineUsageKnown"
          :usage-note="lineUsageNote"
          :egress="lineEgress"
          :by-line="lineTraffic.byLine"
          :by-node="lineNodeTraffic"
          :reporting-nodes="lineTraffic.reportingNodes"
          :series="lineUsage?.series"
          :previous="lineUsage?.previous"
          :period-label="LINES_PERIOD_LABEL"
          :can-act="canActOn"
          :action-label="actionLabelOf"
          @attention="openAttention"
          @show-attention="linesView = 'attention'"
          @node="showLinesOf"
          @lines="showAllLines"
        />
      </div>

      <div v-else-if="linesView === 'lines'" class="layer-body" role="tabpanel" aria-label="Lines">
        <p v-if="!lineUsageKnown && allLines.length" class="panel-inline-note standalone-note"><CircleAlert :size="14" aria-hidden="true" /> {{ lineUsageNote }}</p>
        <LinesTable
          v-model:group-by="groupBy"
          v-model:search="search"
          :groups="lines"
          :traffic="lineTraffic"
          :period-label="LINES_PERIOD_LABEL"
          :can-open-evidence="canOpenEvidence"
          :open-line="lineDetailOpen ? lineDetail?.line_hash_id : undefined"
          @open="openLineDetails"
          @evidence="openEvidence"
        />
      </div>

      <div v-else-if="linesView === 'topology'" class="layer-body" role="tabpanel" aria-label="Topology">
        <LineChainWorkspace v-if="canReadChains" :groups="lines" :chains="chains" :can-plan="canPlanChain" :can-remove="canPlanRemoveChain" :busy-sources="busyChainSources" @plan="planLineChain" @remove="planLineChainRemoval" />
        <section v-else class="data-panel">
          <div class="empty-state">
            <Radar :size="26" aria-hidden="true" />
            <strong>This session cannot read chains</strong>
            <p>The topology layer needs <span class="mono">lines.chains</span>, which this session's token does not carry. The Lines layer still shows every line and the node it dials.</p>
          </div>
        </section>
      </div>

      <section v-else class="data-panel attention-panel" role="tabpanel" aria-labelledby="attention-title">
        <header class="panel-header">
          <div><h2 id="attention-title">Attention</h2><p>Every claim this page can prove that needs a hand, with the row that proves it and the action that clears it.</p></div>
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
              <button v-if="canActOn(item)" class="button button-secondary button-compact" type="button" @click="openAttention(item)">{{ actionLabelOf(item) }}</button>
              <span v-else-if="item.action === 'profiles'" class="muted">Node Profiles, in this plugin's navigation</span>
            </div>
          </li>
        </ol>
        <div v-else class="empty-state">
          <Radar :size="26" aria-hidden="true" />
          <strong>Nothing needs attention</strong>
          <p v-if="allLines.length">Every line reports a clean config, every relay resolves to a fleet endpoint, and the lines that report liveness are running.</p>
          <p v-else>No node has reported a line, so there is nothing here to check yet.</p>
        </div>
      </section>
    </template>

    <template v-else-if="route === 'users'">
      <p class="proof-line" aria-live="polite">
        <span v-if="refreshedAt" :title="observed.title.value">observed {{ observed.age.value }} ago</span>
        <span v-else>not observed yet</span>
        <span>· {{ userSummary.total }} {{ userSummary.total === 1 ? 'identity' : 'identities' }}</span>
        <span>· {{ userSummary.enabled }} enabled</span>
        <span v-if="userSummary.total">· {{ userSummary.usageReported ? `usage attributed for ${userSummary.attributed}` : 'usage not reported per identity' }}</span>
        <span v-if="refreshing">· refreshing</span>
      </p>
      <div class="layer-body users-body">
        <section v-if="userAttention.length" class="data-panel attention-strip" aria-label="Attention">
          <ol class="attention-list">
            <li v-for="item in userAttention.slice(0, USER_ATTENTION_SHOWN)" :key="item.key" class="attention-item" :data-severity="item.severity">
              <span class="status-dot" :data-tone="item.severity">{{ item.severity }}</span>
              <p class="attention-line" :title="`${item.claim}. ${item.evidence}`"><strong>{{ item.claim }}</strong> <span>{{ item.evidence }}</span></p>
              <div class="attention-actions">
                <button class="button button-secondary button-compact" type="button" :aria-pressed="usersView === item.view" @click="showUsersView(item)">Show</button>
              </div>
            </li>
          </ol>
        </section>

        <section v-if="users.length" class="summary-strip overview-numbers" aria-label="Identities at a glance" style="--stat-count: 3">
          <div :data-tone="userSummary.expiring.length ? 'warning' : undefined">
            <span>Expire within 30 days</span>
            <strong>{{ userSummary.expiring.length }}</strong>
            <small>{{ nextExpiryNote }}</small>
          </div>
          <div :data-tone="userSummary.overQuota ? 'error' : undefined">
            <span>Over quota</span>
            <strong>{{ userSummary.overQuota }}</strong>
            <small>{{ userSummary.withQuota ? `${userSummary.withQuota} ${userSummary.withQuota === 1 ? 'identity has' : 'identities have'} a quota` : 'no identity has a quota' }}</small>
          </div>
          <div>
            <span>Used this period</span>
            <strong>{{ userSummary.usageReported ? formatBytes(userSummary.periodBytes) : 'not reported' }}</strong>
            <small>{{ !userSummary.usageReported ? 'this server sends no usage per identity' : userSummary.attributed ? `counted to ${userSummary.attributed} ${userSummary.attributed === 1 ? 'identity' : 'identities'}` : 'no traffic counted to any identity' }}</small>
          </div>
        </section>

        <UsersTable
          ref="usersTable"
          v-model:view="usersView"
          v-model:search="search"
          v-model:group-by="usersGroup"
          v-model:sort="usersSort"
          :users="users"
          :now="usersNow"
          :open-user="userOpenId || undefined"
          :outcome="userOutcome"
          :can="userCan"
          @open="(user) => openUserPanel(user)"
          @edit="openEditUser"
          @rotate="(user) => openRotate(user)"
          @bindings="(user) => openUserPanel(user, true)"
          @delete="askDeleteUser"
          @dismiss="userOutcome = undefined"
        >
          <template #empty>
            <div class="empty-state">
              <UserRound :size="26" aria-hidden="true" />
              <strong>No VPN identities yet</strong>
              <p>An identity holds a protocol credential and the lines it may use. Creating one changes nothing on any node; its credential reaches a node only when a line it is bound to is planned and applied.</p>
              <div v-if="canCreateUser" class="empty-actions"><button class="button button-primary" type="button" @click="openCreateUser"><Plus :size="15" aria-hidden="true" /> Create the first identity</button></div>
              <p v-else class="empty-inline">This session cannot create identities.</p>
            </div>
          </template>
        </UsersTable>
      </div>
    </template>

    <template v-else-if="route === 'profiles'">
      <p class="proof-line" aria-live="polite">
        <span v-if="refreshedAt" :title="observed.title.value">observed {{ observed.age.value }} ago</span>
        <span v-else>not observed yet</span>
        <span>· {{ profileHeadline.nodes }} {{ profileHeadline.nodes === 1 ? 'node' : 'nodes' }}</span>
        <span>· {{ profileHeadline.collectorsOk === profileHeadline.nodes ? `${profileHeadline.collectorsOk} collectors ok` : `${profileHeadline.collectorsOk} of ${profileHeadline.nodes} collectors ok` }}</span>
        <span>· {{ profileHeadline.managed }} managed</span>
        <span v-if="refreshing">· refreshing</span>
      </p>
      <div class="layer-body profiles-body">
        <ProfilesTable :profiles="profiles" :open-profile="profileOpenId || undefined" @open="openProfilePanel" />
      </div>
    </template>

    <template v-else-if="route === 'usage'">
      <UsageScreen
        :lines="usage.lines ?? []"
        :double-counted="usage.double_counted_via_chains_bytes ?? 0"
        :period="usage.period || usagePeriod"
        :from="usage.from"
        :to="usage.to"
        :collectors="usage.collectors ?? []"
        :groups="lines"
        :users="users"
        :can-drill-down="canUsageQuery"
        :busy="refreshing"
        :failed="!!error && !(usage.lines ?? []).length"
        :series="usage.series"
        :previous="usage.previous"
        :view="usageView"
        :stack="usageStack"
        :observed-age="usageReadPeriod === usagePeriod ? observed.age.value : ''"
        :observed-title="observed.title.value"
        :can-open-users="canOpenEvidence"
        @period="setUsagePeriod"
        @view="(value) => (usageView = value)"
        @stack="(value) => (usageStack = value)"
        @open-users="openUsers"
      />
    </template>

    <div v-if="userDialogOpen" class="overlay-scrim" data-overlay="user" :style="overlayStyle" @mousedown.self="userDialogOpen = false"><section tabindex="-1" class="modal" role="dialog" aria-modal="true" aria-labelledby="user-dialog-title"><header><div><h2 id="user-dialog-title">{{ editingUser ? `Edit ${editingUser.email}` : 'New identity' }}</h2><p>{{ editingUser ? 'Existing secrets stay unchanged. Only the fields you change are saved.' : 'Create one initial protocol credential.' }}</p></div><button class="icon-button" type="button" aria-label="Close" @click="userDialogOpen = false"><X :size="17" /></button></header><div class="form-grid">
      <label class="field field-wide"><span>Email identity</span><input v-model="userForm.email" type="email" autocomplete="off" data-autofocus /></label><label class="field"><span>Display name</span><input v-model="userForm.name" type="text" /></label><label class="field"><span>Group</span><input v-model="userForm.group" type="text" /></label><label class="field"><span>Quota (GiB)</span><input v-model="userForm.quotaGiB" type="number" min="0" step="1" placeholder="Unlimited" /><small class="field-help">{{ quotaHelp }}</small></label><label class="field"><span>Quota period</span><select v-model="userForm.quotaPeriod"><option value="none">No reset, counts for the lifetime</option><option value="monthly">Monthly</option></select></label><label class="field"><span>Reset day</span><input v-model="userForm.quotaResetDay" type="number" min="1" max="28" placeholder="1" :disabled="userForm.quotaPeriod !== 'monthly'" /><small class="field-help">{{ userForm.quotaPeriod === 'monthly' ? 'Day of the month the count resets, 1 to 28 so every month has it.' : 'Only a monthly quota resets.' }}</small></label>
      <div class="field expiry-field"><label for="user-expiry">Expires at</label><div class="expiry-input"><input id="user-expiry" v-model="userForm.expiresAt" type="datetime-local" /><button v-if="userForm.expiresAt" class="button button-secondary button-compact" type="button" @click="userForm.expiresAt = ''">No expiry</button></div><small class="field-help">{{ expiryHelp }}</small></div><label class="toggle-field field-wide"><input v-model="userForm.enabled" type="checkbox" /><span>Identity enabled</span></label>
      <template v-if="!editingUser"><label class="field"><span>Protocol</span><select v-model="userForm.protocol"><option v-for="protocol in ['vless','vmess','trojan','shadowsocks','hysteria2','tuic','anytls']" :key="protocol" :value="protocol">{{ protocol }}</option></select></label><label class="field"><span>{{ ['vless','vmess','tuic'].includes(userForm.protocol) ? 'UUID' : 'Password' }}</span><input v-model="userForm.secret" type="password" autocomplete="new-password" /></label><label class="field field-wide"><span>Flow override</span><input v-model="userForm.flow" type="text" placeholder="Optional" /></label></template>
      <label class="field field-wide"><span>Comment</span><textarea v-model="userForm.comment" rows="3" /></label></div><div v-if="userDialogError" class="alert" role="alert"><CircleAlert :size="17" aria-hidden="true" /><span><strong>Not saved</strong>{{ userDialogError }}</span></div><footer><button class="button button-secondary" type="button" @click="userDialogOpen = false">Cancel</button><button class="button button-primary" type="button" :disabled="savingUser || !userForm.email.trim()" @click="saveUser"><LoaderCircle v-if="savingUser" class="spin" :size="15" />{{ editingUser ? 'Save changes' : 'Create identity' }}</button></footer></section></div>

    <div v-if="rolloutOpen" class="overlay-scrim" data-overlay="rollout" :style="overlayStyle" @mousedown.self="closeRollout"><section tabindex="-1" class="modal" role="dialog" aria-modal="true" aria-labelledby="rollout-title"><header><div><h2 id="rollout-title">Roll out managed lines</h2><p>One lattice-owned VLESS+REALITY line per node, bound to one account. This only files an approval batch: nothing changes on any node until you approve it.</p></div><button class="icon-button" type="button" aria-label="Close" @click="closeRollout"><X :size="17" /></button></header>
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
    <div v-if="deleteTarget" class="overlay-scrim" data-overlay="delete" :style="overlayStyle" @mousedown.self="deleteTarget = undefined"><section tabindex="-1" class="modal modal-small" role="alertdialog" aria-modal="true" aria-labelledby="delete-title" aria-describedby="delete-impact">
      <header><div><h2 id="delete-title">Delete {{ deleteTarget.email }}</h2><p>What this breaks:</p></div><button class="icon-button" type="button" aria-label="Close" @click="deleteTarget = undefined"><X :size="17" /></button></header>
      <ul id="delete-impact" class="impact-list"><li v-for="line in deleteImpact" :key="line">{{ line }}</li></ul>
      <label class="field typed-confirm"><span>Type <strong class="mono">{{ deleteTarget.email }}</strong> to delete it</span><input v-model="deleteTyped" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" data-autofocus @keydown.enter="deleteUser" /></label>
      <div v-if="deleteError" class="alert" role="alert"><CircleAlert :size="17" aria-hidden="true" /><span><strong>Not deleted</strong>{{ deleteError }}</span></div>
      <footer><button class="button button-secondary" type="button" @click="deleteTarget = undefined">Cancel</button><button class="button button-danger" type="button" :disabled="deletingUser || deleteTyped.trim() !== deleteTarget.email" @click="deleteUser"><LoaderCircle v-if="deletingUser" class="spin" :size="15" /><Trash2 v-else :size="15" /> Delete identity</button></footer></section></div>

    <div v-if="rotateUser" class="overlay-scrim" data-overlay="rotate" :style="overlayStyle" @mousedown.self="rotateUser = undefined"><section tabindex="-1" class="modal modal-small" role="dialog" aria-modal="true" aria-labelledby="rotate-title"><header><div><h2 id="rotate-title">Rotate a credential</h2><p>{{ rotateUser.email }}, bound to {{ rotateUser.bindings.length }} {{ rotateUser.bindings.length === 1 ? 'line' : 'lines' }}. The new secret is shown once. The old one keeps working on each bound line until that line is planned and applied with the new one.</p></div><button class="icon-button" type="button" aria-label="Close" @click="rotateUser = undefined"><X :size="17" /></button></header>
      <div class="form-grid rotate-form"><label class="field field-wide"><span>Protocol credential</span><select v-model="rotateProtocol" data-autofocus><option v-for="credential in rotateUser.credentials" :key="credential.protocol" :value="credential.protocol">{{ credential.protocol }}</option></select></label></div>
      <div v-if="rotateError" class="alert" role="alert"><CircleAlert :size="17" aria-hidden="true" /><span><strong>Not rotated</strong>{{ rotateError }}</span></div>
      <footer><button class="button button-secondary" type="button" @click="rotateUser = undefined">Cancel</button><button class="button button-primary" type="button" :disabled="rotateBusy || !rotateProtocol" @click="rotateCredential"><LoaderCircle v-if="rotateBusy" class="spin" :size="15" /> Rotate</button></footer></section></div>

    <div v-if="rotateRevealed" class="overlay-scrim" data-overlay="rotate-revealed" :style="overlayStyle"><section tabindex="-1" class="modal modal-small" role="dialog" aria-modal="true"><header><div><h2>New {{ rotateRevealed.protocol }} credential</h2><p>{{ rotateRevealed.email }}. Shown once and never retrievable again.</p></div></header>
      <label class="field field-wide"><span>Secret (copy now)</span><textarea class="command-output mono" :value="rotateRevealed.secret" readonly rows="2" @focus="($event.target as HTMLTextAreaElement).select()" /></label>
      <footer><button class="button button-primary" type="button" @click="rotateRevealed = undefined">I have saved it</button></footer></section></div>

    <!-- The line panel (L2), addressed by ?open=<line_hash_id>. A sheet from
         the right on a wide window, the full height of the frame on a phone. -->
    <div v-if="lineDetailOpen && lineDetail" class="overlay-scrim sheet-scrim" data-overlay="line-detail" @mousedown.self="closeLineDetails()"><section tabindex="-1" class="modal sheet" role="dialog" aria-modal="true" aria-labelledby="line-detail-title">
      <header>
        <div>
          <h2 id="line-detail-title">{{ lineDetail.name }}</h2>
          <p>{{ lineDetailNodeName }}</p>
          <p class="proof-line sheet-proof">
            <span>{{ lineDetail.line_hash_id }}</span>
            <span>· {{ lineDetail.managed ? 'managed' : 'discovered' }}</span>
            <span v-if="lineDetail.service_checked_at" :title="lineDetail.service_checked_at">· probed {{ formatDate(lineDetail.service_checked_at) }}</span>
            <span v-if="lineDetailBusy">· reading</span>
          </p>
        </div>
        <button class="icon-button" type="button" aria-label="Close" @click="closeLineDetails()"><X :size="17" /></button>
      </header>
      <div class="detail-body">
        <div v-if="lineDetailError" class="alert" role="alert"><CircleAlert :size="17" aria-hidden="true" /><span>{{ lineDetailError }}</span></div>
        <div class="detail-grid">
          <div><span>State</span><strong><span class="status-dot" :data-tone="lineDetailState?.tone">{{ lineDetailState?.label }}</span></strong><small>{{ lineDetail.status ? `config ${lineDetail.status}` : 'config not reported' }}</small></div>
          <div><span>Protocol</span><strong>{{ lineDetail.type || 'unknown' }}</strong><small>{{ lineDetail.core }}<template v-if="lineDetail.security"> · {{ lineDetail.security }}</template></small></div>
          <div><span>Endpoint</span><strong class="mono">{{ formatLineEndpoint(lineDetail) }}</strong><small>listen {{ formatLineListen(lineDetail) }}</small></div>
          <div><span>Reality SNI</span><strong class="mono">{{ formatLineDomain(lineDetail) }}</strong><small>server name</small></div>
          <div><span>Users</span><strong>{{ lineDetail.user_known ? lineDetail.user_count : 'unknown' }}</strong><small>{{ lineDetail.user_known ? 'reported by the node' : 'the node did not report a count' }}</small></div>
          <div><span>Outbound</span><strong class="mono">{{ lineDetail.outbound_ref || 'none' }}</strong><small v-if="lineDetail.outbound_server">{{ lineDetail.outbound_server }}<span v-if="lineDetail.outbound_port">:{{ lineDetail.outbound_port }}</span></small><small v-else>{{ !lineDetail.outbound_ref ? 'traffic here has nowhere to go' : lineDetail.outbound_ref === 'direct' ? 'traffic leaves the fleet here' : 'no server named' }}</small></div>
        </div>

        <section class="detail-section"><h3>Chain</h3>
          <ol class="chain-path" aria-label="The chain this line belongs to, from entry to exit">
            <li v-for="hop in lineDetailPath" :key="hop.key" class="chain-hop" :data-role="hop.role" :data-current="hop.current || undefined">
              <span class="chain-role">{{ hopRoleLabel(hop.role) }}<template v-if="hop.current"> · this line</template></span>
              <strong :title="hop.nodeName">{{ hop.nodeName }}</strong>
              <small v-if="hop.lineName" :title="hop.lineName">{{ hop.lineName }}</small>
              <span v-if="hop.state" class="status-dot" :data-tone="hop.state.tone">{{ hop.fanIn ? (hop.state.tone === "healthy" ? `all ${hop.state.label}` : `worst: ${hop.state.label}`) : hop.state.label }}</span>
              <span v-else class="status-dot" data-tone="neutral">not on this fleet</span>
            </li>
          </ol>
          <p v-if="lineDetailPath.length === 1" class="field-help">No line relays into this one and it relays nowhere: traffic enters and leaves the fleet here.</p>
        </section>

        <section class="detail-section"><h3>Traffic, last {{ LINES_PERIOD_LABEL }}</h3>
          <p v-if="!lineUsageKnown" class="field-help">{{ lineUsageNote }}</p>
          <p v-else-if="lineDetailBytes === undefined" class="field-help">Unknown, not zero: this node's usage collector is not reporting.</p>
          <template v-else>
            <p class="traffic-figure"><strong class="mono">{{ formatBytes(lineDetailBytes) }}</strong><span v-if="lineDetailRows.length" class="mono">up {{ formatBytes(lineDetailUp) }} · down {{ formatBytes(lineDetailDown) }}</span></p>
            <ul v-if="lineDetailRows.length" class="traffic-rows">
              <li v-for="(row, index) in lineDetailRows" :key="index">
                <span class="badge">{{ roleLabel(row.role) }}</span>
                <span class="mono">{{ formatBytes(row.used_bytes) }}</span>
                <span class="cell-note" :data-tone="row.estimate ? 'warning' : undefined">{{ measurementLabel(row) }}</span>
                <span>{{ row.user_id ? `${attributionLabel(row)}: ${row.email || row.user_id}` : row.counted_at ? 'counted at the entry line' : attributionLabel(row) }}</span>
              </li>
            </ul>
            <p v-else class="field-help">The collector on this node reported and this line moved nothing in the period.</p>
          </template>
        </section>

        <section class="detail-section"><h3>Evidence</h3>
          <div v-if="canOpenEvidence" class="icon-actions evidence-links">
            <button class="button button-secondary button-compact" type="button" @click="openEvidence(lineDetail.node_id, 'connections', lineDetail)"><Waypoints :size="13" aria-hidden="true" /> Connections through this line</button>
            <button class="button button-secondary button-compact" type="button" @click="openEvidence(lineDetail.node_id, 'log', lineDetail)">Raw log for this line</button>
          </div>
          <p v-else class="field-help">Evidence opens in the console; this frame has no host to ask.</p>
          <p v-if="!lineDetail.line_uuid" class="field-help">This line has no chain identity yet, so Evidence filters to its node only.</p>
        </section>

        <section class="detail-section"><h3>Users</h3>
          <p v-if="canPlanLineUsers" class="field-help">Each action here files an approval and changes nothing yet. Once you approve it, applying {{ lineDetail.managed ? 'rewrites the whole core config on that node and reloads it' : 'changes this one user record on that node in place' }}.</p>
          <div v-if="lineUsersError" class="alert" role="alert"><CircleAlert :size="17" aria-hidden="true" /><span>{{ lineUsersError }}</span></div>
          <div class="binding-list">
            <div v-for="user in lineDetailBoundUsers" :key="user.id">
              <span>{{ user.email }}<small v-if="user.name"> ({{ user.name }})</small></span>
              <span v-if="canPlanLineUsers" class="icon-actions">
                <button class="button button-secondary button-compact" type="button" :disabled="lineUsersBusy" title="File an approval to update this identity on this line" @click="planLineUser('plan_update', user.id)">Update</button>
                <button class="button button-secondary button-compact destructive" type="button" :disabled="lineUsersBusy" title="File an approval to remove this identity from this line" @click="planLineUser('plan_remove', user.id)">Remove</button>
              </span>
            </div>
            <p v-if="usersUnavailable" class="empty-inline" role="status">The identity list could not be loaded, so bindings for this line are not shown.</p>
            <p v-else-if="!lineDetailBoundUsers.length" class="empty-inline">No identity is bound to this line in Lattice.</p>
          </div>
          <div v-if="canPlanLineUsers && lineDetailBindableUsers.length" class="binding-add">
            <select v-model="lineUserAdd"><option value="">Select an identity to add</option><option v-for="user in lineDetailBindableUsers" :key="user.id" :value="user.id">{{ user.email }}</option></select>
            <button class="button button-primary" type="button" :disabled="!lineUserAdd || lineUsersBusy" @click="bindAndApplyToLine"><Plus :size="15" /> Queue add</button>
          </div>
          <ul v-if="lineApprovals.length" class="detail-list">
            <li v-for="item in lineApprovals" :key="item.id"><span class="mono">{{ item.id }}</span>: {{ item.summary }} <em>(pending approval)</em></li>
          </ul>
        </section>

        <section class="detail-section"><h3>Line identity</h3><dl class="detail-pairs"><dt>Chain identity</dt><dd class="mono">{{ lineDetail.line_uuid || 'not allocated yet, so this line cannot be either end of a chain' }}</dd><template v-if="lineDetail.downstream_line_uuid"><dt>Downstream identity</dt><dd class="mono">{{ lineDetail.downstream_line_uuid }}</dd></template><dt>Ownership</dt><dd>{{ lineOwnership(lineDetail) }} · {{ lineDetail.source }}</dd></dl>
          <div v-if="canSyncMetadata && !lineDetail.managed" class="icon-actions"><button class="button button-secondary button-compact" type="button" :disabled="syncBusy" title="File an approval that writes this line's identity file on its node" @click="syncSidecar"><LoaderCircle v-if="syncBusy" class="spin" :size="13" /> Write identity to the node</button></div>
          <div v-if="canReattachLine" class="binding-add"><input v-model="reattachUUID" class="mono" type="text" autocomplete="off" spellcheck="false" placeholder="Existing UUIDv4 to reattach" /><button class="button button-secondary button-compact" type="button" :disabled="reattachBusy || !reattachUUID.trim()" @click="reattachLineUUID"><LoaderCircle v-if="reattachBusy" class="spin" :size="13" /> Reattach identity</button></div>
        </section>
        <section class="detail-section"><h3>Error</h3><p :class="{ 'error-text': lineDetail.last_error }">{{ lineErrorText(lineDetail) }}</p></section>
        <section v-if="lineDetail.metadata && Object.keys(lineDetail.metadata).length" class="detail-section"><h3>Metadata</h3><dl class="detail-pairs"><template v-for="(value, key) in lineDetail.metadata" :key="key"><dt class="mono">{{ key }}</dt><dd>{{ value || '-' }}</dd></template></dl></section>
      </div>
    </section></div>

    <UserSheet
      v-if="route === 'users' && userOpenId"
      :user="openUser"
      :missing-id="userOpenId"
      :now="usersNow"
      :options="lineChoices"
      :lines-error="usersLinesError"
      :can="userCan"
      :bind-busy="bindingBusy"
      :unbind-busy="unbindBusy"
      :outcome="userOutcome"
      :focus-bindings="bindingsFocus"
      @close="closeUserPanel()"
      @edit="openEditUser"
      @rotate="openRotate"
      @bind="bindLine"
      @unbind="unbindLine"
      @delete="askDeleteUser"
      @dismiss="userOutcome = undefined"
    />

    <ProfileSheet
      v-if="route === 'profiles' && profileOpenId"
      :profile="openProfile"
      :missing-id="profileOpenId"
      :settings="profileSettings"
      :settings-busy="profileSettingsBusy"
      :settings-error="profileSettingsError"
      :can-read="canReadProfileSettings"
      :can-configure="canConfigureProfile"
      :saving="profileSettingsSaving"
      :command="profileReconfigureCommand"
      :saved-at="profileSavedAt"
      @close="closeProfilePanel()"
      @save="saveProfileSettings"
    />
  </main>
</template>
