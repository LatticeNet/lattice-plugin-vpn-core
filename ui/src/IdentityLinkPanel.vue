<script setup lang="ts">
/**
 * The identity's subscription link, in its panel: what a client fetching it
 * gets now and why, which bound lines it serves and which it leaves out with
 * the way back for each, when it was last fetched and by what, and the
 * actions. The link itself is shown only after the console's step-up, as a
 * copyable URL and a QR code the page draws.
 *
 * State and calls live in identityLink.ts; rotate and revoke ask the page,
 * whose confirm dialog sits in its overlay stack, and the page calls them.
 */
import { computed, nextTick, ref, watch } from "vue";
import { CircleAlert, Copy, Eye, EyeOff, LoaderCircle, Pause, Play, QrCode, RefreshCw, RotateCw, Trash2, X } from "@lucide/vue";

import type { IdentityLinkState } from "./identityLink";
import type { FixAction, LinkLine } from "./identityLinkModel";
import {
  clientLinks,
  convertNote,
  excludedReason,
  fetchLine,
  linkAge,
  linkFix,
  linkHeadline,
  linkPathHint,
  lineTitle,
  maskedUrl,
  revealedUrl,
  userinfoText,
} from "./identityLinkModel";
import { qrDrawing } from "./qr";
import { formatDay } from "./usersModel";

const props = defineProps<{
  link: IdentityLinkState;
  email: string;
  now: number;
  hostOrigin: string | null;
}>();
const emit = defineEmits<{
  rotate: [];
  revoke: [];
  review: [approvalId: string];
}>();

const SHOWN_LINES = 6;

const status = computed(() => props.link.status.value);
const headline = computed(() => (status.value ? linkHeadline(status.value) : undefined));
const fetch = computed(() => (status.value ? fetchLine(status.value, props.now) : undefined));
const summary = computed(() => status.value?.link);
const url = computed(() => (props.link.revealed.value ? revealedUrl(props.link.revealed.value, props.hostOrigin) : ""));
const clients = computed(() => (url.value && status.value ? clientLinks(url.value, status.value.formats) : []));
const qrOpen = ref(false);
const qr = computed(() => (qrOpen.value && url.value ? qrDrawing(url.value) : undefined));
const allIncluded = ref(false);
const included = computed(() => {
  const list = status.value?.included ?? [];
  return allIncluded.value ? list : list.slice(0, SHOWN_LINES);
});
const busy = computed(() => props.link.busy.value);
/* An outcome is said beside the control that was pressed (Reveal and Copy,
 * a client's copy button, a left-out line), everything else at the actions.
 * When that control is gone (no link left to reveal), the foot says it. */
const placedOutcome = computed(() => {
  const outcome = props.link.outcome.value;
  if (outcome?.place === "reveal" && summary.value) return outcome;
  if (outcome?.place === "clients" && url.value) return outcome;
  if (outcome?.place === "line" && status.value?.excluded.some((line) => line.line_hash_id === outcome.lineHash)) return outcome;
  return undefined;
});
const lineOutcome = computed(() => (placedOutcome.value?.place === "line" ? placedOutcome.value : undefined));
/* A plan waiting on a left-out line is shown in that line's row; the list
 * under the lines keeps the settled ones and any whose line left the list. */
const footPlans = computed(() => {
  const leftOut = new Set((status.value?.excluded ?? []).map((line) => line.line_hash_id));
  return props.link.plans.value.filter((plan) => plan.state !== "pending" || !leftOut.has(plan.lineHash));
});

const section = ref<HTMLElement>();
function rowOf(lineHash: string): HTMLElement | undefined {
  return [...(section.value?.querySelectorAll<HTMLElement>("li[data-line]") ?? [])].find((row) => row.dataset.line === lineHash);
}

/* Filing replaces the row's button with the plan's state, so focus moves to
 * that state (or back to the button when nothing was filed). */
async function fileFix(line: LinkLine, action: FixAction): Promise<void> {
  await props.link.fix(line, action);
  await nextTick();
  const row = rowOf(line.line_hash_id);
  (row?.querySelector<HTMLElement>('[data-testid="link-pending"]') ?? row?.querySelector<HTMLElement>('[data-testid="link-fix"]'))?.focus();
}
const revealOutcome = computed(() => (placedOutcome.value?.place === "reveal" ? placedOutcome.value : undefined));
const clientsOutcome = computed(() => (placedOutcome.value?.place === "clients" ? placedOutcome.value : undefined));
const footOutcome = computed(() => (placedOutcome.value ? undefined : props.link.outcome.value));

/* The full link is on screen only when asked for, or when the console could
 * not copy it; beside Copy it is cut to its ends, and no title carries it. */
