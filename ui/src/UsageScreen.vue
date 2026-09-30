<script setup lang="ts">
/**
 * The Usage screen: time first, identity when it exists.
 *
 * Four layers over one read. Overview leads with egress, what left the fleet
 * on exit, direct and shared lines, and its change against the window before; the
 * picture is the daily series stacked by exit or by role. By node, By line and
 * By user are the collections behind it.
 *
 * The organising rule is that this page never presents a number without
 * saying how good it is. Three claims are made in three different registers
 * and they must stay distinguishable:
 *
 *   measured   a counter the box reported
 *   estimated  a subtraction the server performed (`estimate`)
 *   unknown    real traffic with no identity, or a node not reporting at all
 *
 * The last one is the one a dashboard usually gets wrong by rendering zero.
 * Relay hubs count egress a second time as it enters them; the overview says
 * so in one sentence and never adds it, and node totals, which do count every
 * hop, say so on the By node layer.
 */
import { vRevealSelected } from "./layerTabs";
import { computed, ref, watch } from "vue";
import { Activity, ChevronRight, Gauge, Users, Waypoints } from "@lucide/vue";

import DailyBars from "./DailyBars.vue";
import Sparkline from "./Sparkline.vue";
import {
  ATTRIBUTION_FLOOR,
  EGRESS_ROLES,
  attributionSummary,
  changeAgainst,
  hasSeries,
  nodeDaily,
  rankExits,
  roleTotals,
  stackByExit,
  stackByRole,
  trafficByNode,
  type UsagePrevious,
  type UsageSeries,
} from "./trafficModel";
import {
  attributionLabel,
  attributionTone,
  collectorLabel,
  collectorReports,
  collectorTone,
  foldUsage,
  formatDayRange,
  lineNameIndex,
  measurementLabel,
  periodLabel,
  quotaState,
  roleLabel,
  upstreamLines,
  type UsageCollectorRow,
  type UsageLineRow,
  type StackBy,
  type UsagePeriod,
  type UsageView,
} from "./usageModel";
import { formatBytes, pageRows, type LineGroup, type VpnUser } from "./vpnModel";

const props = withDefaults(defineProps<{
  lines: readonly UsageLineRow[];
  doubleCounted: number;
  period: string;
  from?: string;
  to?: string;
  collectors: readonly UsageCollectorRow[];
  groups: readonly LineGroup[];
  users: readonly VpnUser[];
  /** Whether this session may call users-admin/usage_query for a drill-down. */
  canDrillDown: boolean;
  busy: boolean;
  /**
   * The read failed and nothing came back. Zero is then a lie: the fleet may
   * have moved anything at all, and the page has to say it does not know
   * rather than print 0 B under five headings.
   */
  failed: boolean;
  series?: UsageSeries;
  previous?: UsagePrevious;
  view?: UsageView;
  /** How the overview's daily chart stacks. The page keeps it with the layer. */
  stack?: StackBy;
  /** When the page last heard from the control plane, for the proof line. */
  /** "13s" when this period's read is the one on screen, "" otherwise. */
  observedAge?: string;
  observedTitle?: string;
  /** The console can be asked to open Users. */
  canOpenUsers?: boolean;
}>(), { view: "overview", stack: "exit", observedAge: "", observedTitle: "", canOpenUsers: false, series: undefined, previous: undefined, from: undefined, to: undefined });
const emit = defineEmits<{
  period: [value: UsagePeriod];
  view: [value: UsageView];
  stack: [value: StackBy];
  openUsers: [];
}>();

const fold = computed(() => foldUsage(props.lines));
const totals = computed(() => roleTotals(props.lines));
const names = computed(() => lineNameIndex(props.groups));
const quotaByUser = computed(() => new Map(props.users.map((user) => [user.id, user.quota_bytes])));
const expiryByUser = computed(() => new Map(props.users.map((user) => [user.id, user.expires_at])));
const emailByUser = computed(() => new Map(props.users.map((user) => [user.id, user.email])));
const rangeLabel = computed(() => formatDayRange(props.from, props.to));
const series = computed(() => (hasSeries(props.series) ? props.series : undefined));
const change = computed(() => changeAgainst(totals.value.egress, props.previous));
const attribution = computed(() => attributionSummary(props.lines));
const hasTraffic = computed(() => props.lines.length > 0);
/* Measured means a collector reported or a row arrived. With neither, the
 * fleet is unmeasured and its egress is unknown, not zero. */
