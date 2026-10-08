<script setup lang="ts">
/**
 * Lines, L1: every line in one table, grouped by node, bank or exit.
 *
 * A group row carries an aggregate in every member column. A state shared by
 * every line is said once in the header and its column leaves the table; when
 * states differ the column stays and the common one recedes. A query that
 * filters or sorts flattens the table to the matching lines, in the query's
 * order, because the operator asked for lines. Each row has one affordance,
 * opening the line's panel; the evidence links sit in one menu at the end of
 * the row.
 *
 * The query is the console's (querySchemas.ts holds the fields); its text is
 * the page's `q`, so the address keeps it and an old `?q=` link still finds
 * what it found.
 */
import { computed, ref, watch } from "vue";
import { ChevronRight, Ellipsis, Radar } from "@lucide/vue";
import { PcQueryBar, useListQuery } from "@latticenet/plugin-bridge/chassis";

import {
  GROUP_BY,
  groupByLabel,
  groupLines,
  groupTraffic,
  protocolSummary,
  roleSummary,
  stateSummary,
  targetSummary,
  type GroupAggregate,
  type GroupBy,
  type LineEntry,
  type LineGroupRow,
  type LineTrafficIndex,
} from "./lineGroups";
import type { EvidenceLens } from "./navigate";
import { LINE_QUERY_EXAMPLES, LINE_QUERY_SCHEMA, lineQueryRows } from "./querySchemas";
import RowMenu, { type RowMenuItem } from "./RowMenu.vue";
import { formatBytes, pageRows, type Line, type LineGroup } from "./vpnModel";

const props = defineProps<{
  groups: LineGroup[];
  groupBy: GroupBy;
  search: string;
  traffic: LineTrafficIndex;
  periodLabel: string;
  canOpenEvidence: boolean;
  /** The line whose panel is open, so its row reads as selected. */
  openLine?: string;
}>();
const emit = defineEmits<{
  "update:groupBy": [value: GroupBy];
  "update:search": [value: string];
  open: [group: LineGroup, line: Line];
  evidence: [nodeID: string, lens: EvidenceLens, line?: Line];
}>();

/* Every line, flat and heaviest first; the query filters and orders these. */
const entries = computed(() => lineQueryRows(props.groups, props.traffic));
const query = useListQuery(entries, LINE_QUERY_SCHEMA, computed(() => props.search));
/* The query asks for something: a filter, a bare word or a sort. */
const searching = computed(() => query.filtering.value);
const summary = computed(() => stateSummary(props.groups));
/* The state column exists only when states differ; otherwise the header says it. */
const showState = computed(() => !summary.value.uniform);
const flat = computed(() => searching.value || props.groupBy === "none");
const rows = computed<LineGroupRow[]>(() => (flat.value ? [] : groupLines(props.groups, props.groupBy, props.traffic, props.groups)));
const flatRows = computed<LineEntry[]>(() => (flat.value ? query.rows.value : []));
const totalLines = computed(() => props.groups.reduce((sum, group) => sum + group.lines.length, 0));
const matching = computed(() => query.rows.value.length);
/* While the query does not read, the rows answer an earlier one, so the panel
 * is dimmed and inert and nobody acts on a row for a query they cannot see.
 * Only while it shows rows: when the last query that read kept none, the
 * panel holds the no-match state, and its Clear the query must stay live. */
const stale = computed(() => query.invalid.value && (flat.value ? flatRows.value.length : rows.value.length) > 0);

