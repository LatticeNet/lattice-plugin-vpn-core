<script setup lang="ts">
/**
 * Users, L2: one identity in the side panel, addressed by `?open=<id>`.
 *
 * Identity and state first, then what makes it work: its credentials, the
 * lines it is bound to (chosen through a search, not a 136-option select),
 * and the traffic each node counted for it. Changing it happens here or from
 * the row menu; the page owns the calls and says the outcome in both places.
 * Delete is last.
 */
import { computed, nextTick, ref, watch } from "vue";
import { CircleAlert, KeyRound, LoaderCircle, Pencil, Trash2, X } from "@lucide/vue";

import LinePicker from "./LinePicker.vue";
import { collectorLabel, collectorReports, collectorTone, coverageNote, quotaState, summarizeAllocation } from "./usageModel";
import {
  expiryOf,
  expiryRelative,
  formatDay,
  identityState,
  isBound,
  usedLabel,
  type LineOption,
  type UserOutcome,
} from "./usersModel";
import { formatBytes, type VpnUser } from "./vpnModel";

const props = defineProps<{
  user?: VpnUser;
  /** The id the address asked for, when no identity has it. */
  missingId?: string;
  /** Below 768px the panel is a modal sheet; from 768px it sits beside the table. */
  modal: boolean;
  now: number;
  options: readonly LineOption[];
  /** Why the line list is missing, when it is: then lines cannot be named or chosen. */
  linesError?: string;
  can: { edit: boolean; rotate: boolean; bind: boolean; unbind: boolean; delete: boolean };
  bindBusy: boolean;
  unbindBusy: boolean;
  outcome?: UserOutcome;
  /** Changes when the row menu asks for the bindings, so the panel scrolls there. */
  focusBindings: number;
}>();
const emit = defineEmits<{
  close: [];
  edit: [user: VpnUser];
  rotate: [user: VpnUser, protocol: string];
  bind: [user: VpnUser, hash: string];
  unbind: [user: VpnUser, hash: string];
  delete: [user: VpnUser];
  dismiss: [];
}>();

const panel = ref<HTMLElement>();
const optionByHash = computed(() => new Map(props.options.map((option) => [option.hash, option])));
const boundSet = computed(() => new Set((props.user?.bindings ?? []).map((binding) => binding.line_hash_id)));
const state = computed(() => (props.user ? identityState(props.user, props.now) : undefined));
const expiry = computed(() => (props.user ? expiryOf(props.user, props.now) : { kind: "none" as const }));
const quota = computed(() => quotaState(props.user?.used_period_bytes ?? 0, props.user?.quota_bytes));
const allocation = computed(() => summarizeAllocation(props.user?.allocated_nodes));
const usageSent = computed(() => props.user?.used_period_bytes !== undefined || props.user?.allocated_nodes !== undefined);
const boundCount = computed(() => (props.user?.bindings ?? []).filter((binding) => binding.enabled).length);
const outcomeHere = computed(() => (props.outcome && props.user && props.outcome.userId === props.user.id ? props.outcome : undefined));

function day(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.getUTCFullYear() <= 1 ? "" : formatDay(date);
}

const stateReason = computed(() => {
  const user = props.user;
  if (!user || !state.value) return "";
  switch (state.value.key) {
    case "disabled": return "turned off, so it signs in nowhere";
    case "expired": return `expired ${expiryRelative(expiry.value)}; a Sub-Store subscription built for it fails to render`;
    case "over_quota": return `used ${formatBytes(user.used_period_bytes)} of ${formatBytes(user.quota_bytes)}`;
    case "expiring": return `expires ${expiryRelative(expiry.value)}`;
    case "unbound": return "bound to no line, so it signs in nowhere Lattice manages";
    default: return `bound to ${boundCount.value} ${boundCount.value === 1 ? "line" : "lines"}`;
  }
});

const quotaNote = computed(() => {
  const user = props.user;
  if (!user || !quota.value.hasQuota) return "no limit";
  return user.quota_period === "monthly" ? `monthly, resets on day ${user.quota_reset_day || 1}` : "for the identity's lifetime";
});

const usedNote = computed(() => {
  const user = props.user;
  if (!user || !usageSent.value) return "this server sends no usage per identity";
  if (user.period_start) return `since ${day(user.period_start)}, the quota month`;
  return "over all the days Lattice keeps";
});

function lineLabel(hash: string): { title: string; detail: string; known: boolean } {
  const option = optionByHash.value.get(hash);
  if (!option) return { title: hash, detail: props.linesError ? "line name not read" : "no node reports this line now", known: !!props.linesError };
  return { title: `${option.node} / ${option.name}`, detail: option.detail, known: true };
}

/* The row being removed takes its button with it; focus moves to the section. */
function unbind(user: VpnUser, hash: string): void {
  emit("unbind", user, hash);
  panel.value?.querySelector<HTMLElement>("#user-lines")?.focus();
}

watch(() => props.focusBindings, async (value) => {
  if (!value) return;
  await nextTick();
  const section = panel.value?.querySelector<HTMLElement>("#user-lines");
  section?.scrollIntoView({ block: "start" });
  (section?.querySelector<HTMLElement>("input:not(:disabled)") ?? section)?.focus();
});
</script>

