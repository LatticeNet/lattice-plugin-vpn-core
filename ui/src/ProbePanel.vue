<script setup lang="ts">
/**
 * The Probe layer: paste a sing-box outbound, test it from the control plane,
 * and read where it broke or how fast it is.
 *
 * State and calls live in probe.ts. The paste is shown in the textarea and
 * nowhere else: errors name a line, a column and a field, and "Show in
 * editor" selects the fault inside the textarea instead of quoting it. The
 * textarea opts out of spell checking, autocorrect and password managers,
 * some of which send what they read to a server.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Activity, CircleAlert, Clock, KeyRound, ListRestart, LoaderCircle, Minus, Play, RefreshCw, Trash2, X, Check } from "@lucide/vue";

import type { ProbeState } from "./probe";
import {
  formatKB,
  formatMB,
  formatMs,
  formatTook,
  formatUptime,
  MAX_REQUEST_BYTES,
  outboundLabel,
  resultFacts,
  SAMPLES_MAX,
  SAMPLES_MIN,
  stageTrack,
  THROUGHPUT_MAX_BYTES,
  THROUGHPUT_SIZES,
  verdictOf,
  type BuildResult,
} from "./probeModel";
import { revealOffset } from "./textareaCaret";

const props = defineProps<{ probe: ProbeState }>();

/** The editor runs on Ctrl+Enter or Cmd+Enter; the hint names the one this keyboard has. */
const RUN_KEYS = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "Cmd+Enter" : "Ctrl+Enter";

const editor = ref<HTMLTextAreaElement>();
const samplesInput = ref<HTMLInputElement>();
const targetList = ref<HTMLElement>();
const resultPanel = ref<HTMLElement>();
const runButton = ref<HTMLButtonElement>();
const clearButton = ref<HTMLButtonElement>();
const undoButton = ref<HTMLButtonElement>();

const p = props.probe;
const read = computed(() => p.read.value);
const readError = computed(() => (read.value.kind === "error" ? read.value.error : undefined));
const outbounds = computed(() => p.outbounds.value);
const result = computed(() => p.result.value);
const verdict = computed(() => (result.value ? verdictOf(result.value, p.tested.value) : undefined));
const track = computed(() => (result.value ? stageTrack(result.value) : []));
const failure = computed(() => p.failure.value);
const health = computed(() => p.health.value);
const sizeNote = computed(() => (read.value.kind === "empty" ? "" : `${formatKB(read.value.bytes)} of ${formatKB(MAX_REQUEST_BYTES)}`));

/** Why Run would do nothing, said beside it rather than left to a dead button. */
const blocker = computed(() => {
  if (p.unavailable.value) return "The probe is not answering, so tests cannot run.";
  if (p.targetsState.value === "loading" || p.targetsState.value === "idle") return "Reading the probe's targets.";
  if (p.targetsState.value === "error") return "The probe's targets could not be read, so tests cannot run.";
  if (!p.targets.value.length) return "The probe offers no targets, so tests cannot run.";
  return "";
});
const canRun = computed(() => p.ready.value && read.value.kind !== "empty");

const healthTone = computed(() => {
  if (p.healthState.value === "ready") return health.value?.available ? "healthy" : "error";
  return p.healthState.value === "error" ? "warning" : "neutral";
});
const healthLabel = computed(() => {
  if (p.healthState.value === "ready") return health.value?.available ? "Probe ready" : "Probe unavailable";
  if (p.healthState.value === "error") return "Probe health unknown";
  return "Checking the probe";
});
const healthFacts = computed(() => {
  const value = health.value;
  if (!value?.available) return "";
  const parts = [[value.engine, value.coreVersion].filter(Boolean).join(" ")];
  const uptime = formatUptime(value.uptimeS);
  if (uptime) parts.push(`up ${uptime}`);
  if (value.inflight !== undefined && value.maxInflight !== undefined) parts.push(`${value.inflight} of ${value.maxInflight} busy`);
  return parts.filter(Boolean).join(" · ");
});

