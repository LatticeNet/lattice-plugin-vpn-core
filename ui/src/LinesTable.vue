<script setup lang="ts">
/**
 * Lines, L1: every line in one table, grouped by node, bank or exit.
 *
 * A group row carries an aggregate in every member column. A state shared by
 * every line is said once in the header and its column leaves the table; when
 * states differ the column stays and the common one recedes. Searching
 * flattens the table to the matching lines, because the operator asked for
 * lines. Each row has one affordance, opening the line's panel; the evidence
 * links sit in one menu at the end of the row.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { ChevronRight, Ellipsis, Radar } from "@lucide/vue";

import {
  GROUP_BY,
  flatLines,
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
import { filterLineGroups, formatBytes, pageRows, type Line, type LineGroup } from "./vpnModel";

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

const searching = computed(() => props.search.trim().length > 0);
const visible = computed(() => filterLineGroups(props.groups, props.search));
const summary = computed(() => stateSummary(props.groups));
/* The state column exists only when states differ; otherwise the header says it. */
const showState = computed(() => !summary.value.uniform);
const flat = computed(() => searching.value || props.groupBy === "none");
const rows = computed<LineGroupRow[]>(() => (flat.value ? [] : groupLines(visible.value, props.groupBy, props.traffic, props.groups)));
const flatRows = computed<LineEntry[]>(() => (flat.value ? flatLines(visible.value, props.traffic, props.groups) : []));
const totalLines = computed(() => props.groups.reduce((sum, group) => sum + group.lines.length, 0));
const matching = computed(() => visible.value.reduce((sum, group) => sum + group.lines.length, 0));

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
 * Fixed to the window, not inside the table: the table scrolls sideways on a
 * phone, and a menu inside it would be clipped by that scrollport. */
interface MenuItem { label: string; run: () => void }
const menu = ref<{ key: string; x: number; y: number; items: MenuItem[]; label: string }>();
let menuButton: HTMLElement | undefined;
const menuEl = ref<HTMLElement>();

function lineMenu(entry: LineEntry): MenuItem[] {
  return [
    { label: "Connections through this line", run: () => emit("evidence", entry.group.node_id, "connections", entry.line) },
    { label: "Raw log for this line", run: () => emit("evidence", entry.group.node_id, "log", entry.line) },
  ];
}
function nodeMenu(nodeID: string): MenuItem[] {
  return [
    { label: "Connections on this node", run: () => emit("evidence", nodeID, "connections") },
    { label: "Raw log on this node", run: () => emit("evidence", nodeID, "log") },
  ];
}

async function openMenu(event: MouseEvent, key: string, label: string, items: MenuItem[]): Promise<void> {
  if (menu.value?.key === key) {
    closeMenu();
    return;
  }
  menuButton = event.currentTarget as HTMLElement;
  const rect = menuButton.getBoundingClientRect();
  const width = 240;
  const x = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
  const below = rect.bottom + 4;
  const y = below + 96 > window.innerHeight ? Math.max(8, rect.top - 4 - 88) : below;
  menu.value = { key, x, y, items, label };
  await nextTick();
  menuEl.value?.querySelector<HTMLElement>("button")?.focus();
  document.addEventListener("pointerdown", onOutside, true);
  window.addEventListener("scroll", dismissMenu, true);
  window.addEventListener("resize", dismissMenu);
}
function closeMenu(returnFocus = false): void {
  if (!menu.value) return;
  menu.value = undefined;
  document.removeEventListener("pointerdown", onOutside, true);
  window.removeEventListener("scroll", dismissMenu, true);
  window.removeEventListener("resize", dismissMenu);
  if (returnFocus) menuButton?.focus();
}
/* Scrolling or resizing moves the row out from under a fixed menu. */
function dismissMenu(): void {
  closeMenu();
}
function onOutside(event: Event): void {
  if (menuEl.value?.contains(event.target as Node) || menuButton?.contains(event.target as Node)) return;
  closeMenu();
}
function runItem(item: MenuItem): void {
  closeMenu(true);
  item.run();
}
function onMenuKey(event: KeyboardEvent): void {
  const buttons = [...(menuEl.value?.querySelectorAll<HTMLElement>("button") ?? [])];
  const index = buttons.indexOf(document.activeElement as HTMLElement);
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeMenu(true);
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    buttons[(index + 1) % buttons.length]?.focus();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    buttons[(index - 1 + buttons.length) % buttons.length]?.focus();
  } else if (event.key === "Tab") {
    closeMenu();
  }
}
onBeforeUnmount(() => closeMenu());
</script>

<template>
  <section class="data-panel lines-panel" aria-labelledby="lines-title">
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
        <input class="search-input" type="search" :value="search" aria-label="Search lines" placeholder="Search node, line, port or error" @input="emit('update:search', ($event.target as HTMLInputElement).value)" />
      </div>
    </header>
    <p v-if="searching" class="panel-inline-note" data-tone="neutral">{{ matching }} of {{ totalLines }} lines match, listed flat. Clear the search to group them again.</p>

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
                <button class="icon-button" type="button" :aria-label="`Evidence for ${entry.line.name}`" :aria-expanded="menu?.key === entry.line.line_hash_id" aria-haspopup="menu" @click.stop="openMenu($event, entry.line.line_hash_id, entry.line.name, lineMenu(entry))"><Ellipsis :size="15" aria-hidden="true" /></button>
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
                <button v-if="group.nodeID" class="icon-button" type="button" :aria-label="`Evidence for ${group.label}`" :aria-expanded="menu?.key === `group:${group.key}`" aria-haspopup="menu" @click.stop="openMenu($event, `group:${group.key}`, group.label, nodeMenu(group.nodeID))"><Ellipsis :size="15" aria-hidden="true" /></button>
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
                  <button class="icon-button" type="button" :aria-label="`Evidence for ${entry.line.name}`" :aria-expanded="menu?.key === entry.line.line_hash_id" aria-haspopup="menu" @click.stop="openMenu($event, entry.line.line_hash_id, entry.line.name, lineMenu(entry))"><Ellipsis :size="15" aria-hidden="true" /></button>
                </td>
              </tr>
            </template>
          </tbody>
        </template>
      </table>
    </div>
    <div v-else-if="searching" class="empty-state">
      <Radar :size="26" aria-hidden="true" />
      <strong>No line matches that search</strong>
      <p>Nothing in {{ totalLines }} lines across {{ groups.length }} nodes matches <span class="mono">{{ search.trim() }}</span>. The search covers node, line name, protocol, host, status, outbound reference and error text.</p>
      <div class="empty-actions"><button class="button button-secondary" type="button" @click="emit('update:search', '')">Clear the search</button></div>
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

  <div v-if="menu" ref="menuEl" class="row-menu" role="menu" :aria-label="`Evidence for ${menu.label}`" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }" @keydown="onMenuKey">
    <button v-for="item in menu.items" :key="item.label" type="button" role="menuitem" @click="runItem(item)">{{ item.label }}</button>
  </div>
</template>
