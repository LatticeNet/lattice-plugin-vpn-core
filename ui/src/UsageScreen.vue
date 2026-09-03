<script setup lang="ts">
/**
 * The Usage screen: the fleet's traffic for one period, and the evidence
 * behind every figure on it.
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
 * An unattributed row here says the traffic is real and the user is unknown,
 * and it carries the candidates the server considered. Node totals count
 * every byte and user totals count only the entry of a chain, so the two
 * disagree by `double_counted_via_chains_bytes`; that figure is stated on the
 * strip and explained in place rather than reconciled away.
 */
import { computed, ref } from "vue";
import { Activity, ChevronRight, Gauge, LoaderCircle, Users, Waypoints } from "@lucide/vue";

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
  USAGE_PERIODS,
  type UsageCollectorRow,
  type UsageLineRow,
  type UsagePeriod,
} from "./usageModel";
import { formatBytes, pageRows, type LineGroup, type VpnUser } from "./vpnModel";

const props = defineProps<{
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
}>();
const emit = defineEmits<{
  period: [value: UsagePeriod];
}>();

const fold = computed(() => foldUsage(props.lines));
const names = computed(() => lineNameIndex(props.groups));
const quotaByUser = computed(() => new Map(props.users.map((user) => [user.id, user.quota_bytes])));
const emailByUser = computed(() => new Map(props.users.map((user) => [user.id, user.email])));
const rangeLabel = computed(() => formatDayRange(props.from, props.to));

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
 * fleet table uses, so the document stays a page rather than a scroll. */
const PAGE_SIZE = 30;
const page = ref(1);
const sortedLines = computed(() =>
  [...props.lines].sort((a, b) => (b.used_bytes || 0) - (a.used_bytes || 0)));
const linePage = computed(() => pageRows(sortedLines.value, page.value, PAGE_SIZE));

function setPeriod(value: string): void {
  page.value = 1;
  openRows.value = new Set();
  emit("period", value as UsagePeriod);
}
</script>