const FAILURES = {
  rate_limited: { tone: "warning", title: "Rate limited" },
  refused: { tone: "error", title: "The probe refused this request" },
  timeout: { tone: "warning", title: "The console stopped waiting" },
  cancelled: { tone: "info", title: "Cancelled" },
  failed: { tone: "error", title: "The test could not run" },
  denied: { tone: "error", title: "This session cannot run probes" },
} as const;
const failureView = computed(() => (failure.value ? FAILURES[failure.value.kind] : undefined));
/* Run again would send what the server just refused: a policy refusal is
   refused again, and a rate limit holds until the time it named. */
const offerRunAgain = computed(() => !!failure.value && failure.value.kind !== "refused" && failure.value.kind !== "rate_limited");

// ── the running clock ─────────────────────────────────────────────────────
const clock = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;
watch(() => p.running.value, (running) => {
  if (ticker !== undefined) clearInterval(ticker);
  ticker = undefined;
  if (running) {
    clock.value = Date.now();
    ticker = setInterval(() => { clock.value = Date.now(); }, 250);
  } else if (p.phase.value === "done" || p.phase.value === "failed") {
    revealResult();
  }
}, { immediate: true });
onBeforeUnmount(() => {
  if (ticker !== undefined) clearInterval(ticker);
});
const elapsed = computed(() => Math.max(0, Math.floor((clock.value - p.startedAt.value) / 1000)));
const runningLabel = computed(() => (outbounds.value.length ? outboundLabel(outbounds.value, p.test.value) : ""));

/*
 * What a screen reader hears: the start of a run and how it ended, once
 * each. The running clock and the result's figures stay out of it, so the
 * seconds are not read out every second and a table is not read as one
 * sentence.
 */
const announcement = computed(() => {
  if (p.running.value) return `Testing ${runningLabel.value}`;
  if (failure.value && failureView.value) return `${failureView.value.title}. ${failure.value.message}`;
  if (verdict.value) return verdict.value.title;
  return "";
});

/*
 * Stacked below 1100px, the result sits under the form, out of view of the
 * Run that was pressed. When it lands there the page scrolls to it. The
 * frame is the viewport, so this scrolls the frame's document only.
 */
function revealResult(): void {
  const panel = resultPanel.value;
  if (!panel || typeof window === "undefined") return;
  const box = panel.getBoundingClientRect();
  if (box.top >= 0 && box.top < window.innerHeight - 120) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: window.scrollY + box.top - 16, behavior: reduce ? "auto" : "smooth" });
}

// ── pointing at what is wrong ─────────────────────────────────────────────
/** Select the fault inside the textarea, the one place the paste is shown. */
function showFault(): void {
  const el = editor.value;
  const at = readError.value?.at;
  if (!el) return;
  el.focus();
  if (!at) return;
  el.setSelectionRange(at.offset, at.offset + Math.max(1, at.length));
  // From where the fault is drawn, not its line number: a minified paste is one line that wraps.
  revealOffset(el, at.offset);
}

function pointAt(built: BuildResult): void {
  if (built.ok) return;
  if (built.field === "outbound" || built.field === "size") showFault();
  else if (built.field === "targets") targetList.value?.querySelector<HTMLInputElement>("input")?.focus();
  else if (built.field === "samples") samplesInput.value?.focus();
  else if (built.field === "test") document.getElementById("probe-test")?.focus();
}

const runNote = ref("");
async function run(): Promise<void> {
  runNote.value = "";
  if (!canRun.value || p.running.value) return;
  const built = await p.run();
  if (built && !built.ok) {
    const at = built.field === "outbound" ? readError.value?.at : undefined;
    runNote.value = at ? `Line ${at.line}, column ${at.column}: ${built.message}` : built.message;
    pointAt(built);
  }
}
watch(() => p.request.value, () => { runNote.value = ""; });

/*
 * Run and Cancel are one button that changes, so the focus a keyboard put
 * on it stays there: Enter starts a run, Enter again cancels it, and the
 * focus is still on it when the answer lands.
 */
function runOrCancel(): void {
  if (p.running.value) p.cancel();
  else void run();
}

/* Run again leaves with the card it sits in, so the focus moves to the
   button that now says Cancel rather than falling to the page. */