const measured = computed(() => hasTraffic.value || props.collectors.some((row) => collectorReports(row.status ?? "")));

/* ── the proof line ────────────────────────────────────────────────────── */
const reportingCollectors = computed(() => props.collectors.filter((row) => collectorReports(row.status ?? "")).length);
/* A node whose collector is not reporting has unknown traffic, not zero, so
 * every node total is qualified by the collector that produced it. */
const collectorByNode = computed(() => new Map(props.collectors.map((row) => [row.node_id, row])));
function collectorStateOf(nodeID: string): string {
  const found = collectorByNode.value.get(nodeID);
  if (!found) return "no_collector";
  return found.status === "ok" ? "ok" : found.status === "error" ? "error" : found.status || "no_collector";
}
const silentCollectors = computed(() =>
  props.collectors.filter((row) => !collectorReports(row.status ?? "")));

/* ── overview ──────────────────────────────────────────────────────────── */
const SENTENCE: Record<string, string> = { today: "today", "7d": "in the last 7 days", "30d": "in the last 30 days", all: "in all retained days" };
const BEFORE: Record<string, string> = { today: "yesterday", "7d": "the previous 7 days", "30d": "the previous 30 days" };
const periodSentence = computed(() => SENTENCE[props.period] ?? `in ${periodLabel(props.period).toLowerCase()}`);
const beforeLabel = computed(() => BEFORE[props.period] ?? "the previous period");
const previousRange = computed(() => formatDayRange(props.previous?.from, props.previous?.to));

const stackBy = computed(() => props.stack);
const stack = computed(() => (series.value ? (stackBy.value === "exit" ? stackByExit(series.value, 5) : stackByRole(series.value)) : undefined));
const chartLabel = computed(() => stackBy.value === "exit"
  ? `Daily egress ${periodSentence.value}, stacked by exit: the five largest and the rest together`
  : `Every byte reported ${periodSentence.value}, stacked by line role`);

const exits = computed(() => rankExits(props.lines, series.value));
const TOP_EXITS = 10;
const topExits = computed(() => exits.value.slice(0, TOP_EXITS));
const maxExit = computed(() => exits.value[0]?.egress ?? 0);

/* ── by node ───────────────────────────────────────────────────────────── */
interface NodeFigure {
  nodeID: string;
  label: string;
  egress?: number;
  repeated?: number;
  total?: number;
  unattributed?: number;
  estimated: number;
  trend?: number[];
}
const nodeFigures = computed<NodeFigure[]>(() => {
  const traffic = trafficByNode(props.lines);
  const unattributed = new Map(fold.value.byNode.map((node) => [node.nodeID, node]));
  const figures: NodeFigure[] = [...traffic.values()].map((node) => ({
    nodeID: node.nodeID,
    label: node.nodeName || node.nodeID,
    egress: node.egress,
    repeated: node.repeated,
    total: node.total,
    unattributed: unattributed.get(node.nodeID)?.unattributedBytes ?? 0,
    estimated: unattributed.get(node.nodeID)?.estimatedBytes ?? 0,
    trend: series.value ? nodeDaily(series.value, node.nodeID) : undefined,
  }));
  // Every node with a collector gets a row. One that reported and moved
  // nothing reads zero; one whose collector is silent reads unknown, so the
  // table cannot be read as "every node, and this is all they moved".
  for (const row of props.collectors) {
    if (traffic.has(row.node_id)) continue;
    const label = row.node_name || row.node_id;
    if (collectorReports(row.status ?? "")) figures.push({ nodeID: row.node_id, label, egress: 0, repeated: 0, total: 0, unattributed: 0, estimated: 0 });
    else figures.push({ nodeID: row.node_id, label, estimated: 0 });
  }
  return figures.sort((a, b) => (b.total ?? -1) - (a.total ?? -1) || a.label.localeCompare(b.label));
});

/* ── by line ───────────────────────────────────────────────────────────── */
function lineLabel(row: UsageLineRow): string {
  const hash = row.line_hash_id?.trim();
  if (hash && names.value.has(hash)) return names.value.get(hash) as string;
  return row.tag || hash || "unnamed inbound";
}
function userLabel(row: UsageLineRow): string {
  if (!row.user_id) return "";
  return row.email || emailByUser.value.get(row.user_id) || row.user_id;
}

/* Evidence opens per row rather than in an overlay: the operator is comparing
 * rows, and a dialog would hide the table they are comparing against. */
