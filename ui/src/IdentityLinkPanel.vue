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
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { CircleAlert, Copy, Eye, EyeOff, LoaderCircle, Pause, Play, QrCode, RefreshCw, RotateCw, Trash2, X } from "@lucide/vue";

import type { IdentityLinkState } from "./identityLink";
import type { FixAction, LinkLine } from "./identityLinkModel";
import {
  clientLinks,
  convertNote,
  excludedReason,
  fetchLine,
  leftOutHeading,
  linkAge,
  linkFix,
  linkHeadline,
  linkPathHint,
  lineTitle,
  maskedUrl,
  revealedUrl,
  servedHeading,
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
  /** Remove the link's expiry: the page confirms it first. */
  "clear-expiry": [];
  review: [approvalId: string];
}>();


/** How long the live region stays empty before an outcome is read out. */
const ANNOUNCE_DELAY_MS = 60;

const status = computed(() => props.link.status.value);
const headline = computed(() => (status.value ? linkHeadline(status.value) : undefined));
const fetch = computed(() => (status.value ? fetchLine(status.value, props.now) : undefined));
const summary = computed(() => status.value?.link);
const url = computed(() => (props.link.revealed.value ? revealedUrl(props.link.revealed.value, props.hostOrigin) : ""));
const clients = computed(() => (url.value && status.value ? clientLinks(url.value, status.value.formats) : []));
const qrOpen = ref(false);
const qr = computed(() => (qrOpen.value && url.value ? qrDrawing(url.value) : undefined));
/* The served lines are a count until asked for: the Lines section below
 * lists every binding, and the left-out lines, which carry the actions,
 * stay in view. */
const allIncluded = ref(false);
const included = computed(() => (allIncluded.value ? status.value?.included ?? [] : []));
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
const heading = ref<HTMLElement>();
const revealButton = ref<HTMLButtonElement>();
const copyButton = ref<HTMLButtonElement>();
const clientsSummary = ref<HTMLElement>();

/* Every outcome is read out from one live region that is always in the
 * page; the notes on screen are not live themselves, so nothing is said twice
 * and a note inserted with its text is not missed. */
const announcement = ref("");
/* Cleared first and set a moment later, so the same text twice ("Link
 * copied." after a second Copy) is a change a screen reader reads again. */
let announceTimer: ReturnType<typeof setTimeout> | undefined;
watch(() => props.link.outcome.value, (outcome) => {
  if (announceTimer !== undefined) clearTimeout(announceTimer);
  announcement.value = "";
  if (!outcome?.text) return;
  announceTimer = setTimeout(() => {
    announceTimer = undefined;
    announcement.value = outcome.text;
  }, ANNOUNCE_DELAY_MS);
});
onBeforeUnmount(() => {
  if (announceTimer !== undefined) clearTimeout(announceTimer);
});

/*
 * Focus follows the action. An element that is removed or replaced takes
 * focus to <body>, which leaves a keyboard or screen reader user nowhere, so
 * after each change focus goes to the control that now acts on the result.
 * It moves only when focus was lost or is in this section, never away from
 * something the operator is using elsewhere.
 */
function focusIsOurs(): boolean {
  const active = typeof document === "undefined" ? null : document.activeElement;
  return !active || active === document.body || !!section.value?.contains(active);
}
async function focusAfter(target: () => HTMLElement | null | undefined): Promise<void> {
  await nextTick();
  if (!focusIsOurs()) return;
  (target() ?? heading.value)?.focus();
}

async function issueLink(): Promise<void> {
  if (await props.link.issue()) await focusAfter(() => revealButton.value);
}
async function retry(): Promise<void> {
  await props.link.refresh();
  await focusAfter(() => heading.value);
}
function dismiss(target: () => HTMLElement | null | undefined): void {
  props.link.dismiss();
  void focusAfter(target);
}
function rowControl(lineHash: string): HTMLElement | null | undefined {
  const row = rowOf(lineHash);
  return row?.querySelector<HTMLElement>('[data-testid="link-pending"]') ?? row?.querySelector<HTMLElement>('[data-testid="link-fix"]');
}

function rowOf(lineHash: string): HTMLElement | undefined {
  return [...(section.value?.querySelectorAll<HTMLElement>("li[data-line]") ?? [])].find((row) => row.dataset.line === lineHash);
}

/*
 * A left-out row leaves the list when its plan applies (or a read moves it).
 * If focus was in that row it would fall to the document, so it moves to the
 * row that followed (or the one before), or to the heading when none is left.
 * Read before the patch (flush "pre"), while focus is still in the old row.
 */
