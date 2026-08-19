<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Link2, LoaderCircle, Trash2, Waypoints } from "@lucide/vue";

import {
  CHAIN_TARGET_REJECTION_TEXT,
  chainTargetRejection,
  connectedSubgraph,
  diagnoseTopologyAbsence,
  filterTopologyRows,
  GRAPH_ASSUMED_WIDTH,
  GRAPH_LEGIBLE_HEIGHT,
  isGraphLegible,
  layoutChainGraph,
  normalizeChainTopology,
  pageTopologyRows,
  summarizeTopology,
  type ChainTargetRejection,
  type RowEvidence,
  type TopologyEdgeKind,
  type TopologyTarget,
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
/* 25, not the module default of 100. Every row this panel prints is height the
 * operator has to scroll past to reach the fleet table below it, and 100 rows
 * of a fleet with no chains is five thousand pixels of dashes. */
const PAGE_SIZE = 25;
const pageData = computed(() => pageTopologyRows(filteredRows.value, page.value, PAGE_SIZE));

/* Only the part of the bounded graph that carries an edge is worth drawing. A
 * node with no edge repeats a label the table already prints, truncated to
 * nine characters; a hundred of them is a wall, not a topology. */
const connected = computed(() => connectedSubgraph(topology.value.graph));
const layout = computed(() => layoutChainGraph(connected.value.nodes, connected.value.edges));

/* Whether the drawing fits is a fact about this console's width, not a guess,
 * so the panel measures itself. The graph shell adds var(--sp-4) of padding on
 * each side, which the drawing does not get to use. */
const SHELL_PADDING = 32;
const panel = ref<HTMLElement>();
/* Seeded with the conservative fallback rather than zero, so the first paint
 * and any environment without a ResizeObserver still decide sensibly instead
 * of showing an empty state that a measurement immediately contradicts. */
const panelWidth = ref(GRAPH_ASSUMED_WIDTH + SHELL_PADDING);
let observer: ResizeObserver | undefined;
onMounted(() => {
  if (!panel.value) return;
  panelWidth.value = panel.value.clientWidth || panelWidth.value;
  if (typeof ResizeObserver === "undefined") return;
  observer = new ResizeObserver(([entry]) => { panelWidth.value = entry.contentRect.width; });
  observer.observe(panel.value);
});
onBeforeUnmount(() => { observer?.disconnect(); observer = undefined; });
const graphWidthBudget = computed(() => Math.max(0, Math.floor(panelWidth.value) - SHELL_PADDING));

/* A drawing scaled to a twentieth of its size is not a drawing, it is a smear.
 * When it does not fit, the table carries the topology on its own and the
 * panel says so rather than printing the smear. */
const hasDrawing = computed(() => isGraphLegible(layout.value, graphWidthBudget.value));

const absence = computed(() => diagnoseTopologyAbsence(props.groups, topology.value, {
  edges: layout.value.edges.length,
  legible: hasDrawing.value,
}));

const lineEntries = computed(() => props.groups.flatMap((group) => group.lines
  .filter((line) => !!line.line_uuid)
  .map((line) => ({ line, label: `${group.node_name || group.node_id} / ${line.name}` }))));
const sources = computed(() => lineEntries.value);
const selectedSourceNodeID = computed(() => sources.value.find(({ line }) => line.line_uuid === sourceUUID.value)?.line.node_id);
/* The server's plan call compiles a REALITY outbound onto the target and needs
 * the target's own descriptor, so it accepts a narrower set than "managed".
 * Offering anything wider means offering a plan that gets refused. */
const targetVerdicts = computed(() => lineEntries.value
  .map((entry) => ({ ...entry, rejection: chainTargetRejection(entry.line, selectedSourceNodeID.value) })));
const targets = computed(() => targetVerdicts.value.filter((entry) => entry.rejection === null));
const selectedRow = computed(() => topology.value.rows.find((row) => row.sourceLineUUID === sourceUUID.value));
const sourceBusy = computed(() => !!sourceUUID.value && props.busySources.has(sourceUUID.value));
const noTargets = computed(() => sources.value.length > 0 && targets.value.length === 0);
/* Why the eligible set is empty, counted rather than guessed. Judged without a
 * source node, so "on the source node" never appears and the counts add up to
 * the fleet: this note is about the fleet, not about the current selection. */
const targetBlockers = computed(() => {
  const counts = new Map<ChainTargetRejection, number>();
  for (const entry of lineEntries.value) {
    const rejection = chainTargetRejection(entry.line);
    if (!rejection) continue;
    counts.set(rejection, (counts.get(rejection) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count, text: CHAIN_TARGET_REJECTION_TEXT[reason] }));
});

/** The identifier a target is actually known by: uuid where it has one, hash otherwise. */
function targetHandle(target: TopologyTarget): string {
  return target.lineUUID || target.lineHashID || "unknown";
}

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
  <section ref="panel" class="data-panel topology-workspace" aria-labelledby="topology-title">
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
      <label class="field"><span>Source line, the one that dials out</span><select v-model="sourceUUID"><option v-for="entry in sources" :key="entry.line.line_uuid" :value="entry.line.line_uuid">{{ entry.label }}</option></select></label>
      <label class="field"><span>Target line, the one it dials into</span><select v-model="targetUUID" :disabled="noTargets"><option v-if="noTargets" value="">No eligible target on this fleet</option><option v-for="entry in targets" :key="entry.line.line_uuid" :value="entry.line.line_uuid">{{ entry.label }}</option></select></label>
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
      <div v-else-if="noTargets" class="chain-target-note">
        <p>A chain is built by compiling a VLESS+REALITY outbound onto the target, which needs the target's own Reality descriptor and the credential bound to it. The control plane holds those only for a line it rolled out itself, so none of the {{ sources.length }} lines on this fleet can be a target yet:</p>
        <ul class="target-blockers">
          <li v-for="blocker in targetBlockers" :key="blocker.reason"><strong>{{ blocker.count }}</strong> {{ blocker.text }}</li>
        </ul>
        <p>Roll out a managed line from the Lines view and wait for it to report healthy; it becomes selectable here on the next refresh.</p>
      </div>
      <p v-else class="permission-note">Planning files an approval and changes nothing on either node. The link moves only after you approve it, the host executes it, and Lattice observes the result.</p>
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
        <title id="graph-title">Line chain topology, ordered by depth from an unchained source</title>
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
      <strong>No topology to draw</strong>

      <template v-if="absence.reason === 'no_identity'">
        <p>No line carries a <code>line_uuid</code>, so no line can be either end of a chain. Lines get an identity once the server has rediscovered them, or once the line is reattached from its detail panel.</p>
      </template>

      <template v-else-if="absence.reason === 'no_relay'">
        <p>{{ summary.sources }} lines report their configuration and every one of them exits directly. Nothing is relaying through anything, so there is no structure to draw. This is a flat fleet of independent endpoints, not missing data.</p>
        <p>An edge appears here without any approval as soon as one line's outbound points at another line's endpoint. It also appears when an approved chain plan is applied and observed on the node.</p>
      </template>

      <template v-else-if="absence.reason === 'upstream_off_fleet'">
        <p>{{ absence.relayCandidates }} of {{ summary.sources }} lines route through a named upstream rather than exiting directly, and none of those upstreams matches an endpoint this control plane can see. An edge needs both ends on the fleet, so none can be drawn.</p>
        <p>The unmatched upstreams are:</p>
        <ul class="unmatched-upstreams">
          <li v-for="upstream in absence.unmatchedUpstreams" :key="upstream" class="mono">{{ upstream }}</li>
        </ul>
        <p>If one of these is a node Lattice should own, adopt it and the edge resolves on the next refresh. If it is a third-party provider, there is nothing further to draw.</p>
      </template>

      <template v-else-if="absence.reason === 'too_dense'">
        <p>{{ topology.edges.length }} edges across {{ summary.sources }} sources. At a size where the line names can be read the picture would be {{ layout.width }} by {{ layout.height }} pixels, and this panel has {{ graphWidthBudget }} by {{ GRAPH_LEGIBLE_HEIGHT }} to draw it in. Scaled down to fit it is a smear, so it is not drawn.</p>
        <p>The table below carries the same evidence and is the canonical form. Filter it by "Linked" or "Discovery only" above to narrow it to the lines that carry an edge.</p>
      </template>

      <template v-else-if="absence.reason === 'beyond_cap'">
        <p>{{ topology.edges.length }} edges exist, and every one of them touches a line outside the first {{ topology.graph.nodes.length }} of {{ topology.graph.totalNodes }} the drawing can reach. They are all listed in the table below.</p>
      </template>

      <template v-else>
        <p>{{ summary.sources }} lines can carry a chain and none of them has one.</p>
      </template>
    </div>

    <div class="table-wrap topology-table-wrap">
      <table class="topology-table">
        <caption class="sr-only">Canonical line topology state</caption>
        <thead><tr><th>Source</th><th>Committed baseline</th><th>Proposal (not an edge)</th><th>Observed evidence</th><th>Discovery evidence</th><th>Chain state</th><th>Error</th></tr></thead>
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
                  <small v-if="item.target.resolved" :title="item.target.label">{{ item.target.label }}</small>
                  <small class="mono" :title="targetHandle(item.target)">{{ targetHandle(item.target) }}<span v-if="!item.target.resolved"> · unresolved</span></small>
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
                <template v-if="filter === 'all'">No line carries a chain identity yet, so there is nothing to list. A line gets one when Lattice rolls it out, or when you reattach an existing UUID from the line detail.</template>
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
