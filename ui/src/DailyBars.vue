<script setup lang="ts">
/**
 * Stacked daily bars. One bar per day, one segment per exit (or per role),
 * the same order bottom to top on every day and in the legend, so a segment
 * is found by its place and its label, not only by its shade. Pointing at or
 * focusing a day puts that day's breakdown in the legend.
 *
 * The chart measures its own width so axis text stays at its real size; a
 * viewBox stretched to the panel would scale 11px labels with it.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { OTHERS_KEY, byteTicks, shortDay, type DailyStack, type StackSegment } from "./trafficModel";
import { formatBytes } from "./vpnModel";

const props = defineProps<{
  stack: DailyStack;
  /** The accessible name of the figure. */
  label: string;
}>();

const HEIGHT = 200;
const GUTTER_LEFT = 58;
const GUTTER_BOTTOM = 22;
const TOP = 8;

const root = ref<HTMLElement>();
const width = ref(720);
let observer: ResizeObserver | undefined;
onMounted(() => {
  if (!root.value) return;
  width.value = root.value.clientWidth || width.value;
  if (typeof ResizeObserver === "undefined") return;
  observer = new ResizeObserver(([entry]) => { width.value = Math.max(240, Math.floor(entry.contentRect.width)); });
  observer.observe(root.value);
});
onBeforeUnmount(() => { observer?.disconnect(); observer = undefined; });

const plotWidth = computed(() => Math.max(120, width.value - GUTTER_LEFT - 4));
const plotHeight = HEIGHT - TOP - GUTTER_BOTTOM;
const ticks = computed(() => byteTicks(props.stack.max));
const top = computed(() => Math.max(props.stack.max, ticks.value[ticks.value.length - 1] ?? 0) || 1);
const slot = computed(() => plotWidth.value / Math.max(1, props.stack.days.length));
const barWidth = computed(() => Math.max(3, Math.min(56, slot.value * 0.62)));
const y = (value: number) => TOP + plotHeight - (value / top.value) * plotHeight;

function axisBytes(value: number): string {
  return value === 0 ? "0" : formatBytes(value).replace(/\.0 /, " ");
}

/** Accent steps for named segments, a neutral for "others" and the repeated roles. */
function fill(segment: StackSegment, index: number): string {
  if (segment.key === OTHERS_KEY || segment.key === "other") return "var(--series-muted-2)";
  if (segment.key === "entry") return "var(--series-muted-1)";
  if (segment.key === "relay") return "var(--series-muted-3)";
  return `var(--series-${Math.min(index, 5) + 1})`;
}

interface BarRect { key: string; x: number; y: number; height: number; fill: string }
const bars = computed(() => props.stack.days.map((day, dayIndex) => {
  let base = 0;
  const rects: BarRect[] = [];
  props.stack.segments.forEach((segment, index) => {
    const value = segment.values[dayIndex] ?? 0;
    if (value <= 0) return;
    const y1 = y(base);
    const y2 = y(base + value);
    rects.push({ key: segment.key, x: GUTTER_LEFT + dayIndex * slot.value + (slot.value - barWidth.value) / 2, y: y2, height: Math.max(0.5, y1 - y2), fill: fill(segment, index) });
    base += value;
  });
  return { day, dayIndex, rects, total: props.stack.totals[dayIndex] ?? 0 };
}));

const labelEvery = computed(() => (props.stack.days.length <= 10 ? 1 : Math.ceil(props.stack.days.length / 8)));
function showDayLabel(index: number): boolean {
  const last = props.stack.days.length - 1;
  if (index === last) return true;
  return index % labelEvery.value === 0 && last - index >= labelEvery.value * 0.6;
}

const active = ref<number>();
const legend = computed(() => props.stack.segments.map((segment, index) => ({
  key: segment.key,
  label: segment.label,
  fill: fill(segment, index),
  value: active.value === undefined ? segment.total : segment.values[active.value] ?? 0,
})));
const legendTitle = computed(() => active.value === undefined
  ? `${props.stack.days.length === 1 ? "The day" : `${props.stack.days.length} days`}, ${formatBytes(props.stack.totals.reduce((sum, value) => sum + value, 0))}`
  : `${shortDay(props.stack.days[active.value])}, ${formatBytes(props.stack.totals[active.value] ?? 0)}`);

