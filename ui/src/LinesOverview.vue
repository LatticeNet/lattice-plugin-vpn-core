<script setup lang="ts">
/**
 * Lines, L0. Attention first when there is any, then three numbers, then the
 * route map, then the nodes by traffic. Everything here is read from the same
 * line listing and the seven-day usage read the rest of the page uses; a
 * failed usage read turns every traffic figure into "unknown" and the map's
 * widths into line counts, and the page says which.
 */
import { computed } from "vue";
import { CircleAlert, Waypoints } from "@lucide/vue";

import type { AttentionItem, NodeRow } from "./fleetRows";
import { buildNodeRows, lineRole, serviceVerdict } from "./fleetRows";
import MiddleText from "./MiddleText.vue";
import RouteMap from "./RouteMap.vue";
import { buildRouteMap, routeShape } from "./routeMap";
import Sparkline from "./Sparkline.vue";
import { changeAgainst, hasSeries, nodeDaily, type NodeTraffic, type UsagePrevious, type UsageSeries } from "./trafficModel";
import { formatBytes, type LineChain, type LineGroup } from "./vpnModel";

const props = defineProps<{
  groups: readonly LineGroup[];
  chains: readonly LineChain[];
  attention: readonly AttentionItem[];
  /** Usage for the period was read; false when it failed or was not allowed. */
  usageKnown: boolean;
  /** Why usage is unknown, for the one sentence that says so. */
  usageNote: string;
  egress?: number;
  byLine: ReadonlyMap<string, number>;
  byNode: ReadonlyMap<string, NodeTraffic>;
  /** Nodes whose collector reported; a node outside it has unknown traffic. */
  reportingNodes: ReadonlySet<string>;
  series?: UsageSeries;
  previous?: UsagePrevious;
  periodLabel: string;
  canAct: (item: AttentionItem) => boolean;
  actionLabel: (item: AttentionItem) => string;
}>();
const emit = defineEmits<{
  attention: [item: AttentionItem];
  showAttention: [];
  node: [nodeID: string];
  lines: [];
}>();

const ATTENTION_SHOWN = 3;
const shownAttention = computed(() => props.attention.slice(0, ATTENTION_SHOWN));

const shape = computed(() => routeShape(props.groups));
const lineCount = computed(() => props.groups.reduce((sum, group) => sum + group.lines.length, 0));
const managed = computed(() => props.groups.reduce((sum, group) => sum + group.lines.filter((line) => line.managed).length, 0));
const change = computed(() => (props.usageKnown && props.egress !== undefined ? changeAgainst(props.egress, props.previous) : undefined));

const map = computed(() => buildRouteMap(props.groups, props.chains, { known: props.usageKnown, byLine: props.byLine, byNode: props.byNode, reportingNodes: props.reportingNodes }));
const series = computed(() => (hasSeries(props.series) ? props.series : undefined));

interface NodeLine {
  row: NodeRow;
  role: string;
  egress?: number;
  relayed?: number;
  total: number;
  trend?: number[];
  running: number;
}
const nodes = computed<NodeLine[]>(() => buildNodeRows(props.groups).map((row) => {
  const traffic = props.byNode.get(row.group.node_id);
  const known = props.usageKnown && props.reportingNodes.has(row.group.node_id);
  return {
    row,
    role: row.counts.relays ? (row.counts.exits ? "relay hub, exits" : "relay hub") : row.counts.exits ? "exit" : "no outbound",
    egress: known ? traffic?.egress ?? 0 : undefined,
    relayed: known ? traffic?.repeated ?? 0 : undefined,
    total: traffic?.total ?? 0,
    trend: series.value ? nodeDaily(series.value, row.group.node_id) ?? new Array(series.value.days.length).fill(0) : undefined,
    running: row.lines.filter((line) => line.service_state === "running").length,
  };
}).sort((a, b) => b.total - a.total || (a.row.group.node_name || a.row.group.node_id).localeCompare(b.row.group.node_name || b.row.group.node_id)));

function bytesOrUnknown(value: number | undefined): string {
  return value === undefined ? "unknown" : value === 0 ? "-" : formatBytes(value);
}

/** `running 13/13` where the probe reported, otherwise what it did say. */
function serviceText(line: NodeLine): string {
  const verdict = serviceVerdict(line.row.lines);
  if (verdict === "unknown") return line.row.lines.some((value) => value.service_note) ? "unproven" : "not reported";
  if (verdict === "down") return `down · running ${line.running}/${line.row.lines.length}`;
  if (verdict === "restarting") return `restarting · running ${line.running}/${line.row.lines.length}`;
  return `running ${line.running}/${line.row.lines.length}`;
}
function serviceTone(line: NodeLine): string {
  const verdict = serviceVerdict(line.row.lines);
  if (verdict === "down") return "error";
  if (verdict === "restarting" || verdict === "partial") return "warning";
  if (verdict === "running") return "healthy";
  return "neutral";
}
const orphanLines = computed(() => props.groups.reduce((sum, group) => sum + group.lines.filter((line) => lineRole(line) === "orphan").length, 0));
</script>

