<script setup lang="ts">
/**
 * The Probe layer's Targets field: the probe's built-in targets and the
 * operator's saved ones in one list to pick from, and for a session that may
 * change the saved list, a form to add a target under the list or to edit
 * one under its own row.
 *
 * A saved target is a URL the server keeps and sends to the probe by id; the
 * probe checks it again before every run. The form's checks are the probe's
 * rules said beside the field (probeTargetForm.ts), so a bad URL is fixed
 * while it is typed. A server without saved targets (older than this page)
 * answers no `custom`, and the list is then the built-in targets alone.
 *
 * The form is one instance teleported to where it belongs, so a draft
 * survives the list changing under it: a reload after someone else's save
 * rebases the draft onto their version and keeps only the fields this
 * operator changed, and a target deleted elsewhere can still be saved as new.
 */
import { computed, nextTick, ref, watch } from "vue";
import { LoaderCircle, Pencil, Plus, Trash2 } from "@lucide/vue";

import type { ProbeState } from "./probe";
import { MAX_TARGETS_PER_RUN, type ProbeTarget } from "./probeModel";
import { checkTargetDraft, draftFrom, emptyDraft, type DraftField, type TargetDraft } from "./probeTargetForm";

const props = defineProps<{ probe: ProbeState }>();
const p = props.probe;

/** Above this many saved targets the list folds to the first few and the chosen ones. */
const FOLD_OVER = 8;
const FOLDED_SHOWN = 6;
const FIELD_NAMES: Record<DraftField, string> = { label: "name", url: "URL", method: "method", expectStatus: "passing statuses", bodyContains: "body text" };

const builtin = computed(() => p.targets.value.filter((target) => target.source === "builtin"));
const saved = computed(() => p.targets.value.filter((target) => target.source === "custom"));
const custom = computed(() => p.custom.value);
const savedRun = computed(() => !!custom.value?.supported);
const full = computed(() => !!custom.value && p.customCount.value >= custom.value.limit);
/** The saved section is shown when there is something to show or something this session may add. */
const showSaved = computed(() => !!custom.value && (saved.value.length > 0 || p.canEditTargets.value));
const chosenCount = computed(() => p.chosenTargets.value.length);

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** What a target checks, as short parts that never break inside themselves. */
function facts(target: ProbeTarget): string[] {
  const parts = [hostOf(target.url)];
  if (target.method === "HEAD") parts.push("HEAD");
  if (target.expectStatus) parts.push(`expects ${target.expectStatus}`);
  if (target.bodyContains) parts.push("checks text");
  return parts;
}

// ── folding a long list ───────────────────────────────────────────────────
const expanded = ref(false);
const folds = computed(() => saved.value.length > FOLD_OVER);
const visibleSaved = computed(() => {
  if (!folds.value || expanded.value) return saved.value;
  const chosen = new Set(p.chosenTargets.value);
  return saved.value.filter((target, index) => index < FOLDED_SHOWN || chosen.has(target.id) || editing.value === target.id || confirming.value === target.id);
});
const hiddenCount = computed(() => saved.value.length - visibleSaved.value.length);

// ── the form ──────────────────────────────────────────────────────────────
/** Open for a new target ("new"), for a saved one (its id), or closed. */
const editing = ref<string>();
/** The saved target the draft is based on: its version is what a save names. */
const baseline = ref<ProbeTarget>();
const draft = ref<TargetDraft>(emptyDraft());
const touched = ref(new Set<DraftField>());
const tried = ref(false);
const saveError = ref<{ message: string; stale: boolean }>();
/** Said at the top of the form after a reload rebased the draft. */
const notice = ref("");

const check = computed(() => checkTargetDraft(draft.value));
/** Field problems, shown once Save was pressed or the field was left, not while it is first typed. */
const shownErrors = computed(() => {
  const out: Partial<Record<DraftField, string>> = {};
  if (check.value.ok) return out;
  for (const [field, message] of Object.entries(check.value.errors) as Array<[DraftField, string]>) {
    if (tried.value || touched.value.has(field)) out[field] = message;
  }
  return out;
});

/** Editing a saved target that is no longer in the list: someone deleted it. */
const gone = computed(() => !!editing.value && editing.value !== "new" && !saved.value.some((target) => target.id === editing.value));
const formTitle = computed(() => {
  if (editing.value === "new") return "Add a target";
  return `Edit ${baseline.value?.label ?? "target"}`;
});
/** Where the one form instance is drawn: under its row while that row is listed, else under the list. */
const formSlot = computed(() => (editing.value && editing.value !== "new" && !gone.value ? `#probe-target-slot-${editing.value}` : "#probe-target-slot-new"));
const busy = computed(() => p.editBusy.value);