function step(delta: number): void {
  const last = props.stack.days.length - 1;
  if (last < 0) return;
  const from = active.value ?? last;
  active.value = Math.min(last, Math.max(0, from + delta));
}

function dayName(index: number): string {
  const parts = props.stack.segments
    .map((segment) => ({ label: segment.label, value: segment.values[index] ?? 0 }))
    .filter((part) => part.value > 0)
    .map((part) => `${part.label} ${formatBytes(part.value)}`);
  return `${shortDay(props.stack.days[index])}: ${formatBytes(props.stack.totals[index] ?? 0)}${parts.length ? `; ${parts.join("; ")}` : ""}`;
}
</script>

<template>
  <div ref="root" class="daily-bars">
    <!-- One tab stop for the figure; the arrow keys walk the days. The table
         after it carries every figure for a screen reader. -->
    <svg
      class="daily-bars-figure"
      :width="width"
      :height="HEIGHT"
      :viewBox="`0 0 ${width} ${HEIGHT}`"
      role="img"
      tabindex="0"
      :aria-label="active === undefined ? `${label}. Use the arrow keys to read one day.` : dayName(active)"
      @mouseleave="active = undefined"
      @focus="active = active ?? stack.days.length - 1"
      @blur="active = undefined"
      @keydown.left.prevent="step(-1)"
      @keydown.right.prevent="step(1)"
    >
      <title>{{ label }}</title>
      <g class="chart-grid" aria-hidden="true">
        <g v-for="tick in ticks" :key="tick">
          <line :x1="GUTTER_LEFT" :x2="width - 4" :y1="y(tick)" :y2="y(tick)" />
          <text :x="GUTTER_LEFT - 8" :y="y(tick) + 4" text-anchor="end">{{ axisBytes(tick) }}</text>
        </g>
      </g>
      <g
        v-for="bar in bars"
        :key="bar.day"
        class="chart-day"
        :data-active="active === bar.dayIndex ? 'true' : undefined"
        aria-hidden="true"
        @mouseenter="active = bar.dayIndex"
      >
        <rect class="chart-hit" :x="GUTTER_LEFT + bar.dayIndex * slot" :y="TOP" :width="slot" :height="plotHeight" />
        <rect v-for="rect in bar.rects" :key="rect.key" class="chart-segment" :x="rect.x" :y="rect.y" :width="barWidth" :height="rect.height" :style="{ fill: rect.fill }" />
        <text v-if="showDayLabel(bar.dayIndex)" class="chart-axis" :x="GUTTER_LEFT + bar.dayIndex * slot + slot / 2" :y="HEIGHT - 6" text-anchor="middle">{{ shortDay(bar.day) }}</text>
      </g>
    </svg>
    <div class="chart-legend" aria-live="polite">
      <p class="chart-legend-title">{{ legendTitle }}</p>
      <ol>
        <!-- Bottom of the stack first, the order the bars are drawn in. -->
        <li v-for="item in legend" :key="item.key">
          <i :style="{ background: item.fill }" aria-hidden="true" />
          <span :title="item.label">{{ item.label }}</span>
          <strong>{{ formatBytes(item.value) }}</strong>
        </li>
      </ol>
    </div>
    <table class="sr-only">
      <caption>{{ label }}</caption>
      <thead><tr><th>Day</th><th v-for="segment in stack.segments" :key="segment.key">{{ segment.label }}</th><th>Total</th></tr></thead>
      <tbody>
        <tr v-for="(day, index) in stack.days" :key="day">
          <td>{{ shortDay(day) }}</td>
          <td v-for="segment in stack.segments" :key="segment.key">{{ formatBytes(segment.values[index] ?? 0) }}</td>
          <td>{{ formatBytes(stack.totals[index] ?? 0) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
