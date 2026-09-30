<script setup lang="ts">
/**
 * Choosing one of 136 lines: a search field over node, line, protocol and
 * port, with the matches listed under it, instead of a select nobody can
 * scan. Lines already bound are left out. Choosing a match fills the field;
 * Bind does the write, so a stray Enter never binds the wrong line.
 *
 * The list is in the flow of the panel, not floating, so the panel's own
 * scroll carries it and nothing is clipped at the sheet's edge.
 */
import { computed, ref, watch } from "vue";
import { LoaderCircle, Plus } from "@lucide/vue";

import { filterLineOptions, type LineOption } from "./usersModel";

const props = defineProps<{
  options: readonly LineOption[];
  exclude: ReadonlySet<string>;
  busy: boolean;
  /** Names the field for assistive tech, "Bind a line to probe@..." */
  label: string;
}>();
const emit = defineEmits<{ pick: [hash: string] }>();

const LIMIT = 8;
const uid = `line-picker-${Math.random().toString(36).slice(2, 8)}`;
const query = ref("");
const listOpen = ref(false);
const active = ref(0);
const chosen = ref<LineOption>();

const result = computed(() => filterLineOptions(props.options, chosen.value ? "" : query.value, props.exclude, LIMIT));
const available = computed(() => props.options.filter((option) => !props.exclude.has(option.hash)).length);

watch(() => result.value.shown.length, () => { active.value = 0; });
/* The choice clears when its line turns up among the bound ones: that is
 * the bind landing (or a bind made elsewhere). A bind that fails leaves the
 * line chosen, so Bind can be pressed again. */
watch(() => props.exclude, (exclude) => {
  if (chosen.value && exclude.has(chosen.value.hash)) clear();
});

function optionText(option: LineOption): string {
  return `${option.node} / ${option.name}`;
}

function choose(option: LineOption): void {
  chosen.value = option;
  query.value = optionText(option);
  listOpen.value = false;
}

function clear(): void {
  chosen.value = undefined;
  query.value = "";
}

function onInput(event: Event): void {
  query.value = (event.target as HTMLInputElement).value;
  chosen.value = undefined;
  listOpen.value = true;
}

const inputEl = ref<HTMLInputElement>();

/* The Bind button is disabled while the write runs, which would drop focus
 * to the page; it goes back to the field. The choice stays until the bind
 * lands (see the watch above). */
function bind(): void {
  if (!chosen.value || props.busy) return;
  emit("pick", chosen.value.hash);
  inputEl.value?.focus();
  listOpen.value = false;
}

function onKey(event: KeyboardEvent): void {
  const shown = result.value.shown;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    listOpen.value = true;
    active.value = shown.length ? (active.value + 1) % shown.length : 0;
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    listOpen.value = true;
    active.value = shown.length ? (active.value - 1 + shown.length) % shown.length : 0;
  } else if (event.key === "Enter") {
    event.preventDefault();
    if (listOpen.value && shown[active.value]) choose(shown[active.value]);
    else bind();
  } else if (event.key === "Escape") {
    // Close the list, then clear the field; only an empty, closed picker
    // lets Escape through to close the panel.
    if (listOpen.value) {
      event.stopPropagation();
      listOpen.value = false;
    } else if (query.value) {
      event.stopPropagation();
      clear();
    }
  }
}

/* The list closes when focus leaves the picker, after a click on an option has landed. */
function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null;
  if (next && (event.currentTarget as HTMLElement).contains(next)) return;
  listOpen.value = false;
}
</script>

<template>
  <div class="line-picker" @focusout="onFocusOut">
    <div class="line-picker-row">
      <input
        :id="`${uid}-input`"
        ref="inputEl"
        class="search-input"
        type="text"
        role="combobox"
        autocomplete="off"
        spellcheck="false"
        :aria-label="label"
        aria-autocomplete="list"
        :aria-expanded="listOpen"
        :aria-controls="`${uid}-list`"
        :aria-activedescendant="listOpen && result.shown[active] ? `${uid}-option-${active}` : undefined"
        :value="query"
        :placeholder="`Search ${available} unbound lines`"
        :disabled="!available"
        @input="onInput"
        @focus="listOpen = true"
        @click="listOpen = true"
        @keydown="onKey"
      />
      <button class="button button-primary" type="button" :disabled="!chosen || busy" @click="bind">
        <LoaderCircle v-if="busy" class="spin" :size="15" aria-hidden="true" /><Plus v-else :size="15" aria-hidden="true" /> Bind
      </button>
    </div>
    <ul v-if="listOpen && available" :id="`${uid}-list`" class="line-picker-list" role="listbox" :aria-label="label">
      <li
        v-for="(option, index) in result.shown"
        :id="`${uid}-option-${index}`"
        :key="option.hash"
        role="option"
        :aria-selected="index === active"
        @mousedown.prevent="choose(option)"
        @mousemove="active = index"
      >
        <strong :title="option.node">{{ option.node }}</strong>
        <span :title="option.name">{{ option.name }}</span>
        <span class="mono">{{ option.detail }}</span>
      </li>
      <li v-if="!result.matched" class="line-picker-note" role="presentation">No unbound line matches <span class="mono">{{ query.trim() }}</span>.</li>
      <li v-else-if="result.matched > result.shown.length" class="line-picker-note" role="presentation">{{ result.matched - result.shown.length }} more {{ result.matched - result.shown.length === 1 ? 'line matches' : 'lines match' }}. Keep typing to narrow the list.</li>
    </ul>
    <p v-if="!available" class="field-help">Every line the fleet reports is already bound to this identity.</p>
  </div>
</template>