const addButton = ref<HTMLButtonElement>();
const nameInput = ref<HTMLInputElement>();
const listRoot = ref<HTMLElement>();
const announce = ref("");

const inRow = (id: string, selector: string) => listRoot.value?.querySelector<HTMLElement>(`[data-target="${id}"] ${selector}`) ?? undefined;
/** Something to hold the focus when the element that had it went away. */
function fallbackFocus(): void {
  const first = listRoot.value?.querySelector<HTMLElement>(".probe-saved input:not(:disabled), .probe-target-list input:not(:disabled)");
  (addButton.value && !addButton.value.disabled ? addButton.value : first)?.focus();
}

async function openForm(target?: ProbeTarget): Promise<void> {
  if (busy.value) return;
  confirming.value = undefined;
  editing.value = target ? target.id : "new";
  baseline.value = target;
  draft.value = target ? draftFrom(target) : emptyDraft();
  touched.value = new Set();
  tried.value = false;
  saveError.value = undefined;
  notice.value = "";
  await nextTick();
  await nextTick();
  nameInput.value?.focus();
}

/** Close the form; the focus goes to the target it was about, or to Add target. */
async function closeForm(focusId?: string, focus: "edit" | "pick" = "edit"): Promise<void> {
  if (busy.value) return;
  const was = editing.value;
  editing.value = undefined;
  baseline.value = undefined;
  saveError.value = undefined;
  notice.value = "";
  await nextTick();
  const id = focusId ?? (was && was !== "new" ? was : undefined);
  const target = id ? inRow(id, focus === "pick" ? "input" : '[data-testid="probe-target-edit"]') ?? inRow(id, "input") : undefined;
  if (target) target.focus();
  else fallbackFocus();
}

function leave(field: DraftField): void {
  touched.value = new Set(touched.value).add(field);
}

async function submit(): Promise<void> {
  if (busy.value) return;
  tried.value = true;
  saveError.value = undefined;
  const result = check.value;
  if (!result.ok) {
    await nextTick();
    listRoot.value?.querySelector<HTMLElement>('.probe-target-form [aria-invalid="true"]')?.focus();
    return;
  }
  const opened = editing.value;
  const existing = gone.value ? undefined : baseline.value;
  const outcome = await p.saveTarget(result.input, existing);
  if (editing.value !== opened) return;
  if (!outcome.ok) {
    saveError.value = { message: sentence(outcome.message), stale: outcome.stale };
    return;
  }
  announce.value = existing ? `Saved ${outcome.target.label}.` : `Added ${outcome.target.label}.`;
  await closeForm(outcome.target.id, existing ? "edit" : "pick");
}

function onFormKey(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  event.preventDefault();
  if (!busy.value) void closeForm();
}

// The URL starts as "https://", so a pasted URL would repeat the scheme; the second one wins.
watch(() => draft.value.url, (url) => {
  const repeated = /^https:\/\/(https?:\/\/)/i.exec(url);
  if (repeated) draft.value.url = url.slice("https://".length);
});
// What the server said is about what was sent; an edit makes it stale, except the advice to reload.
watch(draft, () => {
  if (saveError.value && !saveError.value.stale) saveError.value = undefined;
}, { deep: true });

/**
 * Read the list again after the server said it moved. While a saved target
 * is being edited, the draft is rebased onto the version now stored: the
 * fields this operator changed stay as typed, the others take the new values.
 */
async function reload(from?: string): Promise<void> {
  saveError.value = undefined;
  deleteError.value = undefined;
  await p.reloadTargets();
  await nextTick();
  if (editing.value && editing.value !== "new") {
    const fresh = saved.value.find((target) => target.id === editing.value);
    if (fresh && baseline.value && fresh.version !== baseline.value.version) {
      const before = draftFrom(baseline.value);
      const mine = draft.value;
      const changed = (Object.keys(before) as DraftField[]).filter((field) => mine[field] !== before[field]);
      draft.value = { ...draftFrom(fresh), ...Object.fromEntries(changed.map((field) => [field, mine[field]])) };
      baseline.value = fresh;
      notice.value = changed.length
        ? `Someone saved a newer version. It is loaded with your ${changed.map((field) => FIELD_NAMES[field]).join(", ")} kept; check it and save again.`
        : "Someone saved a newer version. It is loaded; check it and save again.";
    } else if (fresh && baseline.value) {
      baseline.value = fresh;
    }
    await nextTick();
    nameInput.value?.focus();
    return;
  }
  const target = from ? inRow(from, '[data-testid="probe-target-delete"]') ?? inRow(from, "input") : undefined;
  if (target) target.focus();
  else fallbackFocus();
}