function runAgain(): void {
  runButton.value?.focus();
  void run();
}

/* Clear disables itself, so the focus goes to Undo while it is offered. */
async function clearPaste(): Promise<void> {
  p.clear();
  await nextTick();
  (undoButton.value ?? editor.value)?.focus();
}

async function undoClear(): Promise<void> {
  if (!p.undoClear()) return;
  await nextTick();
  clearButton.value?.focus();
}

function onEditorKey(event: KeyboardEvent): void {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void run();
  }
}

function setTest(event: Event): void {
  p.chosenTest.value = (event.target as HTMLSelectElement).value;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function testedTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const facts = computed(() => (result.value ? resultFacts(result.value, { udp: !!p.tested.value?.udp, throughput: !!p.tested.value?.throughput }) : []));
</script>

<template>
  <section v-if="!p.allowed.value" class="data-panel" data-testid="probe-denied">
    <div class="empty-state">
      <KeyRound :size="26" aria-hidden="true" />
      <strong>This session cannot run probes</strong>
      <p>The Probe layer needs <span class="mono">vpn:probe</span>, which this session's token does not carry. A role or token that grants it opens this layer; the other Lines layers do not need it.</p>
    </div>
  </section>

  <div v-else class="probe-layout">
    <!-- Above both columns, so a phone sees it before the editor rather than under the whole form. -->
    <div v-if="p.unavailable.value" class="explain-panel probe-banner" data-tone="warning" data-testid="probe-unavailable">
      <CircleAlert :size="18" aria-hidden="true" />
      <div>
        <strong>The probe is not running on this control plane</strong>
        <p>{{ health?.reason || "It did not say why." }} Tests stay off until it answers. Platform, System shows its health as well.</p>
      </div>
      <button class="button button-secondary button-compact" type="button" :disabled="p.healthBusy.value" @click="p.refresh()">Check again</button>
    </div>
    <p v-else-if="p.healthState.value === 'error'" class="panel-inline-note probe-note probe-banner" data-testid="probe-health-error"><CircleAlert :size="14" aria-hidden="true" /> {{ p.healthError.value }} A test may still run; its answer says whether the probe is there.</p>

    <section class="data-panel probe-input" aria-labelledby="probe-input-title">
      <header class="panel-header">
        <div>
          <h2 id="probe-input-title">Outbound</h2>
          <p>Paste one sing-box outbound, or an array where one outbound's <span class="mono">detour</span> names another to test a chain. It goes to the probe for this test only and is never stored, logged or put in the address.</p>
        </div>
      </header>

      <div class="probe-editor">
        <label class="sr-only" for="probe-outbound">Outbound JSON</label>
        <textarea
          id="probe-outbound"
          ref="editor"
          v-model="p.draft.value"
          class="probe-textarea"
          data-testid="probe-editor"
          rows="14"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          translate="no"
          data-gramm="false"
          data-gramm_editor="false"
          data-enable-grammarly="false"
          data-1p-ignore="true"
          data-lpignore="true"
          data-bwignore="true"
          data-form-type="other"
          :aria-invalid="read.kind === 'error'"
          aria-describedby="probe-read"
          placeholder='{ "type": "vless", "tag": "exit", "server": "example.com", "server_port": 443, "uuid": "..." }'
          @keydown="onEditorKey"
        />
        <div class="probe-editor-foot">
          <div id="probe-read" class="probe-read" :data-tone="read.kind === 'error' ? 'error' : read.kind === 'ok' ? 'ok' : 'neutral'" data-testid="probe-read">
            <template v-if="readError">
              <CircleAlert :size="14" aria-hidden="true" />
              <span><strong v-if="readError.at">Line {{ readError.at.line }}, column {{ readError.at.column }}:</strong> {{ readError.message }}</span>
              <button v-if="readError.at" class="probe-link" type="button" data-testid="probe-show-fault" @click="showFault">Show in editor</button>
            </template>
            <template v-else-if="read.kind === 'ok'">
              <Check :size="14" aria-hidden="true" />
              <span>{{ outbounds.length === 1 ? "1 outbound reads" : `${outbounds.length} outbounds read` }}<span class="probe-keys">. {{ RUN_KEYS }} runs the test.</span></span>
            </template>
            <template v-else-if="p.undoable.value">
              <span>Cleared.</span>
              <button ref="undoButton" class="probe-link" type="button" data-testid="probe-undo-clear" @click="undoClear">Undo</button>
            </template>
            <span v-else>Paste an outbound to test.</span>
          </div>
          <div class="probe-editor-actions">
            <span v-if="sizeNote" class="probe-size">{{ sizeNote }}</span>
            <button class="button button-secondary button-compact" type="button" :disabled="read.kind !== 'ok'" data-testid="probe-format" @click="p.format()"><ListRestart :size="13" aria-hidden="true" /> Format</button>
            <button ref="clearButton" class="button button-secondary button-compact" type="button" :disabled="!p.draft.value && !result && !failure" data-testid="probe-clear" @click="clearPaste"><Trash2 :size="13" aria-hidden="true" /> Clear</button>
          </div>
        </div>
      </div>

      <ul v-if="read.kind === 'ok'" class="probe-outbounds" aria-label="Outbounds in this paste" data-testid="probe-outbounds">
        <li v-for="item in outbounds" :key="item.tag" :data-tested="item.tag === p.test.value" :data-sent="p.sent.value.has(item.tag)">
          <span class="badge">{{ item.type }}</span>
          <strong class="mono">{{ item.tag }}</strong>
          <span class="mono muted">{{ item.server }}:{{ item.server_port }}</span>
          <small v-if="item.detour">via {{ item.detour }}</small>
          <small v-if="!p.sent.value.has(item.tag)" class="probe-not-sent">not in this test</small>
        </li>
      </ul>

      <div class="probe-options">
        <label v-if="outbounds.length > 1" class="field probe-wide">
          <span>Test</span>
          <select id="probe-test" :value="p.test.value" data-testid="probe-test" @change="setTest">
            <option v-for="item in outbounds" :key="item.tag" :value="item.tag">{{ outboundLabel(outbounds, item.tag) }}</option>
          </select>
          <small class="field-help">The end of a chain is tested by default, so the request passes every hop. Only the tested outbound and the hops it passes through are sent.</small>
        </label>

        <fieldset ref="targetList" class="field probe-wide probe-targets" data-testid="probe-targets">
          <legend>Targets</legend>
          <p v-if="p.targetsState.value === 'loading' && !p.targets.value.length" class="field-help"><LoaderCircle class="spin" :size="12" aria-hidden="true" /> Reading the probe's targets</p>
          <p v-else-if="p.targetsState.value === 'error'" class="field-help error-text">
            {{ p.targetsError.value }}
            <button class="probe-link" type="button" @click="p.refresh()">Try again</button>
          </p>
          <div v-else class="probe-target-list">
            <label v-for="target in p.targets.value" :key="target.id" class="probe-check">
              <input v-model="p.chosenTargets.value" type="checkbox" :value="target.id" />
              <span class="mono">{{ target.id }}</span>
              <small>{{ hostOf(target.url) }}<template v-if="target.expect"> · expects {{ target.expect }}</template></small>
            </label>
          </div>
        </fieldset>

        <label class="field">
          <span>Samples</span>
          <input ref="samplesInput" v-model.number="p.samples.value" type="number" :min="SAMPLES_MIN" :max="SAMPLES_MAX" step="1" inputmode="numeric" data-testid="probe-samples" />
          <small class="field-help">Requests per target, each cold and warm. {{ SAMPLES_MIN }} to {{ SAMPLES_MAX }}.</small>
        </label>

        <div class="probe-switches">
          <label class="probe-switch">
            <input v-model="p.udp.value" type="checkbox" data-testid="probe-udp" />
            <span><strong>UDP</strong><small>A DNS query over UDP through the outbound, when its protocol relays UDP.</small></span>
          </label>
          <label class="probe-switch">
            <input v-model="p.throughput.value" type="checkbox" data-testid="probe-throughput" />
            <span><strong>Throughput</strong><small>A download through the outbound, at most {{ formatMB(THROUGHPUT_MAX_BYTES) }}. Off by default because it spends real traffic.</small></span>
          </label>
          <label v-if="p.throughput.value" class="field probe-size-pick">
            <span>Download</span>
            <select v-model.number="p.throughputBytes.value" data-testid="probe-throughput-bytes">
              <option v-for="size in THROUGHPUT_SIZES" :key="size" :value="size">{{ formatMB(size) }}</option>
            </select>
          </label>
        </div>
      </div>

      <footer class="probe-run">
        <p v-if="runNote" class="probe-run-note error-text" role="alert" data-testid="probe-run-note">{{ runNote }}</p>
        <p v-else-if="p.running.value" class="probe-run-note" data-testid="probe-running-note"><LoaderCircle class="spin" :size="13" aria-hidden="true" /> Testing, {{ elapsed }} s</p>
        <p v-else-if="blocker" class="probe-run-note">{{ blocker }}</p>
        <button
          ref="runButton"
          class="button"
          :class="p.running.value ? 'button-secondary' : 'button-primary'"
          type="button"
          :disabled="!p.running.value && !canRun"
          :data-testid="p.running.value ? 'probe-cancel' : 'probe-run'"
          @click="runOrCancel"
        >
          <X v-if="p.running.value" :size="15" aria-hidden="true" />
          <Play v-else :size="15" aria-hidden="true" />
          {{ p.running.value ? "Cancel" : "Run test" }}
        </button>
      </footer>
    </section>

    <section ref="resultPanel" class="data-panel probe-result" aria-labelledby="probe-result-title" data-testid="probe-result">
      <header class="panel-header">
        <div>
          <h2 id="probe-result-title">Result</h2>
          <p v-if="p.tested.value && result">{{ p.tested.value.label }} · {{ p.tested.value.targets === 1 ? "1 target" : `${p.tested.value.targets} targets` }} · {{ p.tested.value.samples === 1 ? "1 sample" : `${p.tested.value.samples} samples` }}</p>
          <p v-else>Tested from the control plane, so a pass says the line works from there.</p>
        </div>
        <div class="probe-health" data-testid="probe-health">
          <span class="status-dot" :data-tone="healthTone">{{ healthLabel }}</span>
          <button class="icon-button" type="button" aria-label="Check the probe again" title="Check the probe again" :disabled="p.healthBusy.value" @click="p.refresh()">
            <LoaderCircle v-if="p.healthBusy.value" class="spin" :size="14" aria-hidden="true" />
            <RefreshCw v-else :size="14" aria-hidden="true" />
          </button>
          <span v-if="healthFacts" class="mono">{{ healthFacts }}</span>
        </div>
      </header>

      <p class="sr-only" role="status" data-testid="probe-announce">{{ announcement }}</p>

      <div class="probe-result-body">
        <div v-if="p.running.value" class="probe-running" data-testid="probe-running">
          <LoaderCircle class="spin" :size="18" aria-hidden="true" />
          <div>
            <strong>Testing {{ runningLabel }}</strong>
            <p>{{ elapsed }} s. The probe stops by {{ p.deadlineMs.value / 1000 }} s and answers with whatever it measured.</p>
          </div>
        </div>

        <div v-else-if="failure && failureView" class="probe-failure" :data-tone="failureView.tone" :data-kind="failure.kind" data-testid="probe-failure">
          <CircleAlert v-if="failure.kind !== 'cancelled'" :size="17" aria-hidden="true" />
          <X v-else :size="17" aria-hidden="true" />
          <div>
            <strong>{{ failureView.title }}</strong>
            <p>{{ failure.message }}</p>
            <p v-if="failure.kind === 'timeout'" class="muted">The probe may have finished on the server after the console stopped waiting, but that answer cannot be recovered. Running again starts a new test.</p>
          </div>
          <button v-if="offerRunAgain" class="button button-secondary button-compact" type="button" :disabled="!canRun" data-testid="probe-run-again" @click="runAgain">Run again</button>
        </div>

        <template v-else-if="result && verdict">
          <div class="probe-verdict" :data-tone="verdict.tone" data-testid="probe-verdict" :data-stage="result.stage">
            <strong>{{ verdict.title }}</strong>
            <p>{{ verdict.detail }}</p>
            <code v-if="result.error" class="probe-error mono" data-testid="probe-error">{{ result.error }}</code>
          </div>

          <ol class="probe-track" aria-label="What the test got past" data-testid="probe-track">
            <li v-for="step in track" :key="step.key" :data-state="step.state">
              <span class="probe-step-mark" aria-hidden="true">
                <Check v-if="step.state === 'pass'" :size="12" />
                <X v-else-if="step.state === 'fail'" :size="12" />
                <Clock v-else-if="step.state === 'timeout'" :size="12" />
                <Minus v-else-if="step.state === 'partial'" :size="12" />
              </span>
              <strong>{{ step.label }}</strong>
              <small><span class="sr-only">{{ step.state }}: </span>{{ step.note }}</small>
            </li>
          </ol>

          <dl v-if="facts.length" class="probe-facts" data-testid="probe-facts">
            <div v-for="fact in facts" :key="fact.key" :data-fact="fact.key" :data-tone="fact.tone">
              <dt>{{ fact.label }}</dt>
              <dd :class="{ mono: fact.mono, wrap: fact.mono }">{{ fact.value }}</dd>
              <dd v-if="fact.note"><small>{{ fact.note }}</small></dd>
            </div>
          </dl>

          <div v-if="result.targets.length" class="table-wrap">
            <table class="probe-table" data-testid="probe-targets-table">
              <thead>
                <tr>
                  <th rowspan="2" class="sticky-first">Target</th>
                  <th rowspan="2" class="num">Answered</th>
                  <th colspan="3" class="num probe-group">Cold, ms</th>
                  <th colspan="3" class="num probe-group">Warm, ms</th>
                </tr>
                <tr>
                  <th class="num">min</th><th class="num">p50</th><th class="num">p90</th>
                  <th class="num">min</th><th class="num">p50</th><th class="num">p90</th>
                </tr>
              </thead>
              <tbody v-for="target in result.targets" :key="target.id" :data-target="target.id">
                <tr>
                  <td class="sticky-first">
                    <strong class="mono">{{ target.id }}</strong>
                    <small v-if="target.status">HTTP {{ target.status }}</small>
                  </td>
                  <td class="num"><span class="status-dot" :data-tone="target.ok === target.of && target.of > 0 ? 'healthy' : target.ok > 0 ? 'warning' : 'error'">{{ target.ok }} of {{ target.of }}</span></td>
                  <!-- A spread over no answered sample is no figure, so none is drawn. -->
                  <td v-if="target.ok === 0" colspan="6" class="probe-no-sample">no sample answered</td>
                  <template v-else>
                    <td class="num">{{ formatMs(target.cold?.min) }}</td>
                    <td class="num">{{ formatMs(target.cold?.p50) }}</td>
                    <td class="num">{{ formatMs(target.cold?.p90) }}</td>
                    <td class="num">{{ formatMs(target.warm?.min) }}</td>
                    <td class="num">{{ formatMs(target.warm?.p50) }}</td>
                    <td class="num">{{ formatMs(target.warm?.p90) }}</td>
                  </template>
                </tr>
                <tr v-if="target.error" class="probe-target-error">
                  <td colspan="8"><span class="error-text">{{ target.error }}</span></td>
                </tr>
              </tbody>
            </table>
          </div>

          <p class="probe-proof" data-testid="probe-proof">
            <span v-if="p.tested.value">tested {{ testedTime(p.tested.value.at) }}</span>
            <span v-if="result.tookMs !== undefined">· took {{ formatTook(result.tookMs) }}</span>
            <span v-if="result.engine">· {{ result.engine }}</span>
          </p>
        </template>

        <div v-else class="empty-state probe-empty" data-testid="probe-empty">
          <Activity :size="26" aria-hidden="true" />
          <strong>No test yet</strong>
          <p>A test asks four questions in order: does sing-box accept the outbound, does its server answer, does the handshake pass, and do the targets answer through it. Each target is requested on a new connection (cold, handshake included) and again on the same one (warm), as many times as the samples say.</p>
        </div>
      </div>
    </section>
  </div>
</template>