<template>
  <section class="toolbar usage-toolbar">
    <div class="period-picker" role="group" aria-label="Usage period">
      <button
        v-for="value in USAGE_PERIODS"
        :key="value"
        class="period-option"
        type="button"
        :aria-pressed="period === value"
        :disabled="busy"
        @click="setPeriod(value)"
      >{{ periodLabel(value) }}</button>
    </div>
    <p v-if="rangeLabel" class="permission-note">
      <LoaderCircle v-if="busy" class="spin" :size="13" aria-hidden="true" />
      <span v-else>{{ periodLabel(period) }}: {{ rangeLabel }}</span>
    </p>
  </section>

  <section class="summary-strip" aria-label="Usage summary" style="--stat-count: 5">
    <div>
      <span>Fleet traffic</span>
      <strong>{{ failed ? "unknown" : formatBytes(fold.totalBytes) }}</strong>
      <small>every byte reported, chain overlap included</small>
    </div>
    <div>
      <span>Counted to identities</span>
      <strong>{{ failed ? "unknown" : formatBytes(fold.countedBytes) }}</strong>
      <small>{{ failed ? "the read failed" : `${fold.byUser.length} identities, what quota counts` }}</small>
    </div>
    <div :data-tone="fold.unattributedBytes ? 'warning' : undefined">
      <span>Unattributed</span>
      <strong>{{ failed ? "unknown" : formatBytes(fold.unattributedBytes) }}</strong>
      <small>real traffic, owner unknown</small>
    </div>
    <div :data-tone="fold.estimatedBytes ? 'warning' : undefined">
      <span>Estimated</span>
      <strong>{{ failed ? "unknown" : formatBytes(fold.estimatedBytes) }}</strong>
      <small>subtracted, not counted by a box</small>
    </div>
    <div :data-tone="doubleCounted ? 'warning' : undefined">
      <span>Double counted via chains</span>
      <strong>{{ failed ? "unknown" : formatBytes(doubleCounted) }}</strong>
      <small>in node totals, not in user totals</small>
    </div>
  </section>

  <!-- The gap between node totals and user totals, explained where it is
       stated. It is a property of chain accounting, not an error to fix. -->
  <section v-if="doubleCounted > 0" class="data-panel explain-panel" aria-label="Why node and identity totals differ">
    <Waypoints :size="17" aria-hidden="true" />
    <div>
      <strong>{{ formatBytes(doubleCounted) }} is counted twice across the fleet, on purpose.</strong>
      <p>
        Traffic that crosses a chain passes through more than one node, so every node it touches
        reports it. A node total therefore counts these bytes at each hop, while an identity's
        total counts them once, at the entry line. Neither figure is wrong and they are not
        reconciled here: the per-line rows below name the upstream line each relayed row was
        already counted at.
      </p>
    </div>
  </section>

  <section v-if="silentCollectors.length" class="data-panel explain-panel" data-tone="warning" aria-label="Collector coverage">
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

  <div class="split-layout">
    <article class="data-panel">
      <header class="panel-header">
        <div><h2>By identity</h2><p>What this period counts against each account's quota.</p></div>
        <Users :size="17" aria-hidden="true" />
      </header>
      <div v-if="fold.byUser.length" class="table-wrap">
        <table style="min-width: 460px">
          <thead><tr><th>Identity</th><th class="num">Counted</th><th>Quota</th><th class="num">Nodes</th></tr></thead>
          <tbody>
            <tr v-for="user in fold.byUser" :key="user.userID">
              <td>
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
          arrived without an identity the server could place. The per-line table below shows which.
        </p>
      </div>
    </article>

    <article class="data-panel">
      <header class="panel-header">
        <div><h2>By node</h2><p>Every byte a node reported, chain hops included.</p></div>
        <Activity :size="17" aria-hidden="true" />
      </header>
      <div v-if="fold.byNode.length" class="table-wrap">
        <table style="min-width: 460px">
          <thead><tr><th>Node</th><th class="num">Traffic</th><th class="num">Unattributed</th><th>Collector</th></tr></thead>
          <tbody>
            <tr v-for="node in fold.byNode" :key="node.nodeID">
              <td>
                <strong :title="node.nodeName || node.nodeID">{{ node.nodeName || node.nodeID }}</strong>
                <small :title="node.nodeID">{{ node.nodeID }}</small>
              </td>
              <td class="num">
                <span class="mono">{{ formatBytes(node.totalBytes) }}</span>
                <small v-if="node.estimatedBytes" class="cell-note">{{ formatBytes(node.estimatedBytes) }} estimated</small>
              </td>
              <td class="num">
                <span class="mono">{{ node.unattributedBytes ? formatBytes(node.unattributedBytes) : '-' }}</span>
              </td>
              <td>
                <span class="status-dot" :data-tone="collectorTone(collectorStateOf(node.nodeID))">
                  {{ collectorLabel(collectorStateOf(node.nodeID)) }}
                </span>
              </td>
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
    </article>
  </div>

  <section class="data-panel" aria-labelledby="usage-lines-heading">
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
              <td><span class="badge" :title="roleLabel(row.role)" :data-tone="row.role === 'relay' || row.role === 'exit' ? 'info' : undefined">{{ roleLabel(row.role) }}</span></td>
              <td>
                <template v-if="row.user_id">
                  <strong :title="userLabel(row)">{{ userLabel(row) }}</strong>
                  <small :title="row.user_id">{{ row.user_id }}</small>
                </template>
                <span v-else class="status-dot" data-tone="warning">unknown</span>
              </td>
              <td>
                <span class="badge" :title="attributionLabel(row)" :data-tone="attributionTone(row) === 'healthy' ? 'success' : attributionTone(row) === 'error' ? 'error' : attributionTone(row) === 'info' ? 'info' : 'warning'">
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
</template>