// ── delete ────────────────────────────────────────────────────────────────
const confirming = ref<string>();
const deleteError = ref<{ id: string; message: string; stale: boolean }>();

async function askDelete(target: ProbeTarget): Promise<void> {
  if (busy.value) return;
  confirming.value = target.id;
  deleteError.value = undefined;
  await nextTick();
  inRow(target.id, "[data-keep]")?.focus();
}

async function keep(target: ProbeTarget): Promise<void> {
  if (busy.value) return;
  confirming.value = undefined;
  await nextTick();
  inRow(target.id, '[data-testid="probe-target-delete"]')?.focus();
}

function onConfirmKey(event: KeyboardEvent, target: ProbeTarget): void {
  if (event.key !== "Escape") return;
  event.preventDefault();
  void keep(target);
}

async function confirmDelete(target: ProbeTarget): Promise<void> {
  const index = saved.value.findIndex((item) => item.id === target.id);
  const outcome = await p.deleteTarget(target);
  confirming.value = undefined;
  if (!outcome.ok) {
    deleteError.value = { id: target.id, message: sentence(outcome.message), stale: outcome.stale };
    await nextTick();
    inRow(target.id, '[data-testid="probe-target-delete"]')?.focus();
    return;
  }
  announce.value = `Deleted ${target.label}.`;
  if (editing.value === target.id) {
    editing.value = undefined;
    baseline.value = undefined;
  }
  await nextTick();
  const next = saved.value[index] ?? saved.value[index - 1];
  const nextFocus = next ? inRow(next.id, '[data-testid="probe-target-delete"]') ?? inRow(next.id, "input") : undefined;
  if (nextFocus) nextFocus.focus();
  else fallbackFocus();
}

function sentence(message: string): string {
  return message ? message.charAt(0).toUpperCase() + message.slice(1) : message;
}

const outdatedReason = computed(() => (custom.value?.reason || "the probe does not run them").replace(/\.$/, ""));

/** For the panel's "Run" pointing at the targets when none is chosen. */
function focusFirst(): void {
  listRoot.value?.querySelector<HTMLInputElement>("input[type=checkbox]:not(:disabled)")?.focus();
}
defineExpose({ focusFirst });

const describedBy = (field: DraftField) => (shownErrors.value[field] ? `probe-target-${field}-error` : `probe-target-${field}-help`);
</script>

