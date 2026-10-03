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
import { computed, ref, watch } from "vue";
import { CircleAlert, Copy, Eye, EyeOff, LoaderCircle, Pause, Play, QrCode, RefreshCw, RotateCw, Trash2, X } from "@lucide/vue";

import type { IdentityLinkState } from "./identityLink";
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
  if (!value) qrOpen.value = false;
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
  <section class="detail-section link-section" aria-labelledby="user-link-title" data-testid="identity-link">
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
          <p class="field-help">{{ can('link_reveal') ? 'Revealing asks the console for your step-up and is recorded in the audit log. The link stays here for five minutes.' : 'This session cannot reveal links.' }}</p>
        </template>
        <template v-else>
          <div class="link-url">
            <code class="mono" :title="url" data-testid="link-url">{{ maskedUrl(url) }}</code>
            <span class="icon-actions">
              <button class="button button-primary button-compact" type="button" data-testid="link-copy" @click="link.copy(url, 'Link')"><Copy :size="13" aria-hidden="true" /> Copy</button>
              <button class="button button-secondary button-compact" type="button" :aria-pressed="qrOpen" data-testid="link-qr" @click="qrOpen = !qrOpen"><QrCode :size="13" aria-hidden="true" /> {{ qrOpen ? 'Hide QR' : 'QR code' }}</button>
              <button class="icon-button" type="button" aria-label="Hide the link" title="Hide the link" @click="link.forgetReveal()"><EyeOff :size="15" /></button>
            </span>
          </div>
          <figure v-if="qr" class="link-qr" data-testid="link-qr-code">
            <svg :viewBox="`0 0 ${qr.size} ${qr.size}`" role="img" :aria-label="`QR code of the subscription link for ${email}`" shape-rendering="crispEdges">
              <rect :width="qr.size" :height="qr.size" fill="#fff" />
              <path :d="qr.path" fill="#000" />
            </svg>
            <figcaption>Scan it from the client's import screen. It is the same credential as the link.</figcaption>
          </figure>
          <details class="link-clients">
            <summary>Links for a specific client</summary>
            <div>
              <button v-for="client in clients" :key="client.id" class="button button-secondary button-compact" type="button" :title="client.url" @click="link.copy(client.url, `Link for ${client.label}`)">
                <Copy :size="12" aria-hidden="true" /> {{ client.label }}
              </button>
            </div>
            <p v-if="convertNote(status.formats)" class="field-help">{{ convertNote(status.formats) }}</p>
          </details>
          <label class="field link-manual"><span>The link, to copy by hand</span><input :value="url" type="text" readonly spellcheck="false" @focus="($event.target as HTMLInputElement).select()" /></label>
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
          <li v-for="line in status.excluded" :key="line.line_hash_id" class="excluded">
            <span class="link-line-name" :title="lineTitle(line)">{{ lineTitle(line) }}<small>{{ excludedReason(line) }}</small></span>
            <template v-if="linkFix(line)">
              <button
                v-if="linkFix(line)!.action && link.canFix()"
                class="button button-secondary button-compact"
                type="button"
                :disabled="!!busy"
                :title="`File a plan; nothing changes on the node until you approve it`"
                @click="link.fix(line, linkFix(line)!.action!)"
              >{{ linkFix(line)!.label }}</button>
              <small v-else-if="!linkFix(line)!.action" class="link-fix-note">{{ linkFix(line)!.label }}</small>
            </template>
          </li>
        </ul>
      </div>

      <ul v-if="link.plans.value.length" class="link-plans" data-testid="link-plans">
        <li v-for="plan in link.plans.value" :key="plan.approvalId">
          <span>
            <span class="status-dot wrap" :data-tone="plan.state === 'applied' ? 'healthy' : plan.state === 'pending' ? 'warning' : undefined">{{ plan.summary }}</span>
            <small>{{ plan.note || PLAN_STATE[plan.state] }}<template v-if="plan.state === 'pending'"><LoaderCircle class="spin" :size="11" aria-hidden="true" /></template></small>
          </span>
          <button v-if="hostOrigin" class="button button-secondary button-compact" type="button" @click="emit('review', plan.approvalId)">Review in Approvals</button>
          <span v-else class="mono">{{ plan.approvalId }}</span>
        </li>
      </ul>

      <div v-if="link.outcome.value" class="outcome-note" :data-tone="link.outcome.value.tone" role="status" data-testid="link-outcome">
        <span>{{ link.outcome.value.text }}</span>
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