<template>
  <!-- One line per claim on the overview; the Attention layer carries the
       full evidence. The line keeps it on hover and in its accessible name. -->
  <section v-if="attention.length" class="data-panel attention-strip" aria-label="Attention">
    <ol class="attention-list">
      <li v-for="item in shownAttention" :key="item.key" class="attention-item" :data-severity="item.severity">
        <span class="status-dot" :data-tone="item.severity === 'error' ? 'error' : item.severity === 'warning' ? 'warning' : 'neutral'">{{ item.severity }}</span>
        <p class="attention-line" :title="`${item.claim}. ${item.evidence}`"><strong>{{ item.claim }}</strong> <span>{{ item.evidence }}</span></p>
        <div class="attention-actions">
          <button v-if="canAct(item)" class="button button-secondary button-compact" type="button" @click="emit('attention', item)">{{ actionLabel(item) }}</button>
        </div>
      </li>
      <li v-if="attention.length > ATTENTION_SHOWN" class="attention-more">
        <button class="button button-secondary button-compact" type="button" @click="emit('showAttention')">Show all {{ attention.length }}</button>
      </li>
    </ol>
  </section>

  <section class="summary-strip overview-numbers" aria-label="Lines at a glance" style="--stat-count: 3">
    <div>
      <span>Egress, last {{ periodLabel }}</span>
      <strong>{{ usageKnown && egress !== undefined ? formatBytes(egress) : 'unknown' }}</strong>
      <small v-if="!usageKnown">{{ usageNote }}</small>
      <small v-else-if="change">{{ change.label }} against the previous {{ periodLabel }} ({{ formatBytes(change.previousBytes) }})</small>
      <small v-else>exit, direct and shared lines; no earlier period reported to compare with</small>
    </div>
    <div>
      <span>Route shape</span>
      <strong>{{ shape.hubs }} relay {{ shape.hubs === 1 ? 'hub' : 'hubs' }}, {{ shape.exits }} egress {{ shape.exits === 1 ? 'node' : 'nodes' }}</strong>
      <small>{{ shape.relayLines }} relay lines, {{ shape.exitLines }} exit lines<template v-if="orphanLines">, {{ orphanLines }} with no outbound</template></small>
    </div>
    <div>
      <span>Lines</span>
      <strong>{{ lineCount }}</strong>
      <small>{{ managed }} managed, {{ lineCount - managed }} discovered</small>
    </div>
  </section>

  <section class="data-panel route-panel" aria-labelledby="route-map-title">
    <header class="panel-header">
      <div>
        <h2 id="route-map-title">Route map</h2>
        <p class="wide-measure">Traffic enters at a relay hub and leaves from the node it dials. Choose a node to see its lines.</p>
      </div>
      <span class="count">{{ map.edges.length }} {{ map.edges.length === 1 ? 'route' : 'routes' }} · {{ map.boxes.length }} nodes</span>
    </header>
    <div v-if="map.edges.length" class="route-panel-body">
      <RouteMap :map="map" :period-label="periodLabel" @node="(id) => emit('node', id)" />
      <p v-if="map.directOnly.nodes" class="route-note">
        {{ map.directOnly.nodes }} {{ map.directOnly.nodes === 1 ? 'node sends' : 'nodes send' }} traffic out directly with no relay in front<template v-if="map.directOnly.bytes !== undefined"> ({{ formatBytes(map.directOnly.bytes) }})</template>, so {{ map.directOnly.nodes === 1 ? 'it is' : 'they are' }} in the node table below and not on the map.
      </p>
    </div>
    <div v-else class="empty-state">
      <Waypoints :size="26" aria-hidden="true" />
      <strong>No line relays through another</strong>
      <p v-if="lineCount">Every line on this fleet sends its traffic out directly, so there is no route to draw. The node table below lists where traffic leaves.</p>
      <p v-else>No node has reported a line yet. A line appears once a node agent reports its inbounds.</p>
    </div>
  </section>

  <section v-if="nodes.length" class="data-panel" aria-labelledby="overview-nodes">
    <header class="panel-header">
      <div><h2 id="overview-nodes">Nodes by traffic</h2><p class="wide-measure">Egress left the fleet from this node. Relayed went on to another node, which counts it again as its egress.</p></div>
      <button class="button button-secondary button-compact" type="button" @click="emit('lines')">All {{ lineCount }} lines</button>
    </header>
    <p v-if="!usageKnown" class="panel-inline-note"><CircleAlert :size="14" aria-hidden="true" /> {{ usageNote }}</p>
    <div class="table-wrap">
      <table class="overview-nodes-table">
        <thead><tr>
          <th class="sticky-first">Node</th>
          <th>Role</th>
          <th class="num">Lines</th>
          <th class="num">Egress</th>
          <th class="num">Relayed</th>
          <th v-if="series">Trend, {{ series.days.length }} days</th>
          <th>Service</th>
        </tr></thead>
        <tbody>
          <tr v-for="line in nodes" :key="line.row.group.node_id" class="clickable-row" @click="emit('node', line.row.group.node_id)">
            <td class="sticky-first">
              <button class="row-open" type="button" :title="`Open the lines on ${line.row.group.node_name || line.row.group.node_id}`" @click.stop="emit('node', line.row.group.node_id)">
                <strong><MiddleText :text="line.row.group.node_name || line.row.group.node_id" /></strong>
              </button>
            </td>
            <td>{{ line.role }}</td>
            <td class="num mono">{{ line.row.lines.length }}</td>
            <td class="num mono" :data-unknown="line.egress === undefined || undefined">{{ bytesOrUnknown(line.egress) }}</td>
            <td class="num mono" :data-unknown="line.relayed === undefined || undefined">{{ bytesOrUnknown(line.relayed) }}</td>
            <td v-if="series"><Sparkline v-if="line.trend" :values="line.trend" :label="`${line.row.group.node_name || line.row.group.node_id}, bytes per day`" /></td>
            <td><span class="status-dot" :data-tone="serviceTone(line)">{{ serviceText(line) }}</span></td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