<template>
  <fieldset ref="listRoot" class="field probe-wide probe-targets" data-testid="probe-targets">
    <legend>Targets</legend>
    <p
      v-if="p.targets.value.length"
      class="probe-targets-count"
      :data-tone="chosenCount > MAX_TARGETS_PER_RUN ? 'error' : undefined"
      aria-live="polite"
      data-testid="probe-targets-count"
    >
      {{ chosenCount > MAX_TARGETS_PER_RUN ? `${chosenCount} chosen; a run measures at most ${MAX_TARGETS_PER_RUN}` : `${chosenCount} of ${MAX_TARGETS_PER_RUN} chosen` }}
    </p>
    <p v-if="p.targetsState.value === 'loading' && !p.targets.value.length" class="field-help"><LoaderCircle class="spin" :size="12" aria-hidden="true" /> Reading the probe's targets</p>
    <p v-else-if="p.targetsState.value === 'error'" class="field-help error-text">
      {{ p.targetsError.value }}
      <button class="probe-link" type="button" @click="p.refresh()">Try again</button>
    </p>
    <template v-else>
      <div class="probe-target-list">
        <label v-for="target in builtin" :key="target.id" class="probe-check" :data-target="target.id">
          <input v-model="p.chosenTargets.value" type="checkbox" :value="target.id" />
          <span class="mono probe-target-name">{{ target.id }}</span>
          <small><template v-for="(part, index) in facts(target)" :key="part"><template v-if="index"> · </template><span class="probe-fact">{{ part }}</span></template></small>
        </label>
      </div>

      <section v-if="showSaved && custom" class="probe-saved" aria-labelledby="probe-saved-title" data-testid="probe-saved">
        <div class="probe-saved-head">
          <h3 id="probe-saved-title">Saved targets</h3>
          <span class="probe-saved-count">{{ saved.length }} of {{ custom.limit }}</span>
        </div>
        <p v-if="saved.length && !savedRun" class="probe-saved-note" data-tone="warning" data-testid="probe-saved-outdated">
          Saved targets cannot run yet: {{ outdatedReason }}. Updating lattice-probe lets them run; the built-in targets run as before.
        </p>

        <div v-if="saved.length" class="probe-target-list">
          <template v-for="target in visibleSaved" :key="target.id">
            <div
              class="probe-check probe-saved-row"
              :data-target="target.id"
              :data-editing="editing === target.id"
              :data-disabled="!savedRun"
            >
              <span v-if="confirming === target.id" class="probe-saved-confirm" role="group" :aria-label="`Delete ${target.label}?`" @keydown="onConfirmKey($event, target)">
                <span class="probe-saved-confirm-text">Delete {{ target.label }}?</span>
                <span class="probe-saved-confirm-actions">
                  <button class="button button-danger button-compact" type="button" :disabled="busy" data-testid="probe-target-confirm-delete" @click="confirmDelete(target)">
                    <LoaderCircle v-if="busy" class="spin" :size="13" aria-hidden="true" /> Delete
                  </button>
                  <button class="button button-secondary button-compact" type="button" :disabled="busy" data-keep @click="keep(target)">Keep</button>
                </span>
              </span>
              <template v-else>
                <label class="probe-saved-pick">
                  <input v-model="p.chosenTargets.value" type="checkbox" :value="target.id" :disabled="!savedRun" />
                  <span class="probe-target-name" :title="target.label">{{ target.label }}</span>
                  <small><template v-for="(part, index) in facts(target)" :key="part"><template v-if="index"> · </template><span class="probe-fact">{{ part }}</span></template></small>
                </label>
                <span v-if="p.canEditTargets.value" class="probe-saved-actions">
                  <button class="icon-button" type="button" :aria-label="`Edit ${target.label}`" :title="`Edit ${target.label}`" :disabled="busy" data-testid="probe-target-edit" @click="openForm(target)">
                    <Pencil :size="14" aria-hidden="true" />
                  </button>
                  <button class="icon-button" type="button" :aria-label="`Delete ${target.label}`" :title="`Delete ${target.label}`" :disabled="busy" data-testid="probe-target-delete" @click="askDelete(target)">
                    <Trash2 :size="14" aria-hidden="true" />
                  </button>
                </span>
              </template>
              <p v-if="deleteError?.id === target.id" class="probe-saved-error error-text" role="alert">
                {{ deleteError.message }}
                <button v-if="deleteError.stale" class="probe-link" type="button" @click="reload(target.id)">Reload targets</button>
              </p>
            </div>
            <div :id="`probe-target-slot-${target.id}`" class="probe-target-slot"></div>
          </template>
          <button v-if="folds" class="probe-link probe-saved-fold" type="button" :aria-expanded="expanded" data-testid="probe-saved-fold" @click="expanded = !expanded">
            {{ expanded ? "Show fewer saved targets" : `Show all ${saved.length} saved targets (${hiddenCount} more)` }}
          </button>
        </div>
        <p v-else-if="editing !== 'new'" class="probe-saved-empty">
          None yet. A saved target is a URL of your own, such as a health endpoint, that every run can measure beside the built-in ones.
        </p>
        <div id="probe-target-slot-new" class="probe-target-slot"></div>

        <Teleport v-if="editing" defer :to="formSlot">
          <form class="probe-target-form" :aria-label="formTitle" novalidate data-testid="probe-target-form" @submit.prevent="submit" @keydown="onFormKey">
            <strong class="probe-target-form-title">{{ formTitle }}</strong>
            <p v-if="gone" class="probe-saved-note probe-wide" data-tone="warning" role="alert" data-testid="probe-target-gone">
              Someone deleted this target while you were editing it. Save it as a new target, or cancel.
            </p>
            <p v-else-if="notice" class="probe-saved-note probe-wide" data-tone="info" role="status" data-testid="probe-target-notice">{{ notice }}</p>
            <div class="field probe-wide">
              <label for="probe-target-label-input">Name</label>
              <input
                id="probe-target-label-input"
                ref="nameInput"
                v-model="draft.label"
                type="text"
                autocomplete="off"
                :aria-invalid="!!shownErrors.label"
                :aria-describedby="describedBy('label')"
                data-testid="probe-target-label"
                @blur="leave('label')"
              />
              <small v-if="shownErrors.label" id="probe-target-label-error" class="field-help error-text">{{ shownErrors.label }}</small>
              <small v-else id="probe-target-label-help" class="field-help">Shown in the list and the result.</small>
            </div>
            <div class="field probe-wide">
              <label for="probe-target-url-input">URL</label>
              <input
                id="probe-target-url-input"
                v-model="draft.url"
                type="text"
                inputmode="url"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                :aria-invalid="!!shownErrors.url"
                :aria-describedby="describedBy('url')"
                data-testid="probe-target-url"
                @blur="leave('url')"
              />
              <small v-if="shownErrors.url" id="probe-target-url-error" class="field-help error-text">{{ shownErrors.url }}</small>
              <small v-else id="probe-target-url-help" class="field-help">https only, on port 443 or 1024 and up. Requested through the tested line; redirects are not followed.</small>
            </div>
            <div class="field">
              <label for="probe-target-method-input">Method</label>
              <select id="probe-target-method-input" v-model="draft.method" :aria-describedby="describedBy('method')" data-testid="probe-target-method">
                <option value="GET">GET</option>
                <option value="HEAD">HEAD</option>
              </select>
              <small id="probe-target-method-help" class="field-help">HEAD skips the body.</small>
            </div>
            <div class="field">
              <label for="probe-target-status-input">Passing statuses</label>
              <input
                id="probe-target-status-input"
                v-model="draft.expectStatus"
                type="text"
                inputmode="numeric"
                autocomplete="off"
                placeholder="204 or 200-299,301"
                :aria-invalid="!!shownErrors.expectStatus"
                :aria-describedby="describedBy('expectStatus')"
                data-testid="probe-target-status"
                @blur="leave('expectStatus')"
              />
              <small v-if="shownErrors.expectStatus" id="probe-target-expectStatus-error" class="field-help error-text">{{ shownErrors.expectStatus }}</small>
              <small v-else id="probe-target-expectStatus-help" class="field-help">Statuses and ranges, comma-separated.</small>
            </div>
            <div class="field probe-wide">
              <label for="probe-target-body-input">Body must contain <em class="muted">optional</em></label>
              <input
                id="probe-target-body-input"
                v-model="draft.bodyContains"
                type="text"
                autocomplete="off"
                :disabled="draft.method === 'HEAD'"
                :aria-invalid="!!shownErrors.bodyContains"
                :aria-describedby="describedBy('bodyContains')"
                data-testid="probe-target-body"
                @blur="leave('bodyContains')"
              />
              <small v-if="shownErrors.bodyContains" id="probe-target-bodyContains-error" class="field-help error-text">{{ shownErrors.bodyContains }}</small>
              <small v-else id="probe-target-bodyContains-help" class="field-help">
                {{ draft.method === "HEAD" ? "Not sent with HEAD, which has no body. Kept here in case you switch back to GET." : "Looked for in the first 64 KiB. The result says only whether it was found." }}
              </small>
            </div>
            <p v-if="saveError" class="probe-saved-error error-text probe-wide" role="alert" data-testid="probe-target-save-error">
              {{ saveError.message }}
              <button v-if="saveError.stale" class="probe-link" type="button" :disabled="busy" @click="reload()">Reload targets</button>
            </p>
            <div class="probe-target-form-actions probe-wide">
              <button class="button button-secondary button-compact" type="button" :disabled="busy" data-testid="probe-target-cancel" @click="closeForm()">Cancel</button>
              <button class="button button-primary button-compact" type="submit" :disabled="busy" data-testid="probe-target-save">
                <LoaderCircle v-if="busy" class="spin" :size="13" aria-hidden="true" />
                {{ editing === "new" ? "Save target" : gone ? "Save as new" : "Save changes" }}
              </button>
            </div>
          </form>
        </Teleport>

        <template v-if="!editing">
          <button
            v-if="p.canEditTargets.value"
            ref="addButton"
            class="button button-secondary button-compact probe-target-add"
            type="button"
            :disabled="full || busy"
            data-testid="probe-target-add"
            @click="openForm()"
          >
            <Plus :size="13" aria-hidden="true" /> Add target
          </button>
          <small v-if="p.canEditTargets.value && full" class="field-help">The list holds {{ custom.limit }} targets. Delete one to add another.</small>
          <small v-else-if="!p.canEditTargets.value" class="field-help" data-testid="probe-target-readonly">
            Adding or changing saved targets needs <span class="mono">vpncore:admin</span>, which this session does not carry.<template v-if="savedRun"> Running them needs only <span class="mono">vpn:probe</span>.</template>
          </small>
        </template>
      </section>
    </template>
    <p class="sr-only" role="status" data-testid="probe-targets-announce">{{ announce }}</p>
  </fieldset>
</template>
