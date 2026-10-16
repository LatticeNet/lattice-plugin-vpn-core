<script setup lang="ts">
/**
 * The Probe layer's Targets field: the probe's built-in targets and the
 * operator's saved ones in one list to pick from, and for a session that may
 * change the saved list, an inline form to add or edit one.
 *
 * A saved target is a URL the server keeps and sends to the probe by id; the
 * probe checks it again before every run. The form's checks are the probe's
 * rules said beside the field (probeTargetForm.ts), so a bad URL is fixed
 * while it is typed. A server without saved targets (older than this page)
 * answers no `custom`, and the list is then the built-in targets alone.
 */
import { computed, nextTick, ref, watch } from "vue";
import { LoaderCircle, Pencil, Plus, Trash2 } from "@lucide/vue";

import type { ProbeState } from "./probe";
import type { ProbeTarget } from "./probeModel";
import { checkTargetDraft, draftFrom, emptyDraft, type DraftField, type TargetDraft } from "./probeTargetForm";

const props = defineProps<{ probe: ProbeState }>();
const p = props.probe;

const builtin = computed(() => p.targets.value.filter((target) => target.source === "builtin"));
const saved = computed(() => p.targets.value.filter((target) => target.source === "custom"));
const custom = computed(() => p.custom.value);
const savedRun = computed(() => !!custom.value?.supported);
const full = computed(() => !!custom.value && p.customCount.value >= custom.value.limit);

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function facts(target: ProbeTarget): string {
  const parts = [hostOf(target.url)];
  if (target.method === "HEAD") parts.push("HEAD");
  if (target.expectStatus) parts.push(`expects ${target.expectStatus}`);
  if (target.bodyContains) parts.push("checks text");
  return parts.join(" · ");
}

// ── the form ──────────────────────────────────────────────────────────────
/** Open for a new target ("new"), for a saved one (its id), or closed. */
const editing = ref<string>();
const draft = ref<TargetDraft>(emptyDraft());
const touched = ref(new Set<DraftField>());
const tried = ref(false);
const saveError = ref<{ message: string; stale: boolean }>();

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

const editedTarget = computed(() => saved.value.find((target) => target.id === editing.value));
const formTitle = computed(() => (editedTarget.value ? `Edit ${editedTarget.value.label}` : "Add a target"));

const addButton = ref<HTMLButtonElement>();
const nameInput = ref<HTMLInputElement>();
const listRoot = ref<HTMLElement>();

async function openForm(target?: ProbeTarget): Promise<void> {
  confirming.value = undefined;
  editing.value = target ? target.id : "new";
  draft.value = target ? draftFrom(target) : emptyDraft();
  touched.value = new Set();
  tried.value = false;
  saveError.value = undefined;
  await nextTick();
  nameInput.value?.focus();
}

async function closeForm(focusId?: string): Promise<void> {
  const was = editing.value;
  editing.value = undefined;
  saveError.value = undefined;
  await nextTick();
  const id = focusId ?? (was && was !== "new" ? was : undefined);
  const row = id ? listRoot.value?.querySelector<HTMLElement>(`[data-target="${id}"] input`) : undefined;
  (row ?? addButton.value)?.focus();
}

function leave(field: DraftField): void {
  touched.value = new Set(touched.value).add(field);
}

async function submit(): Promise<void> {
  tried.value = true;
  saveError.value = undefined;
  const result = check.value;
  if (!result.ok) {
    await nextTick();
    listRoot.value?.querySelector<HTMLElement>('.probe-target-form [aria-invalid="true"]')?.focus();
    return;
  }
  const outcome = await p.saveTarget(result.input, editedTarget.value);
  if (!outcome.ok) {
    saveError.value = { message: outcome.message, stale: outcome.stale };
    return;
  }
  await closeForm(outcome.target.id);
}

function onFormKey(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    void closeForm();
  }
}

// HEAD has no body, so the text field steps aside rather than holding a value that would be refused.
watch(() => draft.value.method, (method) => {
  if (method === "HEAD" && draft.value.bodyContains) draft.value.bodyContains = "";
});

