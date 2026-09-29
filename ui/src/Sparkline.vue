<script setup lang="ts">
/**
 * A day-by-day trend in a table cell. The shape is the point; the accessible
 * name carries the first, last and highest day so the figure survives without
 * the picture.
 */
import { computed } from "vue";

import { formatBytes } from "./vpnModel";

const props = withDefaults(defineProps<{
  values: readonly number[];
  /** What the trend is of, for the accessible name. */
  label: string;
  width?: number;
  height?: number;
}>(), { width: 88, height: 22 });

const PAD = 2;
const max = computed(() => props.values.reduce((value, next) => Math.max(value, next), 0));
const points = computed(() => {
  const count = props.values.length;
  if (!count) return [] as Array<[number, number]>;
  const step = count > 1 ? (props.width - PAD * 2) / (count - 1) : 0;
  return props.values.map((value, index): [number, number] => {
    const y = max.value > 0 ? props.height - PAD - (value / max.value) * (props.height - PAD * 2) : props.height - PAD;
    return [PAD + index * step, Math.round(y * 10) / 10];
  });
});
const line = computed(() => points.value.map(([x, y]) => `${x},${y}`).join(" "));
const area = computed(() => {
  if (!points.value.length) return "";
  const first = points.value[0];
  const last = points.value[points.value.length - 1];
  return `M${first[0]},${props.height - PAD} L${line.value.replace(/ /g, " L")} L${last[0]},${props.height - PAD} Z`;
});
const name = computed(() => {
  if (!props.values.length) return `${props.label}: no days reported`;
  const first = props.values[0];
  const last = props.values[props.values.length - 1];
  return `${props.label}: ${formatBytes(first)} on the first day, ${formatBytes(last)} on the last, ${formatBytes(max.value)} at the highest`;
});
</script>

<template>
  <svg class="sparkline" :width="width" :height="height" :viewBox="`0 0 ${width} ${height}`" role="img" :aria-label="name">
    <title>{{ name }}</title>
    <template v-if="points.length > 1">
      <path class="sparkline-area" :d="area" />
      <polyline class="sparkline-line" :points="line" />
      <circle class="sparkline-end" :cx="points[points.length - 1][0]" :cy="points[points.length - 1][1]" r="2" />
    </template>
    <circle v-else-if="points.length" class="sparkline-end" :cx="width / 2" :cy="points[0][1]" r="2" />
  </svg>
</template>
