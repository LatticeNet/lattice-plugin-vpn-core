<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Link2, LoaderCircle, Trash2, Waypoints } from "@lucide/vue";

import {
  connectedSubgraph,
  filterTopologyRows,
  layoutChainGraph,
  normalizeChainTopology,
  pageTopologyRows,
  summarizeTopology,
  type RowEvidence,
  type TopologyEdgeKind,
} from "./chainTopology";
import { lineChainTone, type LineChain, type LineGroup } from "./vpnModel";

const props = defineProps<{
  groups: readonly LineGroup[];
  chains: readonly LineChain[];
  canPlan: boolean;
  canRemove: boolean;
  busySources: ReadonlySet<string>;
}>();
const emit = defineEmits<{
  plan: [sourceLineUUID: string, targetLineUUID: string];
  remove: [sourceLineUUID: string];
}>();

const page = ref(1);
const filter = ref<RowEvidence | "all">("all");
const sourceUUID = ref("");
const targetUUID = ref("");

const topology = computed(() => normalizeChainTopology(props.groups, props.chains));
const summary = computed(() => summarizeTopology(topology.value));
const filteredRows = computed(() => filterTopologyRows(topology.value.rows, filter.value));
/* 25, not the module default of 100. The frame has no scrollport of its own, so
 * every row this panel prints is height the operator has to scroll past to
 * reach the fleet table below it. 100 rows of a fleet with no chains is five
 * thousand pixels of dashes. */
const PAGE_SIZE = 25;
const pageData = computed(() => pageTopologyRows(filteredRows.value, page.value, PAGE_SIZE));

/* Only the part of the bounded graph that carries an edge is worth drawing. A
 * node with no edge repeats a label the table already prints, truncated to
 * nine characters; a hundred of them is a wall, not a topology. */
const connected = computed(() => connectedSubgraph(topology.value.graph));
const layout = computed(() => layoutChainGraph(connected.value.nodes, connected.value.edges));
const hasDrawing = computed(() => layout.value.nodes.length > 0);

const lineEntries = computed(() => props.groups.flatMap((group) => group.lines
  .filter((line) => !!line.line_uuid)
  .map((line) => ({ line, label: `${group.node_name || group.node_id} / ${line.name}` }))));
const sources = computed(() => lineEntries.value);
const targets = computed(() => lineEntries.value.filter(({ line }) => line.managed && line.line_uuid !== sourceUUID.value));
const selectedRow = computed(() => topology.value.rows.find((row) => row.sourceLineUUID === sourceUUID.value));
const sourceBusy = computed(() => !!sourceUUID.value && props.busySources.has(sourceUUID.value));
const noTargets = computed(() => sources.value.length > 0 && targets.value.length === 0);

const FILTERS: Array<{ key: RowEvidence | "all"; label: string; hint: string }> = [
  { key: "all", label: "Sources", hint: "Every line that can carry a chain" },
  { key: "attention", label: "Needs attention", hint: "Failed, drifted, or carrying an error" },
  { key: "proposed", label: "Proposed", hint: "An approval is filed and not yet executed" },
  { key: "linked", label: "Linked", hint: "A committed or observed downstream target" },
  { key: "discovered", label: "Discovery only", hint: "Runtime evidence with no committed chain" },
  { key: "unlinked", label: "No chain", hint: "Nothing committed, proposed, or observed" },
];

function countFor(key: RowEvidence | "all"): number {
  return key === "all" ? summary.value.sources : summary.value[key];
}