// ── delete ────────────────────────────────────────────────────────────────
const confirming = ref<string>();
const deleteError = ref<{ id: string; message: string; stale: boolean }>();

async function askDelete(target: ProbeTarget): Promise<void> {
  confirming.value = target.id;
  deleteError.value = undefined;
  await nextTick();
  listRoot.value?.querySelector<HTMLElement>(`[data-target="${target.id}"] [data-keep]`)?.focus();
}

async function keep(target: ProbeTarget): Promise<void> {
  confirming.value = undefined;
  await nextTick();
  listRoot.value?.querySelector<HTMLElement>(`[data-target="${target.id}"] [data-delete]`)?.focus();
}

async function confirmDelete(target: ProbeTarget): Promise<void> {
  const outcome = await p.deleteTarget(target);
  confirming.value = undefined;
  if (!outcome.ok) {
    deleteError.value = { id: target.id, message: outcome.message, stale: outcome.stale };
    return;
  }
  if (editing.value === target.id) editing.value = undefined;
  await nextTick();
  (listRoot.value?.querySelector<HTMLElement>(".probe-target-list input") ?? addButton.value)?.focus();
}

function reload(): void {
  saveError.value = undefined;
  deleteError.value = undefined;
  p.reloadTargets();
}

/** For the panel's "Run" pointing at the targets when none is chosen. */
function focusFirst(): void {
  listRoot.value?.querySelector<HTMLInputElement>(".probe-target-list input:not(:disabled)")?.focus();
}
defineExpose({ focusFirst });

const describedBy = (field: DraftField) => (shownErrors.value[field] ? `probe-target-${field}-error` : `probe-target-${field}-help`);
</script>

