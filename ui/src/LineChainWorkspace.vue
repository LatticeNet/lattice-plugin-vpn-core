<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Link2, LoaderCircle, Trash2, Waypoints } from "@lucide/vue";

import {
  aggregateNodeGraph,
  CHAIN_TARGET_REJECTION_TEXT,
  chainTargetRejection,
  diagnoseTopologyAbsence,
  filterTopologyRows,
  fitNodeLayout,
  layoutNodeGraph,
  NODE_BOX_HEIGHT,
  NODE_BOX_WIDTH,
  normalizeChainTopology,
  pageTopologyRows,
  summarizeTopology,
  type ChainTargetRejection,
  type NodeLayoutEdge,
  type RowEvidence,
  type TopologyEdgeKind,
  type TopologyRow,
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

/* The drawing: nodes, with the line count on each edge. */
const nodeGraph = computed(() => aggregateNodeGraph(props.groups, topology.value));
const layout = computed(() => layoutNodeGraph(nodeGraph.value));

/* Whether the drawing fits is a fact about this console's width, not a guess,
 * so the panel measures itself. The graph shell adds var(--sp-4) of padding on
 * each side, which the drawing does not get to use. */
const SHELL_PADDING = 32;
const panel = ref<HTMLElement>();
const panelWidth = ref(1000 + SHELL_PADDING);
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
const fit = computed(() => fitNodeLayout(layout.value, graphWidthBudget.value));
const hasDrawing = computed(() => layout.value.edges.length > 0);
/* Counts are the point of the drawing. They sit on every edge while the
 * drawing is sparse enough to read them; past that they wait for a hover,
 * a focus or a selection, and the accessible name carries them regardless. */
const LABELS_AT_REST = 24;
const labelsAtRest = computed(() => layout.value.edges.length <= LABELS_AT_REST);
const KIND_ORDER: TopologyEdgeKind[] = ["verified", "committed", "observed", "discovered_declared", "discovered_inferred"];
const legend = computed(() => {
  const present = new Set(layout.value.edges.map((edge) => edge.kind));
  const items = KIND_ORDER.filter((kind) => present.has(kind)).map((kind) => ({
    key: kind,
    label: ({ verified: "Verified", committed: "Committed", observed: "Observed", discovered_declared: "Declared", discovered_inferred: "Discovered" } as const)[kind],
    style: ({
      verified: "border-top-color: var(--tone-ok);",
      committed: "border-top-color: var(--tone-info);",
      observed: "border-top-color: var(--tone-warn);",
      discovered_declared: "border-top-color: var(--tone-info); border-top-style: dashed;",
      discovered_inferred: "border-top-color: var(--muted-foreground); border-top-style: dashed;",
    } as const)[kind],
  }));
  if (layout.value.nodes.some((node) => node.offFleet)) items.push({ key: "off", label: "Off-fleet endpoint", style: "border-top-color: var(--muted-foreground); border-top-style: dotted;" } as never);
  if (layout.value.edges.some((edge) => edge.unverified)) items.push({ key: "unverified", label: "Host matched, port unverified", style: "border-top-color: var(--tone-warn); border-top-style: dotted;" } as never);
  if (layout.value.nodes.some((node) => node.members)) items.push({ key: "cluster", label: "Hubs with the same exits, folded", style: "border-top-color: var(--primary); border-top-width: 3px;" } as never);
  return items;
});

const absence = computed(() => diagnoseTopologyAbsence(props.groups, topology.value, layout.value.edges.length));

/* A selection narrows the canonical table to the lines behind one box or one
 * edge. It is the drawing's only job beyond being looked at. */
type Selection = { kind: "node"; id: string } | { kind: "edge"; id: string };
const selection = ref<Selection | null>(null);
const selectedEdge = computed(() => selection.value?.kind === "edge" ? layout.value.edges.find((edge) => edge.id === selection.value!.id) : undefined);
const selectedNode = computed(() => selection.value?.kind === "node" ? layout.value.nodes.find((node) => node.id === selection.value!.id) : undefined);
const nodeLabel = new Map<string, string>();
watch(layout, (value) => {
  nodeLabel.clear();
  for (const node of value.nodes) nodeLabel.set(node.id, node.label);
}, { immediate: true });
function labelOf(id: string): string {
  return nodeLabel.get(id) ?? id;
}
function select(next: Selection): void {
  selection.value = selection.value && selection.value.kind === next.kind && selection.value.id === next.id ? null : next;
}
watch([() => props.groups, () => props.chains], () => {
  if (selection.value?.kind === "node" && !layout.value.nodes.some((node) => node.id === selection.value!.id)) selection.value = null;
  if (selection.value?.kind === "edge" && !layout.value.edges.some((edge) => edge.id === selection.value!.id)) selection.value = null;
});

function rowTouches(row: TopologyRow, nodeID: string): boolean {
  if (row.sourceNodeID === nodeID) return true;
  const targets: Array<TopologyTarget | undefined> = [row.currentTarget, row.observedTarget, ...row.discoveredTargets.map((item) => item.target)];
  return targets.some((target) => target?.nodeID === nodeID);
}

const selectedRows = computed(() => {
  const rows = topology.value.rows;
  if (!selection.value) return rows;
  if (selection.value.kind === "edge") {
    const wanted = new Set(selectedEdge.value?.sourceLineUUIDs ?? []);
    return rows.filter((row) => wanted.has(row.sourceLineUUID));
  }
  const nodeID = selection.value.id;
  const members = selectedNode.value?.members;
  if (members?.length) return rows.filter((row) => members.some((member) => rowTouches(row, member)));
  return rows.filter((row) => rowTouches(row, nodeID));
});
const filteredRows = computed(() => filterTopologyRows(selectedRows.value, filter.value));
/* 25 rows is one screen. Every row this panel prints is height the operator
 * scrolls past; the document is the only vertical scroller on this page. */
const PAGE_SIZE = 25;
const pageData = computed(() => pageTopologyRows(filteredRows.value, page.value, PAGE_SIZE));

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
  { key: "all", label: "Chain sources", hint: "Every line that can carry a chain" },
  { key: "attention", label: "Chain problems", hint: "Failed, drifted, or carrying an error" },
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
watch([() => topology.value.rows.length, filter, selection], () => { page.value = 1; });

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
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

function edgeTitle(edge: NodeLayoutEdge): string {
  const parts = Object.entries(edge.kinds).map(([kind, count]) => `${count} ${edgeLabel(kind as TopologyEdgeKind).toLowerCase()}`);
  const unresolved = edge.unresolved ? `, ${edge.unresolved} onto an endpoint no fleet line owns` : "";
  const unverified = edge.unverified ? `, ${edge.unverified} matched by host with the port unverified` : "";
  return `${labelOf(edge.from)} to ${labelOf(edge.to)}: ${edge.count} ${edge.count === 1 ? "line" : "lines"} (${parts.join(", ")})${unresolved}${unverified}`;
}

function nodeMeta(node: { offFleet: boolean; lines: number; relays: number; exits: number; members?: string[] }): string {
  if (node.offFleet) return "outside the fleet";
  const parts: string[] = [];
  if (node.relays) parts.push(`${node.relays} relay`);
  if (node.exits) parts.push(`${node.exits} exit`);
  return `${node.lines} ${node.lines === 1 ? "line" : "lines"}${parts.length ? ` · ${parts.join(" · ")}` : ""}`;
}

/** The names behind a cluster box, for its title and its selection line. */
function membersOf(node: { members?: string[] }): string {
  return (node.members ?? []).map((id) => nodeGraph.value.nodes.find((box) => box.id === id)?.label ?? labelOfMember(id)).join(", ");
}
function labelOfMember(id: string): string {
  const group = props.groups.find((entry) => entry.node_id === id);
  return group?.node_name || id;
}

/* Weight says count at a glance; the exact number is the label, shown when
 * the edge is hovered, focused or selected, because forty-seven labels at
 * once sit on top of each other where the fan-outs cross. The count is
 * always in the accessible name. */
function edgeStroke(edge: NodeLayoutEdge): number {
  return Math.min(4, 1.5 + Math.log2(edge.count) * 0.7);
}

/* Edge labels sit on the edge's midpoint; a straight edge between two ranks
 * never crosses a box, so the label is always over empty space. */
function edgeLabelPosition(edge: NodeLayoutEdge): { x: number; y: number } {
  return { x: (edge.x1 + edge.x2) / 2, y: (edge.y1 + edge.y2) / 2 - 6 };
}
</script>

<template>
  <section ref="panel" class="data-panel topology-workspace" aria-labelledby="topology-title">
    <header class="panel-header">
      <div>
        <h2 id="topology-title">Line topology</h2>
        <p>Nodes, and how many lines relay between them. Committed, observed, and proposed state stay separate; the table is the canonical representation.</p>
      </div>
      <span class="count">{{ summary.sources }} sources · {{ summary.edges }} line edges · {{ layout.nodes.length }} nodes drawn</span>
    </header>

    <div v-if="hasDrawing" class="topology-graph-shell">
      <ul class="graph-legend">
        <li v-for="item in legend" :key="item.key"><i :style="item.style" /> {{ item.label }}</li>
      </ul>
      <div class="topology-graph-scroll">
        <!-- Capped at its own intrinsic width: stretched to fill 1440px a
             four-node graph renders 12px labels at triple size. -->
        <svg
          class="topology-graph"
          :data-labels="labelsAtRest ? 'always' : 'hover'"
          :width="fit.renderWidth"
          :height="fit.renderHeight"
          :viewBox="`0 0 ${layout.width} ${layout.height}`"
          role="img"
          aria-labelledby="graph-title graph-desc"
        >
          <title id="graph-title">Node relay topology, ordered by depth from a node nothing relays into</title>
          <desc id="graph-desc">Each box is a node; each arrow is the set of lines on the left node that dial into the right node, labelled with the count. Select a box or an arrow to narrow the canonical table below to those lines.</desc>
          <defs>
            <!-- userSpaceOnUse keeps the head one size; by default it scales
                 with the stroke, and a sixteen-line edge grew a head wider
                 than the box it pointed at. -->
            <marker id="topology-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
            </marker>
          </defs>
          <g
            v-for="edge in layout.edges"
            :key="edge.id"
            class="graph-edge"
            :data-kind="edge.kind"
            :data-unverified="edge.unverified ? 'true' : 'false'"
            :data-selected="selection?.kind === 'edge' && selection.id === edge.id ? 'true' : 'false'"
            role="button"
            tabindex="0"
            :aria-pressed="selection?.kind === 'edge' && selection.id === edge.id"
            :aria-label="edgeTitle(edge)"
            @click="select({ kind: 'edge', id: edge.id })"
            @keydown.enter.prevent="select({ kind: 'edge', id: edge.id })"
            @keydown.space.prevent="select({ kind: 'edge', id: edge.id })"
          >
            <line class="graph-edge-hit" :x1="edge.x1" :y1="edge.y1" :x2="edge.x2" :y2="edge.y2" />
            <line :x1="edge.x1" :y1="edge.y1" :x2="edge.x2" :y2="edge.y2" :style="{ strokeWidth: edgeStroke(edge), '--edge-w': edgeStroke(edge) }" marker-end="url(#topology-arrow)" />
            <text :x="edgeLabelPosition(edge).x" :y="edgeLabelPosition(edge).y" text-anchor="middle">x{{ edge.count }}<template v-if="edge.unverified">?</template></text>
            <title>{{ edgeTitle(edge) }}</title>
          </g>
          <g
            v-for="node in layout.nodes"
            :key="node.id"
            class="graph-node"
            :data-off-fleet="node.offFleet ? 'true' : 'false'"
            :data-role="node.members ? 'cluster' : node.relays && !node.exits ? 'relay' : node.relays ? 'mixed' : 'exit'"
            :data-selected="selection?.kind === 'node' && selection.id === node.id ? 'true' : 'false'"
            :transform="`translate(${node.x} ${node.y})`"
            role="button"
            tabindex="0"
            :aria-pressed="selection?.kind === 'node' && selection.id === node.id"
            :aria-label="`${node.label}, ${nodeMeta(node)}`"
            @click="select({ kind: 'node', id: node.id })"
            @keydown.enter.prevent="select({ kind: 'node', id: node.id })"
            @keydown.space.prevent="select({ kind: 'node', id: node.id })"
          >
            <rect x="0" y="0" :width="NODE_BOX_WIDTH" :height="NODE_BOX_HEIGHT" rx="5" />
            <rect class="graph-node-bar" x="0" y="0" width="4" :height="NODE_BOX_HEIGHT" />
            <text x="14" y="18">{{ clip(node.label, 30) }}</text>
            <text class="graph-node-meta" x="14" y="34">{{ nodeMeta(node) }}</text>
            <title>{{ node.label }} · {{ nodeMeta(node) }}<template v-if="node.members"> · {{ membersOf(node) }}</template></title>
          </g>
        </svg>
      </div>
      <p v-if="fit.overflow" class="topology-graph-note" role="status">The drawing is wider than this panel at the smallest readable scale, so it scrolls sideways.</p>
      <p v-else-if="fit.scale < 1" class="topology-graph-note">Drawn at {{ Math.round(fit.scale * 100) }}% to fit this panel.</p>
      <p class="graph-selection" aria-live="polite">
        <template v-if="selectedEdge">
          <strong>{{ labelOf(selectedEdge.from) }}</strong> to <strong>{{ labelOf(selectedEdge.to) }}</strong>
          <span>· {{ selectedEdge.count }} {{ selectedEdge.count === 1 ? 'line' : 'lines' }} · {{ edgeLabel(selectedEdge.kind).toLowerCase() }}</span>
          <span v-if="selectedEdge.unresolved">· {{ selectedEdge.unresolved }} onto an endpoint no fleet line owns</span>
          <button class="button button-secondary button-compact" type="button" @click="selection = null">Show every source</button>
        </template>
        <template v-else-if="selectedNode">
          <strong>{{ selectedNode.label }}</strong>
          <span v-if="selectedNode.members">· {{ membersOf(selectedNode) }} · {{ nodeMeta(selectedNode) }} · the table lists every line that starts on one of them</span>
          <span v-else>· {{ nodeMeta(selectedNode) }} · the table lists every line that starts or ends here</span>
          <button class="button button-secondary button-compact" type="button" @click="selection = null">Show every source</button>
        </template>
        <template v-else>
          <span>Select a box or an arrow to narrow the table to the lines behind it.</span>
        </template>
      </p>
    </div>

    <!-- No edge exists, so there is no topology to draw. Say what is missing
         and what produces it, instead of drawing lone boxes. -->
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

      <template v-else>
        <p>{{ summary.sources }} lines can carry a chain and none of them has one.</p>
      </template>
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
      <p v-else class="permission-note">Planning files an approval through <span class="mono">lines.plan_chain</span> and changes nothing on either node. The link moves only after you approve it, the host executes it, and Lattice observes the result.</p>
    </form>

    <div class="evidence-summary" role="group" aria-label="Filter the canonical chain table by evidence">
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
                <template v-if="selection">No source behind that selection is in the "{{ FILTERS.find((item) => item.key === filter)?.label }}" state.</template>
                <template v-else-if="filter === 'all'">No line carries a chain identity yet, so there is nothing to list. A line gets one when Lattice rolls it out, or when you reattach an existing UUID from the line detail.</template>
                <template v-else>No source is in the "{{ FILTERS.find((item) => item.key === filter)?.label }}" state.</template>
                <button v-if="selection" class="button button-secondary button-compact" type="button" @click="selection = null">Clear the selection</button>
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
