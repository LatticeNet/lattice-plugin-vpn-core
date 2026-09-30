<script setup lang="ts">
/**
 * Users, the collection: every identity in one table, the way the Lines
 * table holds lines.
 *
 * Grouping by group or by state puts aggregates in every member column of
 * the group row. A column blank on every identity leaves the table and the
 * header says the fact once; the most common state recedes so the exceptions
 * read first. Searching flattens the table, because the operator asked for
 * identities. Each row has one affordance, opening the identity's panel, and
 * one menu for the rest. The outcome of an action sits under the row it
 * changed, not at the top of a page the operator scrolled away from.
 */
import { computed, ref, watch } from "vue";
import { ChevronRight, Ellipsis, UserRound, X } from "@lucide/vue";

import RowMenu, { type RowMenuItem } from "./RowMenu.vue";
import { quotaState } from "./usageModel";
import {
  USERS_GROUP_BY,
  expiryOf,
  expiryRelative,
  formatDay,
  groupUsers,
  identityState,
  inView,
  isAttributed,
  pageUserTable,
  rowsHoldUser,
  searchUsers,
  sortUsers,
  userColumns,
  usedLabel,
  usersSummary,
  viewSentence,
  type UserAggregate,
  type UserOutcome,
  type UserSort,
  type UserSortKey,
  type UsersGroupBy,
  type UsersView,
} from "./usersModel";
import { formatBytes, type VpnUser } from "./vpnModel";

const props = defineProps<{
  users: VpnUser[];
  now: number;
  view: UsersView;
  search: string;
  groupBy: UsersGroupBy;
  sort: UserSort;
  /** The identity whose panel is open, so its row reads as selected. */
  openUser?: string;
  outcome?: UserOutcome;
  can: { edit: boolean; rotate: boolean; bind: boolean; delete: boolean };
}>();
const emit = defineEmits<{
  "update:view": [value: UsersView];
  "update:search": [value: string];
  "update:groupBy": [value: UsersGroupBy];
  "update:sort": [value: UserSort];
  open: [user: VpnUser];
  edit: [user: VpnUser];
  rotate: [user: VpnUser];
  bindings: [user: VpnUser];
  delete: [user: VpnUser];
  dismiss: [];
}>();

const summary = computed(() => usersSummary(props.users, props.now));
const columns = computed(() => userColumns(props.users, props.now));
/* A column the grouping already states on the group row is not repeated on members. */
const show = computed(() => ({
  ...columns.value.show,
  group: columns.value.show.group && props.groupBy !== "group",
  status: columns.value.show.status && props.groupBy !== "status",
}));
const showMenu = computed(() => Object.values(props.can).some(Boolean));
const span = computed(() => 1 + [show.value.group, show.value.status, show.value.expires, show.value.quota, show.value.lines, show.value.used, showMenu.value].filter(Boolean).length);

/* The most common state recedes, so the exceptions are what the eye finds. */
const commonState = computed(() => [...summary.value.states].sort((a, b) => b.count - a.count)[0]?.key);

const searching = computed(() => props.search.trim().length > 0);
const inScope = computed(() => props.users.filter((user) => inView(user, props.view, props.now)));
const matched = computed(() => searchUsers(inScope.value, props.search));
const sorted = computed(() => sortUsers(matched.value, props.sort, props.now));
const flat = computed(() => searching.value || props.groupBy === "none");
const groups = computed(() => (flat.value ? [] : groupUsers(sorted.value, props.groupBy, props.now)));