watch([sources, targets], () => {
  if (!sources.value.some(({ line }) => line.line_uuid === sourceUUID.value)) sourceUUID.value = sources.value[0]?.line.line_uuid ?? "";
  if (!targets.value.some(({ line }) => line.line_uuid === targetUUID.value)) targetUUID.value = targets.value[0]?.line.line_uuid ?? "";
}, { immediate: true });
watch([() => topology.value.rows.length, filter], () => { page.value = 1; });

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}\u2026` : value;
}

function edgeLabel(kind: TopologyEdgeKind): string {
  return ({
    verified: "Verified current and observed",
    committed: "Committed baseline",
    observed: "Observed evidence",
    discovered_declared: "Discovered declared edge",
    discovered_inferred: "Discovered inferred edge",
  } as const)[kind];
}
</script>

<template>
  <section class="data-panel topology-workspace" aria-labelledby="topology-title">
    <header class="panel-header">
      <div>
        <h2 id="topology-title">Line topology</h2>
        <p>Committed, observed, and proposed state stay separate. The table is the canonical representation.</p>
      </div>
      <span class="count">{{ summary.sources }} sources · {{ summary.edges }} edges</span>
    </header>

    <div class="evidence-summary" role="group" aria-label="Filter the canonical table by evidence">
      <button
        v-for="item in FILTERS"
        :key="item.key"
        class="evidence-cell"
        type="button"
        :aria-pressed="filter === item.key"
        :title="item.hint"
        @click="filter = item.key"
      >
        <span>{{ item.label }}</span>
        <strong>{{ countFor(item.key) }}</strong>
        <small>{{ item.hint }}</small>
      </button>
    </div>

    <form class="chain-plan-form" @submit.prevent="emit('plan', sourceUUID, targetUUID)">
      <label class="field"><span>Source · consumer / hub</span><select v-model="sourceUUID"><option v-for="entry in sources" :key="entry.line.line_uuid" :value="entry.line.line_uuid">{{ entry.label }}</option></select></label>
      <label class="field"><span>Target · downstream / producer</span><select v-model="targetUUID" :disabled="noTargets"><option v-if="noTargets" value="">No managed line available</option><option v-for="entry in targets" :key="entry.line.line_uuid" :value="entry.line.line_uuid">{{ entry.label }}</option></select></label>
      <div class="chain-plan-actions">
        <button class="button button-primary" type="submit" :disabled="!canPlan || !sourceUUID || !targetUUID || sourceBusy">
          <LoaderCircle v-if="sourceBusy" class="spin" :size="15" />
          <Link2 v-else :size="15" />
          {{ selectedRow?.currentTarget ? 'Plan replacement' : 'Plan chain' }}
        </button>
        <button class="button button-secondary destructive" type="button" :disabled="!canRemove || !selectedRow?.currentTarget || sourceBusy" @click="emit('remove', sourceUUID)">
          <Trash2 :size="15" /> Plan removal
        </button>
      </div>
      <p v-if="!canPlan && !canRemove" class="permission-note">Read-only session. Planning controls are unavailable.</p>
      <p v-else-if="noTargets" class="permission-note">A chain target has to be a Lattice-managed line. Roll one out first, then a chain can be planned onto it.</p>
      <p v-else class="permission-note">Plans create approval previews only; topology changes after approved host execution and observation.</p>
    </form>

    <div v-if="hasDrawing" class="topology-graph-shell">
      <p v-if="topology.graph.truncated" class="graph-cap-notice" role="status">The drawing can only reach the first {{ topology.graph.nodes.length }} of {{ topology.graph.totalNodes }} lines. An edge touching any line past that appears in the table below and not in the picture.</p>
      <p v-else-if="layout.dropped" class="graph-cap-notice" role="status">The drawing stops at {{ layout.nodes.length }} linked lines. The remaining {{ layout.dropped }} are in the table below.</p>
      <ul class="graph-legend">
        <li><i style="border-top-color: var(--tone-ok);" /> Verified</li>
        <li><i style="border-top-color: var(--tone-info);" /> Committed</li>
        <li><i style="border-top-color: var(--tone-warn);" /> Observed</li>
        <li><i style="border-top-color: var(--muted-foreground); border-top-style: dashed;" /> Discovered</li>
      </ul>
      <!-- Capped at its own intrinsic width: stretched to fill 1440px a
           four-node graph renders 8px labels at triple size. -->
      <svg class="topology-graph" :style="{ maxWidth: `${layout.width}px` }" :viewBox="`0 0 ${layout.width} ${layout.height}`" role="img" aria-labelledby="graph-title graph-desc">
        <title id="graph-title">Line chain topology, ranked by hop</title>
        <desc id="graph-desc">Secondary visualization of the same committed, observed, declared, and inferred evidence listed in the canonical table. Only lines that carry an edge are drawn.</desc>
        <g v-for="edge in layout.edges" :key="edge.id" class="graph-edge" :data-kind="edge.kind">
          <line :x1="edge.x1" :y1="edge.y1" :x2="edge.x2" :y2="edge.y2" />
          <title>{{ edgeLabel(edge.kind) }}: {{ edge.from }} to {{ edge.to }}</title>
        </g>
        <!-- Two lines, node first. Line names repeat across the fleet, so a box
             labelled with the line name alone is not identifiable. -->
        <g v-for="node in layout.nodes" :key="node.lineUUID" class="graph-node" :transform="`translate(${node.x} ${node.y})`">
          <rect x="-100" y="-19" width="200" height="38" rx="5" />
          <text class="graph-node-owner" text-anchor="middle" y="-4">{{ clip(node.nodeID || 'unknown node', 26) }}</text>
          <text text-anchor="middle" y="10">{{ clip(node.label, 26) }}</text>
          <title>{{ node.nodeID || 'unknown node' }} / {{ node.label }} · {{ node.lineUUID }}</title>
        </g>
      </svg>
    </div>

    <!-- No edge exists, so there is no topology to draw. Say what is missing
         and what produces it, instead of drawing a hundred lone boxes. -->
    <div v-else class="empty-state">
      <Waypoints :size="26" aria-hidden="true" />
      <strong>No topology to draw yet</strong>
      <p v-if="!summary.sources">No line carries a <code>line_uuid</code>, so no line can be the end of a chain. Lines get an identity once the server has rediscovered them, or once the line is reattached from its detail panel.</p>
      <p v-else>
        {{ summary.sources }} lines can carry a chain and none of them has one.
        A chain appears here once a plan is approved and the apply is observed on the node.
        Runtime jump-edge discovery is not reporting on this fleet, so there is no inferred topology either.
      </p>
    </div>

    <div class="table-wrap topology-table-wrap">
      <table class="topology-table">
        <caption class="sr-only">Canonical line topology state</caption>
        <thead><tr><th>Source</th><th>Committed baseline</th><th>Proposal (not an edge)</th><th>Observed evidence</th><th>Discovery evidence</th><th>Status</th><th>Error</th></tr></thead>
        <tbody>
          <tr v-for="row in pageData.rows" :key="row.sourceLineUUID">
            <td>
              <strong :title="row.sourceLabel">{{ row.sourceLabel }}</strong>
              <small class="mono" :title="row.sourceLineUUID">{{ row.sourceLineUUID }}</small>
              <small :title="row.sourceNodeID || 'unknown'"><span>Source node: </span><span class="mono">{{ row.sourceNodeID || 'unknown' }}</span></small>
            </td>
            <td>
              <template v-if="row.currentTarget"><strong :title="row.currentTarget.label">{{ row.currentTarget.label }}</strong><small class="mono" :title="row.currentTarget.lineUUID">{{ row.currentTarget.lineUUID }}<span v-if="!row.currentTarget.resolved"> · unresolved</span></small></template>
              <span v-else-if="row.removalTombstone" class="badge" data-tone="info">committed removal</span>
              <span v-else>-</span>
            </td>
            <td><template v-if="row.proposal"><strong>{{ row.proposal.operation }} · {{ row.proposal.status }}</strong><small class="mono" :title="row.proposal.approvalID">{{ row.proposal.targetLineUUID || 'removal' }} · {{ row.proposal.approvalID }}</small></template><span v-else>-</span></td>
            <td><template v-if="row.observedTarget"><strong :title="row.observedTarget.label">{{ row.observedTarget.label }}</strong><small class="mono" :title="row.observedTarget.lineUUID">{{ row.observedTarget.lineUUID }}<span v-if="!row.observedTarget.resolved"> · unresolved</span></small></template><span v-else>-</span></td>
            <td>
              <ul v-if="row.discoveredTargets.length" class="topology-evidence-list" aria-label="Discovered topology evidence">
                <li v-for="item in row.discoveredTargets" :key="`${item.kind}:${item.target.lineUUID}`">
                  <strong>{{ item.kind === 'discovered_declared' ? 'declared' : 'inferred' }}</strong>
                  <small class="mono" :title="item.target.lineUUID">{{ item.target.lineUUID }}<span v-if="!item.target.resolved"> · unresolved</span></small>
                </li>
              </ul>
              <span v-else>-</span>
            </td>
            <td><span class="status-dot" :data-tone="row.chain ? lineChainTone(row.chain) : 'neutral'" :title="row.status">{{ row.status }}</span></td>
            <td :class="{ 'error-text': row.lastError }" :title="row.lastError || undefined">{{ row.lastError || '-' }}</td>
          </tr>
          <tr v-if="!pageData.rows.length">
            <td colspan="7">
              <p class="empty-inline">
                <template v-if="filter === 'all'">No line carries a chain identity yet, so the canonical table has nothing to list.</template>
                <template v-else>No source is in the "{{ FILTERS.find((item) => item.key === filter)?.label }}" state.</template>
                <button v-if="filter !== 'all'" class="button button-secondary button-compact" type="button" @click="filter = 'all'">Show every source</button>
              </p>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <footer v-if="pageData.pages > 1" class="topology-pagination" aria-label="Topology table pagination">
      <button class="button button-secondary button-compact" type="button" :disabled="pageData.page === 1" @click="page--">Previous</button>
      <span>Page {{ pageData.page }} of {{ pageData.pages }} · {{ filteredRows.length }} rows</span>
      <button class="button button-secondary button-compact" type="button" :disabled="pageData.page === pageData.pages" @click="page++">Next</button>
    </footer>
  </section>
</template>