watch(() => (status.value?.excluded ?? []).map((line) => line.line_hash_id), (now, before) => {
  const active = typeof document === "undefined" ? null : document.activeElement;
  const row = active instanceof HTMLElement ? active.closest<HTMLElement>("li[data-line]") : null;
  const gone = row && section.value?.contains(row) ? row.dataset.line : undefined;
  if (!gone || now.includes(gone)) return;
  const at = (before ?? []).indexOf(gone);
  const after = (before ?? []).slice(at + 1).find((hash) => now.includes(hash));
  const earlier = (before ?? []).slice(0, Math.max(at, 0)).reverse().find((hash) => now.includes(hash));
  const next = after ?? earlier;
  void focusAfter(() => (next ? rowControl(next) : null) ?? heading.value);
}, { flush: "pre" });

/*
 * A plan settles a moment before its row leaves: the row's "Plan filed"
 * state, which had focus, goes first, and the re-read that removes the row
 * comes after. Focus moves to what replaces it in the same row, so the watch
 * above can carry it on when the row itself goes.
 */
watch(() => props.link.plans.value, () => {
  const active = typeof document === "undefined" ? null : document.activeElement;
  if (!(active instanceof HTMLElement) || active.dataset.testid !== "link-pending") return;
  const hash = active.closest<HTMLElement>("li[data-line]")?.dataset.line;
  if (!hash || props.link.pendingPlan(hash)) return;
  void focusAfter(() => rowControl(hash) ?? heading.value);
}, { flush: "pre" });

/* Filing replaces the row's button with the plan's state, so focus moves to
 * that state (or back to the button when nothing was filed). */
async function fileFix(line: LinkLine, action: FixAction): Promise<void> {
  await props.link.fix(line, action);
  await nextTick();
  rowControl(line.line_hash_id)?.focus();
}
const revealOutcome = computed(() => (placedOutcome.value?.place === "reveal" ? placedOutcome.value : undefined));
const clientsOutcome = computed(() => (placedOutcome.value?.place === "clients" ? placedOutcome.value : undefined));
const footOutcome = computed(() => (placedOutcome.value ? undefined : props.link.outcome.value));

/* The full link is on screen only when asked for, or when the console could
 * not copy it; beside Copy it is cut to its ends, and no title carries it.
 * The field's value is derived from the link held now (the bare link, or the
 * client link whose copy was refused), never a copy taken when it opened, so
 * a link replaced while the field is open can never leave the old token in it. */
const manualOpen = ref(false);
const manualClient = ref("");
const manualUrl = computed(() => {
  if (!manualOpen.value || !url.value) return "";
  return (manualClient.value && clients.value.find((client) => client.id === manualClient.value)?.url) || url.value;
});
const manualInput = ref<HTMLInputElement>();
const qrFigure = ref<HTMLElement>();

async function showFullLink(clientId = "", select = false): Promise<void> {
  manualClient.value = clientId;
  manualOpen.value = true;
  await nextTick();
  manualInput.value?.scrollIntoView?.({ block: "nearest" });
  if (select) {
    manualInput.value?.focus();
    manualInput.value?.select();
  }
}

async function copyLink(value: string, what: string, place: "reveal" | "clients", clientId = ""): Promise<void> {
  if (!(await props.link.copy(value, what, place))) await showFullLink(clientId, true);
}

async function toggleQr(): Promise<void> {
  qrOpen.value = !qrOpen.value;
  if (!qrOpen.value) return;
  await nextTick();
  qrFigure.value?.scrollIntoView?.({ block: "nearest" });
}
const can = props.link.can;