const manualOpen = ref(false);
const manualUrl = ref("");
const manualInput = ref<HTMLInputElement>();
const qrFigure = ref<HTMLElement>();

async function showFullLink(value: string, select = false): Promise<void> {
  manualUrl.value = value;
  manualOpen.value = true;
  await nextTick();
  manualInput.value?.scrollIntoView?.({ block: "nearest" });
  if (select) {
    manualInput.value?.focus();
    manualInput.value?.select();
  }
}

async function copyLink(value: string, what: string, place: "reveal" | "clients"): Promise<void> {
  if (!(await props.link.copy(value, what, place))) await showFullLink(value, true);
}

async function toggleQr(): Promise<void> {
  qrOpen.value = !qrOpen.value;
  if (!qrOpen.value) return;
  await nextTick();
  qrFigure.value?.scrollIntoView?.({ block: "nearest" });
}
/* The line lists describe what the link would carry; only a link answering
 * with servers carries them now. */
const serving = computed(() => status.value?.answer === "nodes");
const can = props.link.can;

// A new identity, or a link that is gone, starts with the QR hidden.
watch(() => props.link.userId.value, () => {
  qrOpen.value = false;
  allIncluded.value = false;
});
watch(url, (value) => {
  if (value) return;
  qrOpen.value = false;
  manualOpen.value = false;
  manualUrl.value = "";
});

function expiryText(at?: string): string {
  if (!at) return "never";
  const when = Date.parse(at);
  return Number.isFinite(when) ? formatDay(new Date(when)) : "never";
}

const PLAN_STATE: Record<string, string> = {
  pending: "waiting for approval and apply",
  applied: "applied, the line now shows it",
  unobservable: "filed; this line cannot show when it applies",
  stopped: "no longer watched",
};
</script>