<template>
  <div class="overlay-scrim sheet-scrim" data-overlay="user-detail" @mousedown.self="emit('close')">
    <section ref="panel" tabindex="-1" class="modal sheet" role="dialog" :aria-modal="modal ? 'true' : undefined" aria-labelledby="user-detail-title">
      <header>
        <div>
          <h2 id="user-detail-title">{{ user ? user.email : 'Identity not found' }}</h2>
          <p v-if="user">{{ user.name || 'no display name' }}<template v-if="user.group"> · group {{ user.group }}</template></p>
          <p v-if="user" class="proof-line sheet-proof">
            <span>{{ user.id }}</span>
            <span v-if="user.migrated">· migrated from a proxy user</span>
            <span v-if="day(user.created_at)">· created {{ day(user.created_at) }}</span>
            <span v-if="day(user.updated_at)">· changed {{ day(user.updated_at) }}</span>
          </p>
        </div>
        <div class="sheet-actions">
          <button v-if="user && can.edit" class="button button-secondary button-compact" type="button" @click="emit('edit', user)"><Pencil :size="13" aria-hidden="true" /> Edit</button>
          <button class="icon-button" type="button" aria-label="Close" @click="emit('close')"><X :size="17" /></button>
        </div>
      </header>

      <div v-if="!user" class="detail-body">
        <div class="empty-state">
          <CircleAlert :size="26" aria-hidden="true" />
          <strong>This identity no longer exists</strong>
          <p>No identity has the id <span class="mono">{{ missingId }}</span>. It may have been deleted since the link was made.</p>
          <div class="empty-actions"><button class="button button-secondary" type="button" @click="emit('close')">Back to identities</button></div>
        </div>
      </div>

      <div v-else class="detail-body">
        <div v-if="outcomeHere && outcomeHere.section !== 'lines'" class="outcome-note" :data-tone="outcomeHere.tone" role="status">
          <span>{{ outcomeHere.text }}</span>
          <button v-if="outcomeHere.undo" class="button button-secondary button-compact" type="button" :disabled="bindBusy" @click="outcomeHere.undo()">Undo</button>
          <button class="icon-button" type="button" aria-label="Dismiss" @click="emit('dismiss')"><X :size="14" /></button>
        </div>

        <div class="detail-grid">
          <div><span>State</span><strong><span class="status-dot" :data-tone="state?.tone">{{ state?.label }}</span></strong><small :title="stateReason">{{ stateReason }}</small></div>
          <div>
            <span>Expires</span>
            <strong :class="{ 'warn-text': user.enabled && expiry.kind === 'soon', 'error-text': user.enabled && expiry.kind === 'expired' }">{{ expiry.at ? formatDay(expiry.at) : 'never' }}</strong>
            <small>{{ expiry.at ? (expiry.kind === 'expired' ? `expired ${expiryRelative(expiry)}` : expiryRelative(expiry)) : 'no expiry set' }}</small>
          </div>
          <div>
            <span>Quota</span>
            <strong>{{ quota.hasQuota ? `${quota.percent}% of ${formatBytes(user.quota_bytes)}` : 'none' }}</strong>
            <small>{{ quotaNote }}</small>
          </div>
          <div>
            <span>Used</span>
            <strong class="mono">{{ usedLabel(user, formatBytes) }}</strong>
            <small :title="usedNote">{{ usedNote }}</small>
          </div>
          <div>
            <span>Last seen</span>
            <strong>{{ day(user.last_seen_at) || (usageSent ? 'never' : 'not reported') }}</strong>
            <small>{{ user.last_seen_at ? 'last traffic counted to it' : usageSent ? 'no traffic counted to it' : 'this server sends no usage per identity' }}</small>
          </div>
          <div>
            <span>Lines</span>
            <strong>{{ boundCount || 'none' }}</strong>
            <small>{{ isBound(user) ? `${boundCount === 1 ? 'binding' : 'bindings'} in Lattice` : 'bound to no line' }}</small>
          </div>
        </div>

        <section class="detail-section" aria-labelledby="user-credentials">
          <h3 id="user-credentials">Credentials</h3>
          <p class="field-help">Secrets are write-only. Rotating shows the new one once; the old one keeps working on each line until that line is planned and applied again.</p>
          <div class="binding-list">
            <div v-for="credential in user.credentials" :key="credential.protocol">
              <span class="credential-line">
                <span class="badge credential">{{ credential.protocol }}<KeyRound v-if="credential.has_secret" :size="11" aria-hidden="true" /></span>
                <span v-if="credential.flow" class="mono">{{ credential.flow }}</span>
                <span class="status-dot" :data-tone="credential.has_secret ? 'healthy' : 'warning'">{{ credential.has_secret ? 'secret set' : 'no secret' }}</span>
              </span>
              <button v-if="can.rotate" class="button button-secondary button-compact" type="button" @click="emit('rotate', user, credential.protocol)">Rotate</button>
            </div>
            <p v-if="!user.credentials.length" class="empty-inline">This identity holds no credential, so nothing can sign in with it.</p>
          </div>
        </section>

        <section id="user-lines" class="detail-section" tabindex="-1" aria-labelledby="user-lines-title">
          <h3 id="user-lines-title">Lines</h3>
          <p class="field-help">Binding records the line against this identity in Lattice. The node gets the credential only when that line is planned and applied.</p>
          <!-- A binding's outcome sits where the operator clicked, with its Undo. -->
          <div v-if="outcomeHere && outcomeHere.section === 'lines'" class="outcome-note" :data-tone="outcomeHere.tone" role="status">
            <span>{{ outcomeHere.text }}</span>
            <button v-if="outcomeHere.undo" class="button button-secondary button-compact" type="button" :disabled="bindBusy" @click="outcomeHere.undo()">Undo</button>
            <button class="icon-button" type="button" aria-label="Dismiss" @click="emit('dismiss')"><X :size="14" /></button>
          </div>
          <div class="binding-list">
            <div v-for="binding in user.bindings" :key="binding.line_hash_id">
              <span class="binding-name">
                <strong :title="lineLabel(binding.line_hash_id).title">{{ lineLabel(binding.line_hash_id).title }}</strong>
                <small :class="{ 'warn-text': !lineLabel(binding.line_hash_id).known }">{{ lineLabel(binding.line_hash_id).detail }}<template v-if="!binding.enabled"> · binding disabled</template></small>
              </span>
              <button v-if="can.unbind" class="button button-secondary button-compact destructive" type="button" :disabled="unbindBusy" @click="unbind(user, binding.line_hash_id)">Remove</button>
            </div>
            <p v-if="!user.bindings.length" class="empty-inline">Bound to no line, so its credential signs in nowhere Lattice manages.</p>
          </div>
          <p v-if="linesError" class="field-help warn-text">The line list could not be read ({{ linesError }}), so bound lines show by id and no line can be chosen here. Refresh to try again.</p>
          <LinePicker v-else-if="can.bind" :options="options" :exclude="boundSet" :busy="bindBusy" :label="`Bind a line to ${user.email}`" @pick="(hash) => emit('bind', user!, hash)" />
          <p v-else-if="!can.unbind" class="field-help">This session cannot change bindings.</p>
        </section>

        <section class="detail-section" aria-labelledby="user-usage">
          <h3 id="user-usage">Traffic by node</h3>
          <p v-if="!usageSent" class="field-help">This server did not send usage with the identity list. That is a missing reading, not zero traffic.</p>
          <p v-else-if="!user.allocated_nodes?.length" class="field-help">No node carries a line allocated to this identity, so no node counts traffic for it.</p>
          <template v-else>
            <p v-if="coverageNote(allocation)" class="evidence-warn allocation-note">{{ coverageNote(allocation) }}</p>
            <div class="evidence-grid">
              <div v-for="node in user.allocated_nodes" :key="node.node_id">
                <span>{{ node.node_name || node.node_id }}</span>
                <p><span class="status-dot" :data-tone="collectorTone(node.collector_state)">{{ collectorLabel(node.collector_state) }}</span></p>
                <p v-for="line in node.lines" :key="line.line_hash_id" class="allocation-line">
                  <strong :title="line.tag || line.line_hash_id">{{ line.tag || line.line_hash_id }}</strong>
                  <span class="badge">{{ line.role }}</span>
                  <span class="badge" :data-tone="line.allocation === 'relay' ? 'info' : undefined">{{ line.allocation }}</span>
                  <span class="mono">{{ collectorReports(node.collector_state) ? formatBytes(line.period_uplink + line.period_downlink) : 'unknown' }}</span>
                  <small v-if="line.via_relay">reached through a relay, so it is counted at the entry line</small>
                  <small v-else-if="line.allocation === 'substore' && !line.counted">allocated by a Sub-Store record; inferred, not counted to this identity</small>
                  <small v-else-if="line.estimate">estimated, not a counter this box reported</small>
                  <small v-else-if="!collectorReports(node.collector_state)">this node is not reporting, so its traffic is unknown rather than zero</small>
                </p>
                <p v-if="!node.lines.length" class="evidence-hash">No line on this node is allocated to this identity.</p>
              </div>
            </div>
          </template>
        </section>

        <section v-if="user.comment" class="detail-section"><h3>Comment</h3><p>{{ user.comment }}</p></section>

        <section v-if="can.delete" class="detail-section danger-section" aria-labelledby="user-delete">
          <h3 id="user-delete">Delete</h3>
          <p>Removes the identity and its {{ user.bindings.length }} {{ user.bindings.length === 1 ? 'binding' : 'bindings' }}. Sub-Store subscriptions built for it stop rendering. Nothing is sent to a node.</p>
          <div><button class="button button-secondary destructive" type="button" @click="emit('delete', user)"><Trash2 :size="14" aria-hidden="true" /> Delete identity</button></div>
        </section>
        <p v-if="bindBusy || unbindBusy" class="empty-inline" role="status"><LoaderCircle class="spin" :size="13" aria-hidden="true" /> Saving the binding</p>
      </div>
    </section>
  </div>
</template>
