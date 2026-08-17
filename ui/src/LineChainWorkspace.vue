<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Link2, LoaderCircle, Trash2 } from "@lucide/vue";

import { normalizeChainTopology, pageTopologyRows, type TopologyEdgeKind } from "./chainTopology";
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
const sourceUUID = ref("");
const targetUUID = ref("");
const topology = computed(() => normalizeChainTopology(props.groups, props.chains));
const pageData = computed(() => pageTopologyRows(topology.value.rows, page.value));
const lineEntries = computed(() => props.groups.flatMap((group) => group.lines
  .filter((line) => !!line.line_uuid)
  .map((line) => ({ line, label: `${group.node_name || group.node_id} / ${line.name}` }))));
const sources = computed(() => lineEntries.value);
const targets = computed(() => lineEntries.value.filter(({ line }) => line.managed && line.line_uuid !== sourceUUID.value));
const selectedRow = computed(() => topology.value.rows.find((row) => row.sourceLineUUID === sourceUUID.value));
const sourceBusy = computed(() => !!sourceUUID.value && props.busySources.has(sourceUUID.value));
const graphHeight = computed(() => Math.min(420, 80 + Math.floor(Math.max(0, topology.value.graph.nodes.length - 1) / 10) * 36));

watch([sources, targets], () => {
  if (!sources.value.some(({ line }) => line.line_uuid === sourceUUID.value)) sourceUUID.value = sources.value[0]?.line.line_uuid ?? "";
  if (!targets.value.some(({ line }) => line.line_uuid === targetUUID.value)) targetUUID.value = targets.value[0]?.line.line_uuid ?? "";
}, { immediate: true });
watch(() => topology.value.rows.length, () => { page.value = 1; });

function point(index: number): { x: number; y: number } {
  return { x: 54 + (index % 10) * 84, y: 44 + Math.floor(index / 10) * 36 };
}
function pointFor(uuid: string): { x: number; y: number } | undefined {
  const index = topology.value.graph.nodes.findIndex((node) => node.lineUUID === uuid);
  return index < 0 ? undefined : point(index);
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
      <div><h2 id="topology-title">Line topology</h2><p>Committed, observed, and proposed state stay separate. The table is the canonical representation.</p></div>
      <span class="count">{{ topology.rows.length }} sources</span>
    </header>

    <form class="chain-plan-form" @submit.prevent="emit('plan', sourceUUID, targetUUID)">
      <label class="field"><span>Source · consumer / hub</span><select v-model="sourceUUID"><option v-for="entry in sources" :key="entry.line.line_uuid" :value="entry.line.line_uuid">{{ entry.label }}</option></select></label>
      <label class="field"><span>Target · downstream / producer</span><select v-model="targetUUID"><option v-for="entry in targets" :key="entry.line.line_uuid" :value="entry.line.line_uuid">{{ entry.label }}</option></select></label>
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
      <p v-else class="permission-note">Plans create approval previews only; topology changes after approved host execution and observation.</p>
    </form>

    <div v-if="topology.graph.nodes.length" class="topology-graph-shell">
      <p v-if="topology.graph.truncated" class="graph-cap-notice" role="status">Visualization capped at 100 of {{ topology.graph.totalNodes }} lines. Use the complete paginated table below.</p>
      <svg class="topology-graph" :viewBox="`0 0 864 ${graphHeight}`" role="img" aria-labelledby="graph-title graph-desc">
        <title id="graph-title">Bounded line topology visualization</title>
        <desc id="graph-desc">Secondary visualization of the same committed, observed, declared, and inferred evidence listed in the canonical table.</desc>
        <g v-for="edge in topology.graph.edges" :key="edge.id" class="graph-edge" :data-kind="edge.kind">
          <line v-if="pointFor(edge.from) && edge.to && pointFor(edge.to)" :x1="pointFor(edge.from)!.x" :y1="pointFor(edge.from)!.y" :x2="pointFor(edge.to)!.x" :y2="pointFor(edge.to)!.y" />
          <title>{{ edgeLabel(edge.kind) }}: {{ edge.from }} to {{ edge.to }}</title>
        </g>
        <g v-for="(node, index) in topology.graph.nodes" :key="node.lineUUID" class="graph-node" :transform="`translate(${point(index).x} ${point(index).y})`">
          <rect x="-31" y="-11" width="62" height="22" rx="4" />
          <text text-anchor="middle" dominant-baseline="middle">{{ node.label.slice(0, 9) }}</text>
          <title>{{ node.label }} · {{ node.lineUUID }}</title>
        </g>
      </svg>
    </div>

    <div class="table-wrap topology-table-wrap">
      <table class="topology-table">
        <caption class="sr-only">Canonical line topology state</caption>
        <thead><tr><th>Source</th><th>Committed baseline</th><th>Proposal (not an edge)</th><th>Observed evidence</th><th>Discovery evidence</th><th>Status</th><th>Error</th></tr></thead>
        <tbody>
          <tr v-for="row in pageData.rows" :key="row.sourceLineUUID">
            <td>
              <strong>{{ row.sourceLabel }}</strong>
              <small class="mono">{{ row.sourceLineUUID }}</small>
              <small><span>Source node: </span><span class="mono">{{ row.sourceNodeID || 'unknown' }}</span></small>
            </td>
            <td>
              <template v-if="row.currentTarget"><strong>{{ row.currentTarget.label }}</strong><small class="mono">{{ row.currentTarget.lineUUID }}<span v-if="!row.currentTarget.resolved"> · unresolved</span></small></template>
              <span v-else-if="row.removalTombstone" class="badge" data-tone="info">committed removal</span>
              <span v-else>-</span>
            </td>
            <td><template v-if="row.proposal"><strong>{{ row.proposal.operation }} · {{ row.proposal.status }}</strong><small class="mono">{{ row.proposal.targetLineUUID || 'removal' }} · {{ row.proposal.approvalID }}</small></template><span v-else>-</span></td>
            <td><template v-if="row.observedTarget"><strong>{{ row.observedTarget.label }}</strong><small class="mono">{{ row.observedTarget.lineUUID }}<span v-if="!row.observedTarget.resolved"> · unresolved</span></small></template><span v-else>-</span></td>
            <td>
              <ul v-if="row.discoveredTargets.length" class="topology-evidence-list" aria-label="Discovered topology evidence">
                <li v-for="item in row.discoveredTargets" :key="`${item.kind}:${item.target.lineUUID}`">
                  <strong>{{ item.kind === 'discovered_declared' ? 'declared' : 'inferred' }}</strong>
                  <small class="mono">{{ item.target.lineUUID }}<span v-if="!item.target.resolved"> · unresolved</span></small>
                </li>
              </ul>
              <span v-else>-</span>
            </td>
            <td><span class="status-dot" :data-tone="row.chain ? lineChainTone(row.chain) : 'neutral'">{{ row.status }}</span></td>
            <td :class="{ 'error-text': row.lastError }">{{ row.lastError || '-' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <footer v-if="pageData.pages > 1" class="topology-pagination" aria-label="Topology table pagination">
      <button class="button button-secondary button-compact" type="button" :disabled="pageData.page === 1" @click="page--">Previous</button>
      <span>Page {{ pageData.page }} of {{ pageData.pages }}</span>
      <button class="button button-secondary button-compact" type="button" :disabled="pageData.page === pageData.pages" @click="page++">Next</button>
    </footer>
  </section>
</template>