<template>
  <section ref="section" class="detail-section link-section" aria-labelledby="user-link-title" data-testid="identity-link">
    <h3 id="user-link-title">Subscription link</h3>

    <p v-if="link.load.value === 'loading'" class="empty-inline" role="status"><LoaderCircle class="spin" :size="13" aria-hidden="true" /> Reading the link for {{ email }}</p>

    <p v-else-if="link.load.value === 'denied'" class="field-help" data-testid="link-denied">
      This session cannot read subscription links. They need vpncore:admin with no node restriction, because a link hands out this identity's credential.
    </p>

    <div v-else-if="link.load.value === 'error'" class="alert" role="alert">
      <CircleAlert :size="17" aria-hidden="true" />
      <span><strong>The link status could not be read</strong>{{ link.error.value }}</span>
      <button class="button button-secondary button-compact" type="button" @click="link.refresh()"><RefreshCw :size="13" aria-hidden="true" /> Retry</button>
    </div>

    <template v-else-if="status && headline">
      <div class="link-head">
        <span class="status-dot" :data-tone="headline.tone" data-testid="link-state">{{ headline.title }}</span>
        <p>{{ headline.detail }}</p>
        <p v-if="link.error.value" class="field-help warn-text">Showing the last answer: the refresh failed ({{ link.error.value }}).</p>
      </div>

      <dl v-if="summary" class="link-facts">
        <div><dt>Path</dt><dd class="mono" :title="'The token is shown only after step-up'">{{ linkPathHint(summary) }}</dd></div>
        <div>
          <dt>Last fetch</dt>
          <dd><span class="status-dot wrap" :data-tone="fetch?.tone" :title="fetch?.title" data-testid="link-fetch">{{ fetch?.text }}</span></dd>
        </div>
        <div><dt>Refresh</dt><dd>every {{ summary.update_interval_hours }} h<small v-if="summary.update_interval_hours === 2"> (default)</small></dd></div>
        <div><dt>Issued</dt><dd>{{ linkAge(summary.issued_at, now) || 'unknown' }}<small v-if="summary.rotated_at"> · rotated {{ linkAge(summary.rotated_at, now) }}</small></dd></div>
        <div><dt>Link expires</dt><dd>{{ expiryText(summary.expires_at) }}</dd></div>
        <div v-if="status.subscription_userinfo"><dt>Clients see</dt><dd :title="`Subscription-Userinfo: ${status.subscription_userinfo}`">{{ userinfoText(status.subscription_userinfo, status.answer) }}</dd></div>
      </dl>

      <!-- The link itself: behind the console's step-up, held here a few minutes. -->
      <div v-if="summary" class="link-reveal">
        <template v-if="!url">
          <button v-if="can('link_reveal')" class="button button-secondary button-compact" type="button" :disabled="!!busy" data-testid="link-reveal" @click="link.reveal()">
            <LoaderCircle v-if="busy === 'reveal'" class="spin" :size="13" aria-hidden="true" /><Eye v-else :size="13" aria-hidden="true" />
            {{ busy === 'reveal' ? 'Waiting for step-up in the console' : 'Reveal link' }}
          </button>
          <div v-if="revealOutcome" class="outcome-note" :data-tone="revealOutcome.tone" role="status" data-testid="link-outcome">
            <span>{{ revealOutcome.text }}</span>
            <button class="icon-button" type="button" aria-label="Dismiss" @click="link.dismiss()"><X :size="14" /></button>
          </div>
          <p class="field-help">{{ can('link_reveal') ? 'Revealing asks the console for your step-up and is recorded in the audit log. The link stays here for five minutes.' : 'This session cannot reveal links.' }}</p>
        </template>
        <template v-else>
          <div class="link-url">
            <code class="mono" data-testid="link-url">{{ maskedUrl(url) }}</code>
            <span class="icon-actions">
              <button class="button button-primary button-compact" type="button" data-testid="link-copy" @click="copyLink(url, 'Link', 'reveal')"><Copy :size="13" aria-hidden="true" /> Copy</button>
              <button class="button button-secondary button-compact" type="button" :aria-pressed="qrOpen" data-testid="link-qr" @click="toggleQr"><QrCode :size="13" aria-hidden="true" /> {{ qrOpen ? 'Hide QR' : 'QR code' }}</button>
              <button class="icon-button" type="button" aria-label="Hide the link" title="Hide the link" @click="link.forgetReveal()"><EyeOff :size="15" /></button>
            </span>
          </div>
          <div v-if="revealOutcome" class="outcome-note" :data-tone="revealOutcome.tone" role="status" data-testid="link-outcome">
            <span>{{ revealOutcome.text }}</span>
            <button class="icon-button" type="button" aria-label="Dismiss" @click="link.dismiss()"><X :size="14" /></button>
          </div>
          <figure v-if="qr" ref="qrFigure" class="link-qr" data-testid="link-qr-code">
            <svg :viewBox="`0 0 ${qr.size} ${qr.size}`" role="img" :aria-label="`QR code of the subscription link for ${email}`" shape-rendering="crispEdges">
              <rect :width="qr.size" :height="qr.size" fill="#fff" />
              <path :d="qr.path" fill="#000" />
            </svg>
            <figcaption>Scan it from the client's import screen. It is the same credential as the link.</figcaption>
          </figure>
          <details class="link-clients">
            <summary>Links for a specific client</summary>
            <div>
              <button v-for="client in clients" :key="client.id" class="button button-secondary button-compact" type="button" @click="copyLink(client.url, `Link for ${client.label}`, 'clients')">
                <Copy :size="12" aria-hidden="true" /> {{ client.label }}
              </button>
            </div>
            <div v-if="clientsOutcome" class="outcome-note" :data-tone="clientsOutcome.tone" role="status" data-testid="link-clients-outcome">
              <span>{{ clientsOutcome.text }}</span>
              <button class="icon-button" type="button" aria-label="Dismiss" @click="link.dismiss()"><X :size="14" /></button>
            </div>
            <p v-if="convertNote(status.formats)" class="field-help">{{ convertNote(status.formats) }}</p>
          </details>
          <label v-if="manualOpen" class="field link-manual"><span>The full link, to copy by hand</span><input ref="manualInput" :value="manualUrl" type="text" readonly spellcheck="false" data-testid="link-manual" @focus="($event.target as HTMLInputElement).select()" /></label>
          <button v-else class="link-more" type="button" data-testid="link-show-full" @click="showFullLink(url)">Show the full link</button>
        </template>
      </div>

      <div v-if="status.included.length" class="link-lines">
        <h4>{{ serving ? 'Serves' : 'Would serve' }} {{ status.included.length }} {{ status.included.length === 1 ? 'line' : 'lines' }}<template v-if="!serving"> once it answers with servers again</template></h4>
        <ul>
          <li v-for="line in included" :key="line.line_hash_id">
            <span class="link-line-name" :title="lineTitle(line)">{{ lineTitle(line) }}</span>
            <span v-if="line.protocol" class="badge">{{ line.protocol }}</span>
          </li>
        </ul>
        <button v-if="status.included.length > SHOWN_LINES" class="link-more" type="button" @click="allIncluded = !allIncluded">{{ allIncluded ? 'Show fewer' : `Show all ${status.included.length}` }}</button>
      </div>

      <div v-if="status.excluded.length" class="link-lines" data-testid="link-excluded">
        <h4>{{ serving || status.answer === 'decoy' ? 'Leaves out' : 'Would leave out' }} {{ status.excluded.length }} {{ status.excluded.length === 1 ? 'bound line' : 'bound lines' }}</h4>
        <ul>
          <li v-for="line in status.excluded" :key="line.line_hash_id" class="excluded" :data-line="line.line_hash_id">
            <span class="link-line-name" :title="lineTitle(line)">{{ lineTitle(line) }}<small>{{ excludedReason(line) }}</small></span>
            <span v-if="link.pendingPlan(line.line_hash_id)" class="icon-actions link-row-plan">
              <span class="status-dot wrap" data-tone="warning" tabindex="-1" data-testid="link-pending">Plan filed, waiting for approval <LoaderCircle class="spin" :size="11" aria-hidden="true" /></span>
              <button v-if="hostOrigin" class="button button-secondary button-compact" type="button" @click="emit('review', link.pendingPlan(line.line_hash_id)!.approvalId)">Review in Approvals</button>
            </span>
            <template v-else-if="linkFix(line)">
              <button
                v-if="linkFix(line)!.action && link.canFix()"
                class="button button-secondary button-compact"
                type="button"
                :disabled="!!busy"
                data-testid="link-fix"
                @click="fileFix(line, linkFix(line)!.action!)"
              >{{ linkFix(line)!.label }}</button>
              <small v-else-if="!linkFix(line)!.action" class="link-fix-note">{{ linkFix(line)!.label }}</small>
            </template>
            <div v-if="lineOutcome?.lineHash === line.line_hash_id" class="outcome-note link-row-note" :data-tone="lineOutcome.tone" role="status" data-testid="link-line-outcome">
              <span>{{ lineOutcome.text }}</span>
              <button class="icon-button" type="button" aria-label="Dismiss" @click="link.dismiss()"><X :size="14" /></button>
            </div>
          </li>
        </ul>
      </div>

      <ul v-if="footPlans.length" class="link-plans" data-testid="link-plans">
        <li v-for="plan in footPlans" :key="plan.approvalId">
          <span>
            <span class="status-dot wrap" :data-tone="plan.state === 'applied' ? 'healthy' : plan.state === 'pending' ? 'warning' : undefined">{{ plan.summary }}</span>
            <small>{{ plan.note || PLAN_STATE[plan.state] }}<template v-if="plan.state === 'pending'"><LoaderCircle class="spin" :size="11" aria-hidden="true" /></template></small>
          </span>
          <button v-if="hostOrigin" class="button button-secondary button-compact" type="button" @click="emit('review', plan.approvalId)">Review in Approvals</button>
          <span v-else class="mono">{{ plan.approvalId }}</span>
        </li>
      </ul>

      <div v-if="footOutcome" class="outcome-note" :data-tone="footOutcome.tone" role="status" data-testid="link-outcome">
        <span>{{ footOutcome.text }}</span>
        <button class="icon-button" type="button" aria-label="Dismiss" @click="link.dismiss()"><X :size="14" /></button>
      </div>

      <div class="link-actions">
        <button v-if="!status.issued && can('link_issue')" class="button button-primary button-compact" type="button" :disabled="!!busy" data-testid="link-issue" @click="link.issue()">
          <LoaderCircle v-if="busy === 'issue'" class="spin" :size="13" aria-hidden="true" /> Issue link
        </button>
        <template v-if="summary">
          <button v-if="summary.enabled && can('link_set')" class="button button-secondary button-compact" type="button" :disabled="!!busy" @click="link.setEnabled(false)">
            <LoaderCircle v-if="busy === 'pause'" class="spin" :size="13" aria-hidden="true" /><Pause v-else :size="13" aria-hidden="true" /> Pause link
          </button>
          <button v-else-if="!summary.enabled && can('link_set')" class="button button-secondary button-compact" type="button" :disabled="!!busy" @click="link.setEnabled(true)">
            <LoaderCircle v-if="busy === 'resume'" class="spin" :size="13" aria-hidden="true" /><Play v-else :size="13" aria-hidden="true" /> Resume link
          </button>
          <button v-if="can('link_rotate')" class="button button-secondary button-compact" type="button" :disabled="!!busy" data-testid="link-rotate" @click="emit('rotate')">
            <RotateCw :size="13" aria-hidden="true" /> Rotate link
          </button>
          <button v-if="can('link_revoke')" class="button button-secondary button-compact destructive" type="button" :disabled="!!busy" data-testid="link-revoke" @click="emit('revoke')">
            <Trash2 :size="13" aria-hidden="true" /> Revoke link
          </button>
        </template>
        <p v-if="!status.issued && !can('link_issue')" class="field-help">This session cannot issue links.</p>
      </div>
    </template>
  </section>
</template>