/* Groups open by default; the operator folds what they are done with. */
const folded = ref(new Set<string>());
function toggle(key: string): void {
  const next = new Set(folded.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  folded.value = next;
}
const allFolded = computed(() => rows.value.length > 0 && rows.value.every((row) => folded.value.has(row.key)));
function foldAll(): void {
  folded.value = allFolded.value ? new Set() : new Set(rows.value.map((row) => row.key));
}

/* A page is 25 groups or 50 flat lines, cut after grouping and search so the
 * header counts the whole set. */
const GROUP_PAGE = 25;
const FLAT_PAGE = 50;
const page = ref(1);
watch(() => [props.search, props.groupBy], () => { page.value = 1; });
const groupPage = computed(() => pageRows(rows.value, page.value, GROUP_PAGE));
const flatPage = computed(() => pageRows(flatRows.value, page.value, FLAT_PAGE));
const pager = computed(() => (flat.value ? flatPage.value : groupPage.value));
const groupFigures = computed(() => new Map(groupPage.value.rows.map((group) => [group.key, groupTraffic(group.agg, props.groupBy)])));

function bytesCell(bytes: number | undefined): string {
  return bytes === undefined ? "unknown" : formatBytes(bytes);
}
function aggUsers(agg: GroupAggregate): string {
  if (!agg.users.unknownLines) return String(agg.users.known);
  return `${agg.users.known} + ${agg.users.unknownLines} unknown`;
}
function aggState(agg: GroupAggregate): string {
  if (agg.uniformState) return `${agg.worst.count} ${agg.worst.label}`;
  return `${agg.worst.count} ${agg.worst.label} of ${agg.lines}`;
}
function ports(agg: GroupAggregate): string {
  if (!agg.ports) return "no port reported";
  return agg.ports.min === agg.ports.max ? `:${agg.ports.min}` : `:${agg.ports.min} to :${agg.ports.max}`;
}
function roleText(entry: LineEntry): string {
  return entry.role === "orphan" ? "no outbound" : entry.role;
}
function targetText(entry: LineEntry): string {
  return entry.target.more > 0 ? `${entry.target.label} +${entry.target.more}` : entry.target.label;
}
function nodeLabel(group: LineGroup): string {
  return group.node_name || group.node_id;
}

/* ── the row menu ────────────────────────────────────────────────────────
 * One shared menu (RowMenu.vue) holds each row's secondary actions. */
const rowMenu = ref<InstanceType<typeof RowMenu>>();

function lineMenu(entry: LineEntry): RowMenuItem[] {
  return [
    { label: "Connections through this line", run: () => emit("evidence", entry.group.node_id, "connections", entry.line) },
    { label: "Raw log for this line", run: () => emit("evidence", entry.group.node_id, "log", entry.line) },
  ];
}
function nodeMenu(nodeID: string): RowMenuItem[] {
  return [
    { label: "Connections on this node", run: () => emit("evidence", nodeID, "connections") },
    { label: "Raw log on this node", run: () => emit("evidence", nodeID, "log") },
  ];
}
function openMenu(event: MouseEvent, key: string, label: string, items: RowMenuItem[]): void {
  void rowMenu.value?.open(event, key, label, items);
}
</script>

<template>
  <!-- Outside the panel: the panel clips its overflow, and the field's menu and help hang below it. -->
  <div class="query-toolbar">
    <PcQueryBar
      :model-value="search"
      :query="query"
      :count="{ shown: matching, total: totalLines }"
      label="Search, filter and sort lines"
      placeholder="Search, or role:exit sort:-traffic"
      storage-key="vpn-core.lines"
      :examples="LINE_QUERY_EXAMPLES"
      @update:model-value="(value: string) => emit('update:search', value)"
    />
  </div>
  <section class="data-panel lines-panel" aria-labelledby="lines-title" :data-stale="stale ? 'true' : undefined" :inert="stale || undefined">
    <header class="panel-header lines-header">
      <div>
        <h2 id="lines-title">Lines</h2>
        <p v-if="totalLines" class="lines-state">
          <template v-if="summary.uniform"><strong>{{ totalLines }} {{ summary.uniform }}</strong></template>
          <template v-else>
            <span v-for="item in summary.counts" :key="item.label" class="status-dot" :data-tone="item.tone">{{ item.count }} {{ item.label }}</span>
          </template>
          <span>{{ summary.uniform ? '· ' : '' }}{{ summary.configErrors }} config {{ summary.configErrors === 1 ? 'error' : 'errors' }}</span>
        </p>
      </div>
      <div class="lines-controls">
        <div class="segmented" role="group" aria-label="Group lines by">
          <span class="segmented-label">Group by</span>
          <button v-for="value in GROUP_BY" :key="value" type="button" class="segmented-option" :aria-pressed="groupBy === value" :disabled="searching" @click="emit('update:groupBy', value)">{{ groupByLabel(value) }}</button>
        </div>
      </div>
    </header>
    <p v-if="searching" class="panel-inline-note" data-tone="neutral">{{ matching }} of {{ totalLines }} lines match, listed flat. Clear the query to group them again.</p>

    <div v-if="flat ? flatRows.length : rows.length" class="table-wrap">
      <table class="lines-table" :data-flat="flat ? 'true' : undefined">
        <thead><tr>
          <th class="sticky-first line-col">
            <button v-if="!flat" class="fold-all" type="button" :aria-pressed="allFolded" @click="foldAll">{{ allFolded ? 'Open all' : 'Fold all' }}</button>
            <span>Line</span>
          </th>
          <th v-if="flat">Node</th>
          <th>Role</th>
          <th>Protocol · port</th>
          <th>Target</th>
          <th class="num">Users</th>
          <th class="num">Traffic, {{ periodLabel }}</th>
          <th v-if="showState">State</th>
          <th v-if="canOpenEvidence" class="menu-cell"><span class="sr-only">Evidence</span></th>
        </tr></thead>

        <template v-if="flat">
          <tbody>
            <tr v-for="entry in flatPage.rows" :key="entry.line.line_hash_id" class="line-row clickable-row" :data-selected="openLine === entry.line.line_hash_id || undefined" @click="emit('open', entry.group, entry.line)">
              <td class="sticky-first line-col">
                <button class="row-open" type="button" :data-line-open="entry.line.line_hash_id" @click.stop="emit('open', entry.group, entry.line)"><strong :title="entry.line.name">{{ entry.line.name }}</strong></button>
                <small class="mono" :title="entry.line.line_hash_id">{{ entry.line.line_hash_id }}</small>
              </td>
              <td><span class="cell-text" :title="nodeLabel(entry.group)">{{ nodeLabel(entry.group) }}</span></td>
              <td><span class="badge" :data-tone="entry.role === 'orphan' ? 'error' : undefined">{{ roleText(entry) }}</span><span v-if="entry.line.managed" class="badge" data-tone="info">managed</span></td>
              <td class="mono">{{ entry.line.type || 'unknown' }} :{{ entry.line.listen_port || '?' }}</td>
              <td :class="{ 'warn-text': entry.target.kind === 'none' }"><span class="cell-text" :title="targetText(entry)">{{ targetText(entry) }}</span><small v-if="entry.target.kind === 'off-fleet'">outside the fleet</small></td>
              <td class="num mono" :title="entry.line.user_known ? undefined : 'The node did not report a user count for this line'">{{ entry.line.user_known ? entry.line.user_count : 'unknown' }}</td>
              <td class="num mono" :data-unknown="entry.bytes === undefined || undefined">{{ bytesCell(entry.bytes) }}</td>
              <td v-if="showState"><span class="status-dot" :data-tone="entry.state.tone" :data-common="entry.state.rank <= 1 || undefined">{{ entry.state.label }}</span></td>
              <td v-if="canOpenEvidence" class="menu-cell">
                <button class="icon-button" type="button" :aria-label="`Evidence for ${entry.line.name}`" :aria-expanded="rowMenu?.openKey === entry.line.line_hash_id" aria-haspopup="menu" @click.stop="openMenu($event, entry.line.line_hash_id, entry.line.name, lineMenu(entry))"><Ellipsis :size="15" aria-hidden="true" /></button>
              </td>
            </tr>
          </tbody>
        </template>

        <template v-else>
          <tbody v-for="group in groupPage.rows" :key="group.key" :data-folded="folded.has(group.key) || undefined">
            <tr class="group-row">
              <td class="sticky-first line-col">
                <button class="node-toggle" type="button" :aria-expanded="!folded.has(group.key)" @click="toggle(group.key)">
                  <ChevronRight class="node-chevron" :size="14" aria-hidden="true" />
                  <strong :title="group.label">{{ group.label }}</strong>
                </button>
                <small v-if="group.sub" :title="group.sub">{{ group.sub }}</small>
              </td>
              <td>{{ roleSummary(group.agg) }}</td>
              <td class="mono"><span class="cell-text">{{ protocolSummary(group.agg) }}</span><small>{{ ports(group.agg) }}</small></td>
              <td>{{ targetSummary(group.agg) }}</td>
              <td class="num mono">{{ aggUsers(group.agg) }}</td>
              <td class="num mono" :data-unknown="groupFigures.get(group.key)?.unknown || undefined">{{ groupFigures.get(group.key)?.figure }}<small v-if="groupFigures.get(group.key)?.note">{{ groupFigures.get(group.key)?.note }}</small></td>
              <td v-if="showState"><span class="status-dot" :data-tone="group.agg.worst.tone">{{ aggState(group.agg) }}</span></td>
              <td v-if="canOpenEvidence" class="menu-cell">
                <button v-if="group.nodeID" class="icon-button" type="button" :aria-label="`Evidence for ${group.label}`" :aria-expanded="rowMenu?.openKey === `group:${group.key}`" aria-haspopup="menu" @click.stop="openMenu($event, `group:${group.key}`, group.label, nodeMenu(group.nodeID))"><Ellipsis :size="15" aria-hidden="true" /></button>
              </td>
            </tr>
            <template v-if="!folded.has(group.key)">
              <tr v-for="entry in group.entries" :key="entry.line.line_hash_id" class="line-row clickable-row" :data-selected="openLine === entry.line.line_hash_id || undefined" @click="emit('open', entry.group, entry.line)">
                <td class="sticky-first line-col">
                  <button class="row-open" type="button" :data-line-open="entry.line.line_hash_id" @click.stop="emit('open', entry.group, entry.line)"><strong :title="entry.line.name">{{ entry.line.name }}</strong></button>
                  <small class="mono" :title="groupBy === 'node' ? entry.line.line_hash_id : nodeLabel(entry.group)">{{ groupBy === 'node' ? entry.line.line_hash_id : nodeLabel(entry.group) }}</small>
                </td>
                <td><span class="badge" :data-tone="entry.role === 'orphan' ? 'error' : undefined">{{ roleText(entry) }}</span><span v-if="entry.line.managed" class="badge" data-tone="info">managed</span></td>
                <td class="mono">{{ entry.line.type || 'unknown' }} :{{ entry.line.listen_port || '?' }}</td>
                <td :class="{ 'warn-text': entry.target.kind === 'none' }"><span class="cell-text" :title="targetText(entry)">{{ targetText(entry) }}</span><small v-if="entry.target.kind === 'off-fleet'">outside the fleet</small></td>
                <td class="num mono" :title="entry.line.user_known ? undefined : 'The node did not report a user count for this line'">{{ entry.line.user_known ? entry.line.user_count : 'unknown' }}</td>
                <td class="num mono" :data-unknown="entry.bytes === undefined || undefined">{{ bytesCell(entry.bytes) }}</td>
                <td v-if="showState"><span class="status-dot" :data-tone="entry.state.tone" :data-common="entry.state.rank <= 1 || undefined">{{ entry.state.label }}</span></td>
                <td v-if="canOpenEvidence" class="menu-cell">
                  <button class="icon-button" type="button" :aria-label="`Evidence for ${entry.line.name}`" :aria-expanded="rowMenu?.openKey === entry.line.line_hash_id" aria-haspopup="menu" @click.stop="openMenu($event, entry.line.line_hash_id, entry.line.name, lineMenu(entry))"><Ellipsis :size="15" aria-hidden="true" /></button>
                </td>
              </tr>
            </template>
          </tbody>
        </template>
      </table>
    </div>
    <div v-else-if="searching" class="empty-state">
      <Radar :size="26" aria-hidden="true" />
      <strong>No line matches this query</strong>
      <p>Nothing in {{ totalLines }} lines across {{ groups.length }} nodes matches <span class="mono">{{ query.active.value.source.trim() }}</span>. A bare word searches node, line name, protocol, host, status, outbound reference and error text; the field's help lists the fields to filter and sort by.</p>
      <div class="empty-actions"><button class="button button-secondary" type="button" @click="emit('update:search', '')">Clear the query</button></div>
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
    <footer v-if="pager.pages > 1" class="table-pagination" aria-label="Lines pagination">
      <span>{{ flat ? 'Lines' : 'Groups' }} {{ pager.from }} to {{ pager.to }} of {{ pager.total }}</span>
      <button class="button button-secondary button-compact" type="button" :disabled="pager.page === 1" @click="page = pager.page - 1">Previous</button>
      <span>Page {{ pager.page }} of {{ pager.pages }}</span>
      <button class="button button-secondary button-compact" type="button" :disabled="pager.page === pager.pages" @click="page = pager.page + 1">Next</button>
    </footer>
  </section>

  <RowMenu ref="rowMenu" noun="Evidence" />
</template>