// A new identity, or a link that is gone, starts with the QR hidden.
watch(() => props.link.userId.value, () => {
  qrOpen.value = false;
  allIncluded.value = false;
});
watch(url, (value, before) => {
  // Revealed: Copy is what acts on the link now. Gone (Hide, five minutes,
  // a changed link, the page hidden): Reveal brings it back.
  if (value && !before) void focusAfter(() => copyButton.value);
  if (value) return;
  qrOpen.value = false;
  manualOpen.value = false;
  manualClient.value = "";
  if (before) void focusAfter(() => revealButton.value);
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
    <h3 id="user-link-title" ref="heading" tabindex="-1">Subscription link</h3>
    <p class="sr-only" role="status" aria-live="polite" data-testid="link-live">{{ announcement }}</p>

    <p v-if="link.load.value === 'loading'" class="empty-inline" role="status"><LoaderCircle class="spin" :size="13" aria-hidden="true" /> Reading the link for {{ email }}</p>

    <p v-else-if="link.load.value === 'denied'" class="field-help" data-testid="link-denied">
      This session cannot read subscription links. They need vpncore:admin with no node restriction, because a link hands out this identity's credential.
    </p>

    <div v-else-if="link.load.value === 'error'" class="alert" role="alert">
      <CircleAlert :size="17" aria-hidden="true" />
      <span><strong>The link status could not be read</strong>{{ link.error.value }}</span>
      <button class="button button-secondary button-compact" type="button" @click="retry"><RefreshCw :size="13" aria-hidden="true" /> Retry</button>
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
        <div>
          <dt>Link expires</dt>
          <dd>
            {{ expiryText(summary.expires_at) }}
            <button v-if="summary.expires_at && can('link_set')" class="button button-secondary button-compact link-fact-action" type="button" :aria-disabled="busy ? 'true' : undefined" data-testid="link-clear-expiry" @click="busy || emit('clear-expiry')">Remove expiry</button>
          </dd>
        </div>
        <div v-if="status.subscription_userinfo"><dt>Clients see</dt><dd :title="`Subscription-Userinfo: ${status.subscription_userinfo}`">{{ userinfoText(status.subscription_userinfo, status.answer) }}</dd></div>
      </dl>

      <!-- The link itself: behind the console's step-up, held here a few minutes. -->
      <div v-if="summary" class="link-reveal">
        <template v-if="!url">
          <button v-if="can('link_reveal')" ref="revealButton" class="button button-secondary button-compact" type="button" :aria-disabled="busy ? 'true' : undefined" data-testid="link-reveal" @click="link.reveal()">
            <LoaderCircle v-if="busy === 'reveal'" class="spin" :size="13" aria-hidden="true" /><Eye v-else :size="13" aria-hidden="true" />
            {{ busy === 'reveal' ? 'Waiting for step-up in the console' : 'Reveal link' }}
          </button>
          <div v-if="revealOutcome" class="outcome-note" :data-tone="revealOutcome.tone" data-testid="link-outcome">
            <span>{{ revealOutcome.text }}</span>
            <button class="icon-button" type="button" aria-label="Dismiss" @click="dismiss(() => copyButton ?? revealButton)"><X :size="14" /></button>
          </div>
          <p class="field-help">{{ can('link_reveal') ? 'Revealing asks the console for your step-up and is recorded in the audit log. The link stays here for five minutes.' : 'This session cannot reveal links.' }}</p>
        </template>
        <template v-else>
          <div class="link-url">
            <code class="mono" data-testid="link-url">{{ maskedUrl(url) }}</code>
            <span class="icon-actions">
              <button ref="copyButton" class="button button-primary button-compact" type="button" data-testid="link-copy" @click="copyLink(url, 'Link', 'reveal')"><Copy :size="13" aria-hidden="true" /> Copy</button>
              <button class="button button-secondary button-compact" type="button" :aria-pressed="qrOpen" data-testid="link-qr" @click="toggleQr"><QrCode :size="13" aria-hidden="true" /> {{ qrOpen ? 'Hide QR' : 'QR code' }}</button>
              <button class="icon-button" type="button" aria-label="Hide the link" title="Hide the link" @click="link.hide()"><EyeOff :size="15" /></button>
            </span>
          </div>
          <div v-if="revealOutcome" class="outcome-note" :data-tone="revealOutcome.tone" data-testid="link-outcome">
            <span>{{ revealOutcome.text }}</span>
            <button class="icon-button" type="button" aria-label="Dismiss" @click="dismiss(() => copyButton ?? revealButton)"><X :size="14" /></button>
          </div>
          <figure v-if="qr" ref="qrFigure" class="link-qr" data-testid="link-qr-code">
            <svg :viewBox="`0 0 ${qr.size} ${qr.size}`" role="img" :aria-label="`QR code of the subscription link for ${email}`" shape-rendering="crispEdges">
              <rect :width="qr.size" :height="qr.size" fill="#fff" />
              <path :d="qr.path" fill="#000" />
            </svg>
            <figcaption>Scan it from the client's import screen. It is the same credential as the link.</figcaption>
          </figure>
          <details class="link-clients">
            <summary ref="clientsSummary">Links for a specific client</summary>
            <div>
              <button v-for="client in clients" :key="client.id" class="button button-secondary button-compact" type="button" @click="copyLink(client.url, `Link for ${client.label}`, 'clients', client.id)">
                <Copy :size="12" aria-hidden="true" /> {{ client.label }}
              </button>
            </div>
            <div v-if="clientsOutcome" class="outcome-note" :data-tone="clientsOutcome.tone" data-testid="link-clients-outcome">
              <span>{{ clientsOutcome.text }}</span>
              <button class="icon-button" type="button" aria-label="Dismiss" @click="dismiss(() => clientsSummary)"><X :size="14" /></button>
            </div>
            <p v-if="convertNote(status.formats)" class="field-help">{{ convertNote(status.formats) }}</p>
          </details>
          <label v-if="manualOpen" class="field link-manual"><span>The full link, to copy by hand</span><input ref="manualInput" :value="manualUrl" type="text" readonly spellcheck="false" data-testid="link-manual" @focus="($event.target as HTMLInputElement).select()" /></label>
          <button v-else class="link-more" type="button" data-testid="link-show-full" @click="showFullLink('', true)">Show the full link</button>
        </template>
      </div>

      <div v-if="status.included.length" class="link-lines">
        <h4>{{ servedHeading(status) }}</h4>
        <ul v-if="included.length" id="link-served-lines">
          <li v-for="line in included" :key="line.line_hash_id">
            <span class="link-line-name" :title="lineTitle(line)">{{ lineTitle(line) }}</span>
            <span v-if="line.protocol" class="badge">{{ line.protocol }}</span>
          </li>
        </ul>
        <button class="link-more" type="button" :aria-expanded="allIncluded" aria-controls="link-served-lines" data-testid="link-served-toggle" @click="allIncluded = !allIncluded">{{ allIncluded ? 'Hide the lines' : status.included.length === 1 ? 'Show the line' : `Show the ${status.included.length} lines` }}</button>
      </div>

      <div v-if="status.excluded.length" class="link-lines" data-testid="link-excluded">
        <h4>{{ leftOutHeading(status) }}</h4>
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
            <div v-if="lineOutcome?.lineHash === line.line_hash_id" class="outcome-note link-row-note" :data-tone="lineOutcome.tone" data-testid="link-line-outcome">
              <span>{{ lineOutcome.text }}</span>
              <button class="icon-button" type="button" aria-label="Dismiss" @click="dismiss(() => rowControl(line.line_hash_id))"><X :size="14" /></button>
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

      <div v-if="footOutcome" class="outcome-note" :data-tone="footOutcome.tone" data-testid="link-outcome">
        <span>{{ footOutcome.text }}</span>
        <button class="icon-button" type="button" aria-label="Dismiss" @click="dismiss(() => heading)"><X :size="14" /></button>
      </div>

      <div class="link-actions">
        <button v-if="!status.issued && can('link_issue')" class="button button-primary button-compact" type="button" :aria-disabled="busy ? 'true' : undefined" data-testid="link-issue" @click="issueLink">
          <LoaderCircle v-if="busy === 'issue'" class="spin" :size="13" aria-hidden="true" /> Issue link
        </button>
        <template v-if="summary">
          <!-- One button whose label changes, so focus stays on it across Pause and Resume. -->
          <button v-if="can('link_set')" class="button button-secondary button-compact" type="button" :aria-disabled="busy ? 'true' : undefined" data-testid="link-pause" @click="link.setEnabled(!summary.enabled)">
            <LoaderCircle v-if="busy === 'pause' || busy === 'resume'" class="spin" :size="13" aria-hidden="true" /><Pause v-else-if="summary.enabled" :size="13" aria-hidden="true" /><Play v-else :size="13" aria-hidden="true" />
            {{ summary.enabled ? 'Pause link' : 'Resume link' }}
          </button>
          <button v-if="can('link_rotate')" class="button button-secondary button-compact" type="button" :aria-disabled="busy ? 'true' : undefined" data-testid="link-rotate" @click="busy || emit('rotate')">
            <RotateCw :size="13" aria-hidden="true" /> Rotate link
          </button>
          <button v-if="can('link_revoke')" class="button button-secondary button-compact destructive" type="button" :aria-disabled="busy ? 'true' : undefined" data-testid="link-revoke" @click="busy || emit('revoke')">
            <Trash2 :size="13" aria-hidden="true" /> Revoke link
          </button>
        </template>
        <p v-if="!status.issued && !can('link_issue')" class="field-help">This session cannot issue links.</p>
      </div>
    </template>
  </section>
</template>