<template>
  <fieldset ref="listRoot" class="field probe-wide probe-targets" data-testid="probe-targets">
    <legend>Targets</legend>
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
          <small>{{ facts(target) }}</small>
        </label>
      </div>

      <section v-if="custom" class="probe-saved" aria-labelledby="probe-saved-title" data-testid="probe-saved">
        <div class="probe-saved-head">
          <h3 id="probe-saved-title">Saved targets</h3>
          <span class="probe-saved-count">{{ saved.length }} of {{ custom.limit }}</span>
        </div>
        <p v-if="saved.length && !savedRun" class="probe-saved-note" data-tone="warning" data-testid="probe-saved-outdated">
          Saved targets cannot run yet: {{ custom.reason || "the probe does not run them." }}
        </p>

        <div v-if="saved.length" class="probe-target-list">
          <div
            v-for="target in saved"
            :key="target.id"
            class="probe-check probe-saved-row"
            :data-target="target.id"
            :data-editing="editing === target.id"
            :data-disabled="!savedRun"
          >
            <label class="probe-saved-pick">
              <input v-model="p.chosenTargets.value" type="checkbox" :value="target.id" :disabled="!savedRun" />
              <span class="probe-target-name">{{ target.label }}</span>
              <small>{{ facts(target) }}</small>
            </label>
            <span v-if="confirming === target.id" class="probe-saved-confirm" role="group" :aria-label="`Delete ${target.label}?`">
              <span>Delete?</span>
              <button class="button button-danger button-compact" type="button" :disabled="p.editBusy.value" data-testid="probe-target-confirm-delete" @click="confirmDelete(target)">Delete</button>
              <button class="button button-secondary button-compact" type="button" data-keep @click="keep(target)">Keep</button>
            </span>
            <span v-else-if="p.canEditTargets.value" class="probe-saved-actions">
              <button class="icon-button" type="button" :aria-label="`Edit ${target.label}`" :title="`Edit ${target.label}`" :disabled="p.editBusy.value" data-testid="probe-target-edit" @click="openForm(target)">
                <Pencil :size="14" aria-hidden="true" />
              </button>
              <button class="icon-button" type="button" :aria-label="`Delete ${target.label}`" :title="`Delete ${target.label}`" :disabled="p.editBusy.value" data-delete data-testid="probe-target-delete" @click="askDelete(target)">
                <Trash2 :size="14" aria-hidden="true" />
              </button>
            </span>
            <p v-if="deleteError?.id === target.id" class="probe-saved-error error-text" role="alert">
              {{ deleteError.message }}
              <button v-if="deleteError.stale" class="probe-link" type="button" @click="reload">Reload targets</button>
            </p>
          </div>
        </div>
        <p v-else-if="editing !== 'new'" class="probe-saved-empty">
          None yet. A saved target is a URL of your own, such as a health endpoint, that every run can measure beside the built-in ones.
        </p>

        <form v-if="editing" class="probe-target-form" :aria-label="formTitle" novalidate data-testid="probe-target-form" @submit.prevent="submit" @keydown="onFormKey">
          <strong class="probe-target-form-title">{{ formTitle }}</strong>
          <label class="field probe-wide">
            <span>Name</span>
            <input
              ref="nameInput"
              v-model="draft.label"
              type="text"
              autocomplete="off"
              :aria-invalid="!!shownErrors.label"
              :aria-describedby="describedBy('label')"
              data-testid="probe-target-label"
              @blur="leave('label')"
            />
            <small v-if="shownErrors.label" :id="'probe-target-label-error'" class="field-help error-text">{{ shownErrors.label }}</small>
            <small v-else id="probe-target-label-help" class="field-help">Shown in the list and the result.</small>
          </label>
          <label class="field probe-wide">
            <span>URL</span>
            <input
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
          </label>
          <label class="field">
            <span>Method</span>
            <select v-model="draft.method" :aria-describedby="describedBy('method')" data-testid="probe-target-method">
              <option value="GET">GET</option>
              <option value="HEAD">HEAD</option>
            </select>
            <small id="probe-target-method-help" class="field-help">HEAD skips the body.</small>
          </label>
          <label class="field">
            <span>Passing statuses</span>
            <input
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
          </label>
          <label class="field probe-wide">
            <span>Body must contain <em class="muted">optional</em></span>
            <input
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
            <small v-else id="probe-target-bodyContains-help" class="field-help">{{ draft.method === "HEAD" ? "Needs GET." : "Looked for in the first 64 KiB. The result says only whether it was found." }}</small>
          </label>
          <p v-if="saveError" class="probe-saved-error error-text probe-wide" role="alert" data-testid="probe-target-save-error">
            {{ saveError.message }}
            <button v-if="saveError.stale" class="probe-link" type="button" @click="reload">Reload targets</button>
          </p>
          <div class="probe-target-form-actions probe-wide">
            <button class="button button-secondary button-compact" type="button" data-testid="probe-target-cancel" @click="closeForm()">Cancel</button>
            <button class="button button-primary button-compact" type="submit" :disabled="p.editBusy.value" data-testid="probe-target-save">
              <LoaderCircle v-if="p.editBusy.value" class="spin" :size="13" aria-hidden="true" />
              {{ editedTarget ? "Save changes" : "Save target" }}
            </button>
          </div>
        </form>

        <template v-if="!editing">
          <button
            v-if="p.canEditTargets.value"
            ref="addButton"
            class="button button-secondary button-compact probe-target-add"
            type="button"
            :disabled="full || p.editBusy.value"
            data-testid="probe-target-add"
            @click="openForm()"
          >
            <Plus :size="13" aria-hidden="true" /> Add target
          </button>
          <small v-if="p.canEditTargets.value && full" class="field-help">The list holds {{ custom.limit }} targets. Delete one to add another.</small>
          <small v-else-if="!p.canEditTargets.value" class="field-help" data-testid="probe-target-readonly">
            Adding or changing saved targets needs <span class="mono">vpncore:admin</span>, which this session does not carry. Running them needs only <span class="mono">vpn:probe</span>.
          </small>
        </template>
      </section>
    </template>
  </fieldset>
</template>