const openRows = ref(new Set<string>());
function rowKey(row: UsageLineRow, index: number): string {
  return `${row.node_id}:${row.line_hash_id ?? row.tag}:${index}`;
}
function toggleRow(key: string): void {
  const next = new Set(openRows.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  openRows.value = next;
}

/* The detail table is the long one. It pages through the same helper the
 * Lines table uses, so the document stays a page rather than a scroll. */
const PAGE_SIZE = 30;
const page = ref(1);
const sortedLines = computed(() =>
  [...props.lines].sort((a, b) => (b.used_bytes || 0) - (a.used_bytes || 0)));
const linePage = computed(() => pageRows(sortedLines.value, page.value, PAGE_SIZE));

/* ── by user ───────────────────────────────────────────────────────────── */
const underAttributed = computed(() => hasTraffic.value && attribution.value.share < ATTRIBUTION_FLOOR);
function percent(value: number): string {
  if (value > 0 && value < 0.001) return "under 0.1%";
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}
function expiryLabel(userID: string): string {
  const value = expiryByUser.value.get(userID);
  if (!value) return "no expiry";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "no expiry" : date.toISOString().slice(0, 10);
}

/* The period picker sits in the page header (one control row under the
 * title, not a second tab row), so paging resets when the period changes,
 * whoever changed it. */
watch(() => props.period, () => {
  page.value = 1;
  openRows.value = new Set();
});
function setPeriod(value: string): void {
  emit("period", value as UsagePeriod);
}
function setView(value: UsageView): void {
  emit("view", value);
}
</script>

<template>
  <p class="proof-line usage-proof" aria-live="polite">
    <span v-if="observedAge" :title="observedTitle">observed {{ observedAge }} ago</span>
    <span v-else>not observed yet</span>
    <span v-if="busy">· reading {{ periodLabel(period).toLowerCase() }}</span>
    <span v-if="failed">· the usage read failed</span>
    <template v-else>
      <span>· {{ reportingCollectors }} of {{ collectors.length }} collectors ok</span>
      <span>· {{ attribution.countedLines }} of {{ attribution.lines }} lines attributed</span>
    </template>
    <span v-if="rangeLabel">· {{ rangeLabel }}</span>
  </p>

  <nav v-reveal-selected="view" class="layer-tabs" role="tablist" aria-label="Usage layers">
    <button class="layer-tab" role="tab" type="button" :aria-selected="view === 'overview'" @click="setView('overview')">Overview</button>
    <button class="layer-tab" role="tab" type="button" :aria-selected="view === 'node'" @click="setView('node')">By node<span v-if="!failed" class="lens-count">{{ nodeFigures.length }}</span></button>
    <button class="layer-tab" role="tab" type="button" :aria-selected="view === 'line'" @click="setView('line')">By line<span v-if="!failed" class="lens-count">{{ lines.length }}</span></button>
    <button class="layer-tab" role="tab" type="button" :aria-selected="view === 'user'" @click="setView('user')">By user<span v-if="!failed" class="lens-count">{{ fold.byUser.length }}</span></button>
  </nav>

  <section v-if="silentCollectors.length && !failed && view !== 'line'" class="data-panel explain-panel" data-tone="warning" aria-label="Collector coverage">
    <Activity :size="17" aria-hidden="true" />
    <div>
      <strong>{{ silentCollectors.length }} node{{ silentCollectors.length === 1 ? '' : 's' }} did not report usage for this period.</strong>
      <p>
        Traffic on
        <template v-for="(row, index) in silentCollectors.slice(0, 4)" :key="row.node_id">{{ index ? ', ' : '' }}<strong class="inline-name">{{ row.node_name || row.node_id }}</strong></template><span v-if="silentCollectors.length > 4"> and {{ silentCollectors.length - 4 }} more</span>
        is unknown, not zero. Every total on this page excludes whatever those nodes moved.
        Set a usage source for them under Node Profiles.
      </p>
    </div>
  </section>

  <!-- ── Overview ─────────────────────────────────────────────────────── -->
  <div v-if="view === 'overview'" class="layer-body" role="tabpanel" aria-label="Overview">
    <section class="data-panel headline-panel" aria-label="Egress for the period">
      <p class="headline">
        <strong class="mono">{{ failed || !measured ? 'unknown' : formatBytes(totals.egress) }}</strong>
        <span v-if="failed">left the fleet {{ periodSentence }}: the usage read failed, so nothing is known</span>
        <span v-else-if="!measured">left the fleet {{ periodSentence }}: no node reports usage, so nothing was measured</span>
        <span v-else>left the fleet {{ periodSentence }}</span>
      </p>
      <p v-if="!failed && change" class="headline-change">
        <span class="mono">{{ change.label }}</span> against {{ beforeLabel }} ({{ formatBytes(change.previousBytes) }}<template v-if="previousRange">, {{ previousRange }}</template>)
      </p>
      <p v-else-if="!failed && hasTraffic && period !== 'all'" class="headline-change muted-change">No earlier period to compare with: this server does not report one.</p>
      <p v-if="!failed && totals.repeated > 0" class="headline-note">
        Relay hubs counted another {{ formatBytes(totals.repeated) }} as it entered them. That is the same traffic seen one hop earlier, so it is not added here.
      </p>
    </section>

    <section class="data-panel" aria-labelledby="usage-chart-title">
      <header class="panel-header">
        <div>
          <h2 id="usage-chart-title">{{ series ? (stackBy === 'exit' ? 'Daily egress by exit' : 'Daily bytes by role') : failed || !hasTraffic ? 'Daily egress' : 'Egress by exit' }}</h2>
          <template v-if="!failed && hasTraffic">
            <p v-if="series && stackBy === 'role'">Exit, shared and direct at the bottom are egress. Entry and middle hop above them are that traffic counted again on its way.</p>
            <p v-else-if="series">Each bar is one day; the five largest exits have their own segment and the rest share one.</p>
            <p v-else>The daily view needs a newer server, which reports usage per day. These are the period totals per exit it would have stacked.</p>
          </template>
        </div>
        <div v-if="series && hasTraffic && !failed" class="segmented" role="group" aria-label="Stack the bars by">
          <span class="segmented-label">Stack by</span>
          <button class="segmented-option" type="button" :aria-pressed="stackBy === 'exit'" @click="emit('stack', 'exit')">exit</button>
          <button class="segmented-option" type="button" :aria-pressed="stackBy === 'role'" @click="emit('stack', 'role')">role</button>
        </div>
      </header>
      <div v-if="failed" class="empty-state">
        <Gauge :size="24" aria-hidden="true" />
        <strong>Usage could not be read for this period</strong>
        <p>This is not an empty result. The request failed, so nothing is known about what the fleet moved, not because nothing happened. Retry above; the figures stay unknown until a read succeeds.</p>
      </div>
      <div v-else-if="!hasTraffic" class="empty-state">
        <Gauge :size="24" aria-hidden="true" />
        <strong>No traffic in {{ periodLabel(period).toLowerCase() }}</strong>
        <p v-if="!collectors.length">
          No node is configured to report usage, so this is not a quiet fleet: it is an unmeasured
          one. Nothing here can distinguish zero traffic from traffic nobody counted. Open Node
          Profiles and set a usage source: a stats file, a collector URL, the Xray API, or the
          sing-box experimental API.
        </p>
        <p v-else-if="silentCollectors.length">
          No line reported traffic for this period. {{ silentCollectors.length }} node{{ silentCollectors.length === 1 ? ' is' : 's are' }}
          not reporting at all, so this is a gap in measurement rather than a quiet fleet. Try a
          longer period, or set a usage source under Node Profiles.
        </p>
        <p v-else>
          Collectors are reporting and none of them recorded traffic in this window. Try a longer
          period: an idle fleet and a fleet nobody measured look the same on a short one.
        </p>
        <div class="empty-actions">
          <button v-if="period !== 'all'" class="button button-secondary" type="button" :disabled="busy" @click="setPeriod('all')">
            Widen to all retained days
          </button>
        </div>
      </div>
      <div v-else-if="stack" class="chart-body">
        <DailyBars :stack="stack" :label="chartLabel" />
        <p v-if="series?.truncated" class="topology-graph-note">The window is longer than 90 days; the chart shows the latest 90.</p>
      </div>
      <ol v-else class="exit-bars" aria-label="Egress per exit for the period">
        <li v-for="exit in topExits" :key="exit.nodeID">
          <span class="exit-bar-label" :title="exit.label">{{ exit.label }}</span>
          <span class="exit-bar-track" aria-hidden="true"><span :style="{ width: `${maxExit ? Math.max(0.5, (exit.egress / maxExit) * 100) : 0}%` }" /></span>
          <span class="exit-bar-value mono">{{ formatBytes(exit.egress) }} · {{ percent(exit.share) }}</span>
        </li>
      </ol>
    </section>

    <!-- Without a series the bars above already are the per-exit totals, with
         their share; the table would only repeat them. -->
    <section v-if="!failed && exits.length && series" class="data-panel" aria-labelledby="top-exits-title">
      <header class="panel-header">
        <div><h2 id="top-exits-title">Top exits</h2><p>Where traffic left the fleet, largest first.</p></div>
        <button v-if="exits.length > TOP_EXITS" class="button button-secondary button-compact" type="button" @click="setView('node')">All {{ nodeFigures.length }} nodes</button>
      </header>
      <div class="table-wrap">
        <table class="top-exits">
          <thead><tr><th class="sticky-first">Node</th><th class="num">Egress</th><th class="num">Share</th><th v-if="series">Trend, {{ series.days.length }} {{ series.days.length === 1 ? 'day' : 'days' }}</th></tr></thead>
          <tbody>
            <tr v-for="exit in topExits" :key="exit.nodeID">
              <td class="sticky-first"><strong :title="exit.label">{{ exit.label }}</strong></td>
              <td class="num mono">{{ formatBytes(exit.egress) }}</td>
              <td class="num mono">{{ percent(exit.share) }}</td>
              <td v-if="series"><Sparkline v-if="exit.trend" :values="exit.trend" :label="`${exit.label}, egress per day`" /></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>

  <!-- ── By node ──────────────────────────────────────────────────────── -->
  <div v-else-if="view === 'node'" class="layer-body" role="tabpanel" aria-label="By node">
    <section class="data-panel" aria-labelledby="usage-nodes-title">
      <header class="panel-header">
        <div><h2 id="usage-nodes-title">By node</h2><p>Every byte a node reported, split into what left the fleet there and what it relayed on to another node.</p></div>
        <Activity :size="17" aria-hidden="true" />
      </header>
      <div v-if="nodeFigures.length" class="table-wrap">
        <table class="usage-nodes">
          <thead><tr>
            <th class="sticky-first">Node</th><th class="num">Egress</th><th class="num">Relayed</th><th class="num">All reported</th>
            <th class="num">Unattributed</th><th>Collector</th><th v-if="series">Trend</th>
          </tr></thead>
          <tbody>
            <tr v-for="node in nodeFigures" :key="node.nodeID">
              <td class="sticky-first"><strong :title="node.label">{{ node.label }}</strong><small :title="node.nodeID">{{ node.nodeID }}</small></td>
              <td class="num mono" :data-unknown="node.egress === undefined || undefined">{{ node.egress === undefined ? 'unknown' : node.egress ? formatBytes(node.egress) : '-' }}</td>
              <td class="num mono" :data-unknown="node.repeated === undefined || undefined">{{ node.repeated === undefined ? 'unknown' : node.repeated ? formatBytes(node.repeated) : '-' }}</td>
              <td class="num">
                <span class="mono" :data-unknown="node.total === undefined || undefined">{{ node.total === undefined ? 'unknown' : formatBytes(node.total) }}</span>
                <small v-if="node.estimated" class="cell-note">{{ formatBytes(node.estimated) }} estimated</small>
              </td>
              <td class="num mono">{{ node.unattributed === undefined ? 'unknown' : node.unattributed ? formatBytes(node.unattributed) : '-' }}</td>
              <td><span class="status-dot" :data-tone="collectorTone(collectorStateOf(node.nodeID))" :title="collectorByNode.get(node.nodeID)?.error || undefined">{{ collectorLabel(collectorStateOf(node.nodeID)) }}</span></td>
              <td v-if="series"><Sparkline v-if="node.trend" :values="node.trend" :label="`${node.label}, bytes per day`" /></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else-if="failed" class="empty-state">
        <Activity :size="24" aria-hidden="true" />
        <strong>Per-node usage could not be read</strong>
        <p>This is not an empty fleet. The request above failed, so what these nodes moved is unknown.</p>
      </div>
      <div v-else class="empty-state">
        <Activity :size="24" aria-hidden="true" />
        <strong>No node reported traffic</strong>
        <p>
          A node reports once its profile names a usage source: a stats file, a collector URL, the
          Xray API, or the sing-box experimental API. Set one under Node Profiles.
        </p>
      </div>
    </section>

    <!-- The gap between node totals and egress, explained where it is stated.
         It is a property of chain accounting, not an error to fix. -->
    <section v-if="doubleCounted > 0 && !failed" class="data-panel explain-panel" aria-label="Why node totals exceed egress">
      <Waypoints :size="17" aria-hidden="true" />
      <div>
        <strong>{{ formatBytes(doubleCounted) }} is counted twice across the fleet, on purpose.</strong>
        <p>
          Traffic that crosses a chain passes through more than one node, so every node it touches
          reports it. The all-reported column therefore counts these bytes at each hop, while egress
          and an identity's total count them once, at the exit and at the entry line. Neither figure
          is wrong and they are not reconciled here.
        </p>
      </div>
    </section>

    <section class="data-panel collectors" aria-labelledby="collectors-title">
      <header class="panel-header"><div><h2 id="collectors-title">Collectors</h2><p>Where each node's figures come from, and when they last reported.</p></div></header>
      <div v-if="collectors.length" class="collector-grid">
        <div v-for="collector in collectors" :key="collector.node_id">
          <span class="status-dot" :data-tone="collectorTone(collector.status === 'ok' ? 'ok' : collector.status || '')">{{ collectorLabel(collector.status || '') }}</span>
          <strong :title="collector.node_name || collector.node_id">{{ collector.node_name || collector.node_id }}</strong>
          <small :title="`${collector.source || 'unspecified'} / ${collector.checked_at || 'never'}`">{{ collector.source || 'unspecified' }} / {{ collector.checked_at ? collector.checked_at.replace('T', ' ').slice(0, 16) : 'never' }}</small>
          <p v-if="collector.error" class="error-text">{{ collector.error }}</p>
        </div>
      </div>
      <div v-else class="empty-state">
        <Gauge :size="24" aria-hidden="true" />
        <strong>{{ failed ? 'Collectors could not be read' : 'No collector is configured' }}</strong>
        <p v-if="failed">The usage read failed, so which nodes report is unknown too.</p>
        <p v-else>No node profile points at a usage source, so traffic on those nodes is unmeasured rather than zero. Open Node Profiles, edit a node, and set a usage file, collector URL, Xray API or sing-box stats API.</p>
      </div>
    </section>
  </div>

  <!-- ── By line ──────────────────────────────────────────────────────── -->
  <section v-else-if="view === 'line'" class="data-panel" role="tabpanel" aria-labelledby="usage-lines-heading">
    <header class="panel-header">
      <div>
        <h2 id="usage-lines-heading">By line</h2>
        <p>Every attributed slice of traffic, and the evidence behind each one.</p>
      </div>
      <span v-if="linePage.total" class="count">{{ linePage.from }}-{{ linePage.to }} of {{ linePage.total }}</span>
    </header>

    <div v-if="linePage.rows.length" class="table-wrap">
      <table class="usage-lines" style="min-width: 900px">
        <thead>
          <tr>
            <th class="chevron-cell"><span class="sr-only">Evidence</span></th>
            <th>Node</th><th>Line</th><th>Role</th><th>Identity</th>
            <th>Attribution</th><th class="num">Traffic</th><th>Counts</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="(row, index) in linePage.rows" :key="rowKey(row, index)">
            <tr class="usage-row" :data-open="openRows.has(rowKey(row, index)) || undefined">
              <td class="chevron-cell">
                <button
                  class="icon-button"
                  type="button"
                  :aria-expanded="openRows.has(rowKey(row, index))"
                  :aria-label="`Evidence for ${lineLabel(row)} on ${row.node_name || row.node_id}`"
                  @click="toggleRow(rowKey(row, index))"
                >
                  <ChevronRight class="row-chevron" :size="15" aria-hidden="true" />
                </button>
              </td>
              <td>
                <strong :title="row.node_name || row.node_id">{{ row.node_name || row.node_id }}</strong>
                <small :title="row.node_id">{{ row.node_id }}</small>
              </td>
              <td>
                <strong :title="lineLabel(row)">{{ lineLabel(row) }}</strong>
                <small v-if="row.line_hash_id" class="mono" :title="row.line_hash_id">{{ row.line_hash_id }}</small>
                <small v-else class="cell-note">inbound tag only; no line on this node carries it</small>
              </td>
              <td><span class="badge" :data-tone="EGRESS_ROLES.has(row.role) ? 'info' : undefined">{{ roleLabel(row.role) }}</span></td>
              <td>
                <template v-if="row.user_id">
                  <strong :title="userLabel(row)">{{ userLabel(row) }}</strong>
                  <small :title="row.user_id">{{ row.user_id }}</small>
                </template>
                <span v-else class="status-dot" data-tone="warning">unknown</span>
              </td>
              <td>
                <span class="badge" :data-tone="attributionTone(row) === 'healthy' ? 'success' : attributionTone(row) === 'error' ? 'error' : attributionTone(row) === 'info' ? 'info' : 'warning'">
                  {{ attributionLabel(row) }}
                </span>
                <small v-if="row.attribution_proof" class="cell-note">{{ row.attribution_proof === 'proof' ? 'proven' : 'inferred' }}</small>
              </td>
              <td class="num">
                <span class="mono">{{ formatBytes(row.used_bytes) }}</span>
                <small class="cell-note" :data-tone="row.estimate ? 'warning' : undefined">{{ measurementLabel(row) }}</small>
              </td>
              <td>
                <span class="status-dot" :data-tone="row.counted ? 'healthy' : 'neutral'">
                  {{ row.counted ? 'to this identity' : 'not to a quota' }}
                </span>
              </td>
            </tr>
            <tr v-if="openRows.has(rowKey(row, index))" class="evidence-row">
              <td :colspan="8">
                <div class="evidence-grid">
                  <div>
                    <span>Why this attribution</span>
                    <p>{{ row.attribution_reason || 'The server recorded no reason for this row.' }}</p>
                  </div>
                  <div>
                    <span>Traffic split</span>
                    <p class="mono">up {{ formatBytes(row.uplink) }} / down {{ formatBytes(row.downlink) }}</p>
                    <p v-if="row.estimate" class="evidence-warn">
                      This figure is the inbound counter minus the upstream relay counters, floored at
                      zero. It is a subtraction, not a number the box reported.
                    </p>
                  </div>
                  <div v-if="upstreamLines(row).length">
                    <span>Already counted at</span>
                    <p>
                      These bytes reached this line through a relay and the entry line's counter
                      already carries them, so they do not reach a quota twice.
                    </p>
                    <p v-for="hash in upstreamLines(row)" :key="hash" class="mono evidence-hash" :title="hash">
                      {{ names.get(hash) || hash }}<span v-if="names.get(hash)"> ({{ hash }})</span>
                    </p>
                  </div>
                  <div v-if="row.candidates?.length">
                    <span>Candidates the server would not choose between</span>
                    <p>
                      The traffic is real. Any of these identities could own it, and no evidence
                      picks one, so it is reported unattributed rather than guessed onto an account.
                    </p>
                    <p v-for="candidate in row.candidates" :key="candidate" class="mono evidence-hash" :title="candidate">
                      {{ emailByUser.get(candidate) || candidate }}
                    </p>
                  </div>
                  <div v-if="!row.user_id && !row.candidates?.length">
                    <span>No identity</span>
                    <p>
                      {{ row.attribution === 'unknown_line'
                        ? 'No line on this node carries this inbound tag, so the traffic cannot be placed on a line or an account. The tag is shown as reported.'
                        : 'This traffic was measured and no identity could be attached to it. It is real usage with an unknown owner, not zero usage.' }}
                    </p>
                  </div>
                  <div>
                    <span>Inbound tag</span>
                    <p class="mono evidence-hash" :title="row.tag">{{ row.tag || 'not reported' }}</p>
                  </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <div v-else-if="failed" class="empty-state">
      <Gauge :size="24" aria-hidden="true" />
      <strong>Usage could not be read for this period</strong>
      <p>
        The request failed, so this table is empty because nothing arrived, not because nothing
        happened. Retry above; the figures on this page stay unknown until a read succeeds.
      </p>
    </div>
    <div v-else class="empty-state">
      <Gauge :size="24" aria-hidden="true" />
      <strong>No traffic in {{ periodLabel(period).toLowerCase() }}</strong>
      <p>No line reported traffic for this period. The overview says whether that is a quiet fleet or an unmeasured one.</p>
    </div>

    <footer v-if="linePage.pages > 1" class="table-pagination" aria-label="Usage line pagination">
      <span>Rows {{ linePage.from }} to {{ linePage.to }} of {{ linePage.total }}, ranked by traffic across every one of them</span>
      <button class="button button-secondary button-compact" type="button" :disabled="linePage.page === 1" @click="page = linePage.page - 1">Previous</button>
      <span>Page {{ linePage.page }} of {{ linePage.pages }}</span>
      <button class="button button-secondary button-compact" type="button" :disabled="linePage.page === linePage.pages" @click="page = linePage.page + 1">Next</button>
    </footer>

    <p v-if="!canDrillDown && sortedLines.length" class="permission-note panel-note">
      This session cannot run per-identity usage queries, so the rows above are the whole of the
      evidence available here. They are the same figures the query would return for this period.
    </p>
  </section>

  <!-- ── By user ──────────────────────────────────────────────────────── -->
  <div v-else class="layer-body" role="tabpanel" aria-label="By user">
    <section v-if="underAttributed && !failed" class="data-panel explain-panel" aria-label="How much traffic carries an identity">
      <Users :size="17" aria-hidden="true" />
      <div>
        <strong>{{ attribution.countedLines }} of {{ attribution.lines }} lines and {{ percent(attribution.share) }} of the bytes {{ periodSentence }} carry an identity.</strong>
        <p>
          The rest is real traffic with no known owner, so the figures below cover only part of what
          the fleet moved. Bind identities to lines in Users, and the next period can be counted per
          person.
        </p>
        <div class="explain-actions">
          <button v-if="canOpenUsers" class="button button-secondary button-compact" type="button" @click="emit('openUsers')">Open Users</button>
          <span v-else class="muted">Users, in this plugin's navigation</span>
        </div>
      </div>
    </section>

    <section class="data-panel" aria-labelledby="usage-users-title">
      <header class="panel-header">
        <div><h2 id="usage-users-title">By identity</h2><p>What this period counts against each account's quota.</p></div>
        <Users :size="17" aria-hidden="true" />
      </header>
      <div v-if="fold.byUser.length" class="table-wrap">
        <table class="usage-users">
          <thead><tr><th class="sticky-first">Identity</th><th class="num">Counted</th><th>Quota</th><th>Expires</th><th class="num">Nodes</th></tr></thead>
          <tbody>
            <tr v-for="user in fold.byUser" :key="user.userID">
              <td class="sticky-first">
                <strong :title="user.email || user.userID">{{ user.email || user.userID }}</strong>
                <small :title="user.userID">{{ user.userID }}</small>
              </td>
              <td class="num">
                <span class="mono">{{ formatBytes(user.countedBytes) }}</span>
                <small v-if="user.hasEstimate" class="cell-note">includes {{ formatBytes(user.estimatedBytes) }} estimated</small>
                <small v-if="user.uncountedBytes" class="cell-note">{{ formatBytes(user.uncountedBytes) }} reported, not counted</small>
              </td>
              <td>
                <template v-if="quotaState(user.countedBytes, quotaByUser.get(user.userID)).hasQuota">
                  <div class="quota-meter" :data-tone="quotaState(user.countedBytes, quotaByUser.get(user.userID)).tone">
                    <div class="quota-bar" aria-hidden="true">
                      <span :style="{ width: `${quotaState(user.countedBytes, quotaByUser.get(user.userID)).percent}%` }" />
                    </div>
                    <small>
                      {{ quotaState(user.countedBytes, quotaByUser.get(user.userID)).percent }}% of
                      {{ formatBytes(quotaByUser.get(user.userID)) }}
                    </small>
                  </div>
                </template>
                <span v-else class="status-dot" data-tone="neutral">No quota set</span>
              </td>
              <td class="mono">{{ expiryLabel(user.userID) }}</td>
              <td class="num">{{ user.nodes.length }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else-if="failed" class="empty-state">
        <Users :size="24" aria-hidden="true" />
        <strong>Per-identity usage could not be read</strong>
        <p>This is not an empty result. The request above failed, so nothing is known about what any identity used this period.</p>
      </div>
      <div v-else class="empty-state">
        <Users :size="24" aria-hidden="true" />
        <strong>No identity was attributed traffic</strong>
        <p>
          Nothing this period folded onto an account. Either no traffic was reported, or every row
          arrived without an identity the server could place. The By line layer shows which.
        </p>
      </div>
    </section>
    <p v-if="!failed && fold.unattributedBytes > 0" class="permission-note panel-note standalone-note">
      {{ formatBytes(fold.unattributedBytes) }} {{ periodSentence }} is real traffic, owner unknown. The By line layer lists it row by row, with the reason the server gave for each.
    </p>
  </div>
</template>