/* Groups open by default; the operator folds what they are done with. */
const folded = ref(new Set<string>());
function toggle(key: string): void {
  const next = new Set(folded.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  folded.value = next;
}
const allFolded = computed(() => groups.value.length > 0 && groups.value.every((group) => folded.value.has(group.key)));
function foldAll(): void {
  folded.value = allFolded.value ? new Set() : new Set(groups.value.map((group) => group.key));
}

/* 50 identities a page, grouped or not. */
const PAGE = 50;
const page = ref(1);
watch(() => [props.search, props.groupBy, props.view, props.sort.key, props.sort.reverse], () => { page.value = 1; });
const table = computed(() => pageUserTable(flat.value ? { flat: sorted.value } : { groups: groups.value }, page.value, PAGE, folded.value));

/* A panel opened from a link, or from an attention item, shows its row: turn
 * to the page that holds it, and unfold its group. */
watch(() => props.openUser, (id) => {
  if (!id || rowsHoldUser(table.value.rows, id)) return;
  const holder = groups.value.find((group) => group.users.some((user) => user.id === id));
  if (holder && folded.value.has(holder.key)) toggle(holder.key);
  for (let candidate = 1; candidate <= table.value.pages; candidate += 1) {
    if (rowsHoldUser(pageUserTable(flat.value ? { flat: sorted.value } : { groups: groups.value }, candidate, PAGE, folded.value).rows, id)) {
      page.value = candidate;
      return;
    }
  }
}, { immediate: true });

/* Where the outcome goes: under its anchor row, or over the table when that row is not on this page. */
const outcomeAfter = computed(() => {
  const outcome = props.outcome;
  if (!outcome) return undefined;
  return outcome.anchor && rowsHoldUser(table.value.rows, outcome.anchor) ? outcome.anchor : "";
});

// ── sorting ──────────────────────────────────────────────────────────────
function sortBy(key: UserSortKey): void {
  emit("update:sort", props.sort.key === key ? { key, reverse: !props.sort.reverse } : { key, reverse: false });
}
/* The plugin's sort marks: both ways until chosen, then the direction. */
function mark(key: UserSortKey): string {
  if (props.sort.key !== key) return "\u2195";
  return props.sort.reverse ? "\u2193" : "\u2191";
}
function ariaSort(key: UserSortKey): "ascending" | "descending" | "none" {
  if (props.sort.key !== key) return "none";
  return props.sort.reverse ? "descending" : "ascending";
}

// ── cells ────────────────────────────────────────────────────────────────
function subline(user: VpnUser): string {
  const protocols = (user.credentials ?? []).map((credential) => credential.protocol).join(", ") || "no credential";
  return `${user.name || user.id} · ${protocols}`;
}
function expiryCell(user: VpnUser): { text: string; note: string; tone?: string } {
  const expiry = expiryOf(user, props.now);
  if (!expiry.at) return { text: "never", note: "" };
  const tone = !user.enabled ? undefined : expiry.kind === "expired" ? "error" : expiry.kind === "soon" ? "warning" : undefined;
  return { text: formatDay(expiry.at), note: expiry.kind === "expired" ? `expired ${expiryRelative(expiry)}` : expiryRelative(expiry), tone };
}
function quotaOf(user: VpnUser) {
  return quotaState(user.used_period_bytes ?? 0, user.quota_bytes);
}
function boundLines(user: VpnUser): number {
  return (user.bindings ?? []).filter((binding) => binding.enabled).length;
}
function seen(user: VpnUser): string {
  if (!user.last_seen_at) return "";
  const date = new Date(user.last_seen_at);
  return Number.isNaN(date.getTime()) ? "" : `seen ${formatDay(date)}`;
}

function aggState(agg: UserAggregate): string {
  if (agg.uniformState) return `${agg.worst.count} ${agg.worst.label}`;
  return `${agg.worst.count} ${agg.worst.label} of ${agg.count}`;
}
function aggExpiry(agg: UserAggregate): { text: string; tone?: string } {
  if (agg.expired) return { text: `${agg.expired} expired`, tone: "error" };
  if (agg.expiring) return { text: `${agg.expiring} within 30 days`, tone: "warning" };
  if (agg.nextExpiry) return { text: `next ${formatDay(agg.nextExpiry)}` };
  return { text: "none" };
}
function aggQuota(agg: UserAggregate): string {
  if (!agg.withQuota) return "none";
  return agg.overQuota ? `${agg.withQuota} with a quota, ${agg.overQuota} over` : `${agg.withQuota} with a quota`;
}
function aggLines(agg: UserAggregate): string {
  if (!agg.bindings) return "none";
  return `${agg.bindings} ${agg.bindings === 1 ? "line" : "lines"}`;
}
function aggUsed(agg: UserAggregate): string {
  return agg.attributed ? formatBytes(agg.usedBytes) : "none";
}

// ── the row menu ─────────────────────────────────────────────────────────
const rowMenu = ref<InstanceType<typeof RowMenu>>();
function items(user: VpnUser): RowMenuItem[] {
  const denied = "this session cannot do this";
  return [
    { label: "Edit identity", run: () => emit("edit", user), disabled: !props.can.edit, reason: denied },
    {
      label: "Rotate a credential", run: () => emit("rotate", user),
      disabled: !props.can.rotate || !(user.credentials ?? []).length,
      reason: props.can.rotate ? "this identity holds no credential" : denied,
    },
    { label: "Line bindings", run: () => emit("bindings", user), disabled: !props.can.bind, reason: denied },
    { label: "Delete identity", run: () => emit("delete", user), danger: true, disabled: !props.can.delete, reason: denied },
  ];
}
function openMenu(event: MouseEvent, user: VpnUser): void {
  void rowMenu.value?.open(event, user.id, user.email, items(user));
}

/** The identity listed above this one on the page, "" when it is the first:
 *  where a delete's outcome goes once the row is gone. */
function anchorBefore(id: string): string {
  const rows = table.value.rows;
  const index = rows.findIndex((row) => row.kind === "user" && row.user.id === id);
  for (let at = index - 1; at >= 0; at -= 1) {
    const row = rows[at];
    if (row.kind === "user") return row.user.id;
  }
  return "";
}
defineExpose({ anchorBefore });
</script>

<template>
  <section class="data-panel users-panel" aria-labelledby="users-title">
    <header class="panel-header lines-header">
      <div>
        <h2 id="users-title">Identities</h2>
        <p v-if="users.length" class="lines-state">
          <template v-if="summary.states.length === 1"><strong>{{ summary.states[0].count }} {{ summary.states[0].label }}</strong></template>
          <template v-else>
            <span v-for="state in summary.states" :key="state.key" class="status-dot" :data-tone="state.tone" :data-common="state.key === commonState || undefined">{{ state.count }} {{ state.label }}</span>
          </template>
        </p>
        <p v-if="columns.notes.length" class="users-notes">{{ columns.notes.join(' · ') }}</p>
      </div>
      <div v-if="users.length" class="lines-controls">
        <div class="segmented" role="group" aria-label="Group identities by">
          <span class="segmented-label">Group by</span>
          <button v-for="value in USERS_GROUP_BY" :key="value" type="button" class="segmented-option" :aria-pressed="groupBy === value" :disabled="searching" @click="emit('update:groupBy', value)">{{ value }}</button>
        </div>
        <input class="search-input" type="search" :value="search" aria-label="Search identities" placeholder="Search email, name or group" @input="emit('update:search', ($event.target as HTMLInputElement).value)" />
      </div>
    </header>
    <p v-if="view !== 'all'" class="panel-inline-note" data-tone="neutral">
      <span>{{ viewSentence(view, inScope.length) }} Only they are listed.</span>
      <button class="button button-secondary button-compact" type="button" @click="emit('update:view', 'all')">Show all {{ users.length }}</button>
    </p>
    <p v-if="searching && matched.length" class="panel-inline-note" data-tone="neutral">{{ matched.length }} of {{ inScope.length }} identities match, listed flat. Clear the search to group them again.</p>

    <div v-if="outcome && outcomeAfter === ''" class="outcome-note" :data-tone="outcome.tone" role="status">
      <span>{{ outcome.text }}</span>
      <button class="icon-button" type="button" aria-label="Dismiss" @click="emit('dismiss')"><X :size="14" /></button>
    </div>

    <div v-if="table.rows.length" class="table-wrap">
      <table class="lines-table users-table" :data-flat="flat ? 'true' : undefined">
        <thead><tr>
          <th class="sticky-first line-col" :aria-sort="ariaSort('identity')">
            <button v-if="!flat" class="fold-all" type="button" :aria-pressed="allFolded" @click="foldAll">{{ allFolded ? 'Open all' : 'Fold all' }}</button>
            <button class="sort-button" type="button" @click="sortBy('identity')">Identity <span class="sort-mark" aria-hidden="true">{{ mark('identity') }}</span></button>
          </th>
          <th v-if="show.group" :aria-sort="ariaSort('group')"><button class="sort-button" type="button" @click="sortBy('group')">Group <span class="sort-mark" aria-hidden="true">{{ mark('group') }}</span></button></th>
          <th v-if="show.status" :aria-sort="ariaSort('status')"><button class="sort-button" type="button" @click="sortBy('status')">Status <span class="sort-mark" aria-hidden="true">{{ mark('status') }}</span></button></th>
          <th v-if="show.expires" :aria-sort="ariaSort('expires')"><button class="sort-button" type="button" @click="sortBy('expires')">Expires <span class="sort-mark" aria-hidden="true">{{ mark('expires') }}</span></button></th>
          <th v-if="show.quota" :aria-sort="ariaSort('quota')"><button class="sort-button" type="button" @click="sortBy('quota')">Quota <span class="sort-mark" aria-hidden="true">{{ mark('quota') }}</span></button></th>
          <th v-if="show.lines" class="num" :aria-sort="ariaSort('lines')"><button class="sort-button" type="button" @click="sortBy('lines')">Lines <span class="sort-mark" aria-hidden="true">{{ mark('lines') }}</span></button></th>
          <th v-if="show.used" class="num" :aria-sort="ariaSort('used')"><button class="sort-button" type="button" @click="sortBy('used')">Used <span class="sort-mark" aria-hidden="true">{{ mark('used') }}</span></button></th>
          <th v-if="showMenu" class="menu-cell"><span class="sr-only">Actions</span></th>
        </tr></thead>
        <tbody>
          <template v-for="row in table.rows" :key="row.kind === 'group' ? `g:${row.group.key}:${row.continued}` : row.user.id">
            <tr v-if="row.kind === 'group'" class="group-row">
              <td class="sticky-first line-col">
                <button class="node-toggle" type="button" :aria-expanded="!folded.has(row.group.key)" @click="toggle(row.group.key)">
                  <ChevronRight class="node-chevron" :size="14" aria-hidden="true" />
                  <strong :title="row.group.label">{{ row.group.label }}</strong>
                </button>
                <small>{{ row.group.agg.count }} {{ row.group.agg.count === 1 ? 'identity' : 'identities' }} · {{ row.group.agg.enabled }} enabled<template v-if="row.continued"> · continued</template></small>
              </td>
              <td v-if="show.group">{{ row.group.agg.groups }} {{ row.group.agg.groups === 1 ? 'group' : 'groups' }}</td>
              <td v-if="show.status"><span class="status-dot" :data-tone="row.group.agg.worst.tone">{{ aggState(row.group.agg) }}</span></td>
              <td v-if="show.expires" :class="{ 'warn-text': aggExpiry(row.group.agg).tone === 'warning', 'error-text': aggExpiry(row.group.agg).tone === 'error' }">{{ aggExpiry(row.group.agg).text }}</td>
              <td v-if="show.quota">{{ aggQuota(row.group.agg) }}</td>
              <td v-if="show.lines" class="num">{{ aggLines(row.group.agg) }}</td>
              <td v-if="show.used" class="num mono" :data-unknown="!row.group.agg.attributed || undefined">{{ aggUsed(row.group.agg) }}<small v-if="row.group.agg.attributed">{{ row.group.agg.attributed }} counted</small></td>
              <td v-if="showMenu" class="menu-cell" />
            </tr>
            <template v-else>
              <tr class="line-row clickable-row" :data-selected="openUser === row.user.id || undefined" @click="emit('open', row.user)">
                <td class="sticky-first line-col">
                  <button class="row-open" type="button" :data-user-open="row.user.id" @click.stop="emit('open', row.user)"><strong :title="row.user.email">{{ row.user.email }}</strong></button>
                  <small :title="subline(row.user)">{{ subline(row.user) }}</small>
                </td>
                <td v-if="show.group"><span class="cell-text" :title="row.user.group || undefined" :data-unknown="!row.user.group || undefined">{{ row.user.group || 'none' }}</span></td>
                <td v-if="show.status"><span class="status-dot" :data-tone="identityState(row.user, now).tone" :data-common="identityState(row.user, now).key === commonState || undefined">{{ identityState(row.user, now).label }}</span></td>
                <td v-if="show.expires" :data-unknown="!expiryOf(row.user, now).at || undefined">
                  <span :class="{ 'warn-text': expiryCell(row.user).tone === 'warning', 'error-text': expiryCell(row.user).tone === 'error' }">{{ expiryCell(row.user).text }}</span>
                  <small v-if="expiryCell(row.user).note">{{ expiryCell(row.user).note }}</small>
                </td>
                <td v-if="show.quota">
                  <div v-if="quotaOf(row.user).hasQuota" class="quota-meter" :data-tone="quotaOf(row.user).tone">
                    <div class="quota-bar" aria-hidden="true"><span :style="{ width: `${quotaOf(row.user).percent}%` }" /></div>
                    <small>{{ quotaOf(row.user).percent }}% of {{ formatBytes(row.user.quota_bytes) }}<span v-if="row.user.quota_period === 'monthly'"> / monthly</span></small>
                  </div>
                  <span v-else data-unknown="true">none</span>
                </td>
                <td v-if="show.lines" class="num mono" :data-unknown="!boundLines(row.user) || undefined">{{ boundLines(row.user) || 'none' }}</td>
                <td v-if="show.used" class="num mono" :data-unknown="!isAttributed(row.user) || undefined">
                  {{ isAttributed(row.user) ? usedLabel(row.user, formatBytes) : 'none' }}
                  <small v-if="seen(row.user)">{{ seen(row.user) }}</small>
                </td>
                <td v-if="showMenu" class="menu-cell">
                  <button class="icon-button" type="button" :aria-label="`Actions for ${row.user.email}`" :aria-expanded="rowMenu?.openKey === row.user.id" aria-haspopup="menu" @click.stop="openMenu($event, row.user)"><Ellipsis :size="15" aria-hidden="true" /></button>
                </td>
              </tr>
              <tr v-if="outcome && outcomeAfter === row.user.id" class="outcome-row">
                <td :colspan="span">
                  <div class="outcome-note" :data-tone="outcome.tone" role="status">
                    <span>{{ outcome.text }}</span>
                    <button class="icon-button" type="button" aria-label="Dismiss" @click="emit('dismiss')"><X :size="14" /></button>
                  </div>
                </td>
              </tr>
            </template>
          </template>
        </tbody>
      </table>
    </div>
    <div v-else-if="searching" class="empty-state">
      <UserRound :size="26" aria-hidden="true" />
      <strong>No identity matches that search</strong>
      <p>Nothing in {{ inScope.length }} identities matches <span class="mono">{{ search.trim() }}</span>. The search covers email, name, group, comment, protocol and id.</p>
      <div class="empty-actions"><button class="button button-secondary" type="button" @click="emit('update:search', '')">Clear the search</button></div>
    </div>
    <div v-else-if="view !== 'all'" class="empty-state">
      <UserRound :size="26" aria-hidden="true" />
      <strong>Nothing left in this view</strong>
      <p>{{ viewSentence(view, 0) }}</p>
      <div class="empty-actions"><button class="button button-secondary" type="button" @click="emit('update:view', 'all')">Show all {{ users.length }}</button></div>
    </div>
    <slot v-else name="empty" />
    <footer v-if="table.pages > 1" class="table-pagination" aria-label="Identities pagination">
      <span v-if="table.from">Identities {{ table.from }} to {{ table.to }} of {{ table.total }}</span>
      <button class="button button-secondary button-compact" type="button" :disabled="table.page === 1" @click="page = table.page - 1">Previous</button>
      <span>Page {{ table.page }} of {{ table.pages }}</span>
      <button class="button button-secondary button-compact" type="button" :disabled="table.page === table.pages" @click="page = table.page + 1">Next</button>
    </footer>
  </section>

  <RowMenu ref="rowMenu" />
</template>
