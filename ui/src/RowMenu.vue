<script setup lang="ts">
/**
 * One row menu for every collection in this plugin: a row has one click
 * target (its panel) and this menu for the rest.
 *
 * Fixed to the window, not inside the table: tables scroll sideways on a
 * phone, and a menu inside the scrollport would be clipped by it. Items that
 * cannot run stay listed with the reason inline, because touch has no
 * tooltip. Dangerous items sit last, after a separator.
 *
 * The owner opens it from a trigger with `open(event, key, label, items)` and
 * reads `openKey` for the trigger's aria-expanded. `noun` names the menu the
 * way the trigger does ("Evidence for <line>", "Actions for <identity>").
 */
import { computed, nextTick, onBeforeUnmount, ref } from "vue";

export interface RowMenuItem {
  label: string;
  run: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Why a disabled item cannot run, shown under it. */
  reason?: string;
}

const props = withDefaults(defineProps<{ noun?: string }>(), { noun: "Actions" });

const WIDTH = 240;
const GAP = 4;
const EDGE = 8;

const menu = ref<{ key: string; label: string; x: number; y: number; items: RowMenuItem[] }>();
const menuEl = ref<HTMLElement>();
let trigger: HTMLElement | undefined;

/* Dangerous items last, whatever order the owner listed them in. */
const ordered = computed(() => {
  const items = menu.value?.items ?? [];
  return [...items.filter((item) => !item.danger), ...items.filter((item) => item.danger)];
});
const firstDanger = computed(() => ordered.value.findIndex((item) => item.danger));

function place(rect: DOMRect, height: number): { x: number; y: number } {
  const x = Math.max(EDGE, Math.min(rect.right - WIDTH, window.innerWidth - WIDTH - EDGE));
  const below = rect.bottom + GAP;
  const y = below + height + EDGE > window.innerHeight ? Math.max(EDGE, rect.top - GAP - height) : below;
  return { x, y };
}

async function open(event: MouseEvent, key: string, label: string, items: RowMenuItem[]): Promise<void> {
  if (menu.value?.key === key) {
    close();
    return;
  }
  close();
  trigger = event.currentTarget as HTMLElement;
  const rect = trigger.getBoundingClientRect();
  // A first guess from the item count, then the measured height once drawn.
  const guess = items.length * 34 + 16;
  menu.value = { key, label, items, ...place(rect, guess) };
  await nextTick();
  if (menuEl.value && menu.value) Object.assign(menu.value, place(rect, menuEl.value.offsetHeight));
  // The first item that can run, or the menu itself when none can: focus
  // left on the trigger would never see the menu's Escape.
  (menuEl.value?.querySelector<HTMLElement>("button:not(:disabled)") ?? menuEl.value)?.focus();
  document.addEventListener("pointerdown", onOutside, true);
  window.addEventListener("scroll", dismiss, true);
  window.addEventListener("resize", dismiss);
}

function close(returnFocus = false): void {
  if (!menu.value) return;
  menu.value = undefined;
  document.removeEventListener("pointerdown", onOutside, true);
  window.removeEventListener("scroll", dismiss, true);
  window.removeEventListener("resize", dismiss);
  if (returnFocus) trigger?.focus();
}

/* Scrolling or resizing moves the row out from under a fixed menu. */
function dismiss(): void {
  close();
}

function onOutside(event: Event): void {
  if (menuEl.value?.contains(event.target as Node) || trigger?.contains(event.target as Node)) return;
  close();
}

function runItem(item: RowMenuItem): void {
  if (item.disabled) return;
  close(true);
  item.run();
}

function onKey(event: KeyboardEvent): void {
  const buttons = [...(menuEl.value?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])];
  const index = buttons.indexOf(document.activeElement as HTMLElement);
  if (event.key === "Escape") {
    // The menu is the top layer; Escape must not also close a panel under it.
    event.preventDefault();
    event.stopPropagation();
    close(true);
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    buttons[(index + 1) % buttons.length]?.focus();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    buttons[(index - 1 + buttons.length) % buttons.length]?.focus();
  } else if (event.key === "Home" || event.key === "End") {
    // The first and last item. Left to the browser, the key scrolled the
    // frame, the scroll closed the menu, and focus fell to <body>.
    event.preventDefault();
    (event.key === "Home" ? buttons[0] : buttons[buttons.length - 1])?.focus();
  } else if (event.key === "Tab") {
    // Tab leaves the menu the way Escape does: closed, with focus on the
    // trigger. Closing alone dropped focus to <body> with the item it was on.
    event.preventDefault();
    close(true);
  }
}

const openKey = computed(() => menu.value?.key);
defineExpose({ open, close, openKey });
onBeforeUnmount(() => close());
</script>

<template>
  <div v-if="menu" ref="menuEl" class="row-menu" role="menu" tabindex="-1" :aria-label="`${props.noun} for ${menu.label}`" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }" @keydown="onKey">
    <template v-for="(item, index) in ordered" :key="item.label">
      <div v-if="index === firstDanger && index > 0" class="row-menu-separator" role="separator" />
      <button type="button" role="menuitem" :class="{ 'row-menu-danger': item.danger }" :disabled="item.disabled" :aria-describedby="item.disabled && item.reason ? `row-menu-reason-${index}` : undefined" @click="runItem(item)">
        {{ item.label }}
        <small v-if="item.disabled && item.reason" :id="`row-menu-reason-${index}`">{{ item.reason }}</small>
      </button>
    </template>
  </div>
</template>
