<script setup lang="ts">
/**
 * The route map: relay hubs on the left, the nodes they dial on the right,
 * one edge per node pair. Width is the period's bytes on the lines behind an
 * edge, colour is the worst state among them, and an endpoint outside the
 * fleet is dashed. Pointing at a box lights its edges and dims the rest;
 * choosing one opens its lines.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { ROUTE_BOX_HEIGHT, ROUTE_BOX_WIDTH, type RouteBox, type RouteEdge, type RouteMap } from "./routeMap";
import { formatBytes } from "./vpnModel";

const props = defineProps<{
  map: RouteMap;
  /** The period the widths cover, for the names: "7 days". */
  periodLabel: string;
}>();
const emit = defineEmits<{ node: [nodeID: string] }>();

const HEADER = 20;
const MIN_SCALE = 0.75;

const root = ref<HTMLElement>();
const width = ref(1200);
let observer: ResizeObserver | undefined;
onMounted(() => {
  if (!root.value) return;
  width.value = root.value.clientWidth || width.value;
  if (typeof ResizeObserver === "undefined") return;
  observer = new ResizeObserver(([entry]) => { width.value = Math.floor(entry.contentRect.width); });
  observer.observe(root.value);
});
onBeforeUnmount(() => { observer?.disconnect(); observer = undefined; });

const totalHeight = computed(() => props.map.height + HEADER);
const scale = computed(() => (props.map.width <= width.value || width.value === 0 ? 1 : Math.max(MIN_SCALE, width.value / props.map.width)));
const renderWidth = computed(() => Math.round(props.map.width * scale.value));
const renderHeight = computed(() => Math.round(totalHeight.value * scale.value));

const names = computed(() => new Map(props.map.boxes.map((box) => [box.id, box.label])));
const hovered = ref<string>();
function touches(edge: RouteEdge, id: string | undefined): boolean {
  return !!id && (edge.from === id || edge.to === id);
}

/** One heading over each column, named for what the column holds. */
const columns = computed(() => {
  const byRank = new Map<number, number>();
  for (const box of props.map.boxes) byRank.set(box.rank, Math.min(byRank.get(box.rank) ?? Infinity, box.x));
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  return ranks.map((rank, index) => ({
    rank,
    x: byRank.get(rank)!,
    label: index === 0 ? "Relay hubs" : index === 1 ? "Exits they dial" : "Next hop",
  }));
});

function path(edge: RouteEdge): string {
  const dx = Math.max(24, (edge.x2 - edge.x1) * 0.5);
  return `M${edge.x1},${edge.y1} C${edge.x1 + dx},${edge.y1} ${edge.x2 - dx},${edge.y2} ${edge.x2},${edge.y2}`;
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

/** The one figure a box has room for: its bytes, or its line count without usage. */
function boxFigure(box: RouteBox): string {
  if (box.silent) return "unknown";
  if (box.bytes === undefined) return `${box.lines} ${box.lines === 1 ? "line" : "lines"}`;
  return `${box.measure === "relayed" ? "in " : ""}${formatBytes(box.bytes)}`;
}

function boxMeta(box: RouteBox): string {
  if (box.offFleet) return "outside the fleet";
  const lines = `${box.lines} ${box.lines === 1 ? "line" : "lines"}`;
  if (box.silent) return `traffic unknown, its collector is not reporting · ${lines}`;
  if (box.bytes === undefined) return lines;
  return `${formatBytes(box.bytes)} ${box.measure === "relayed" ? "relayed" : "out"} · ${lines}`;
}

function edgeName(edge: RouteEdge): string {
  const from = names.value.get(edge.from) ?? edge.from;
  const to = names.value.get(edge.to) ?? edge.to;
  const traffic = edge.bytes === undefined ? "traffic unknown" : `${formatBytes(edge.bytes)} in ${props.periodLabel}`;
  const states = edge.states.error || edge.states.warning
    ? [edge.states.error ? `${edge.states.error} with an error` : "", edge.states.warning ? `${edge.states.warning} with a warning` : ""].filter(Boolean).join(", ")
    : "every line healthy";
  return `${from} to ${to}${edge.offFleet ? ", outside the fleet" : ""}: ${edge.count} ${edge.count === 1 ? "line" : "lines"}, ${traffic}, ${states}`;
}

function boxName(box: RouteBox): string {
  return `${box.label}, ${boxMeta(box)}${box.offFleet ? "" : ". Open its lines."}`;
}

function choose(box: RouteBox): void {
  if (box.offFleet || !box.nodeID) return;
  emit("node", box.nodeID);
}

const legend = computed(() => {
  const items: Array<{ key: string; label: string; cls: string }> = [];
  const present = new Set(props.map.edges.map((edge) => edge.state));
  items.push({ key: "healthy", label: "every line healthy", cls: "healthy" });
  if (present.has("warning")) items.push({ key: "warning", label: "a line warns", cls: "warning" });
  if (present.has("error")) items.push({ key: "error", label: "a line errors", cls: "error" });
  if (props.map.edges.some((edge) => edge.offFleet)) items.push({ key: "off", label: "outside the fleet", cls: "off" });
  return items;
});
</script>

<template>
  <div ref="root" class="route-map">
    <ul class="graph-legend route-legend">
      <li><i class="route-legend-width" aria-hidden="true" /> width: {{ map.weightedBy === 'bytes' ? `bytes in ${periodLabel}` : 'number of lines (traffic unknown)' }}</li>
      <li v-for="item in legend" :key="item.key"><i class="route-legend-swatch" :data-state="item.cls" aria-hidden="true" /> {{ item.label }}</li>
    </ul>
    <div class="route-map-scroll">
      <svg
        class="route-map-figure"
        :width="renderWidth"
        :height="renderHeight"
        :viewBox="`0 0 ${map.width} ${totalHeight}`"
        role="group"
        :aria-label="`Route map: relay hubs on the left, the nodes they dial on the right. Stroke width is ${map.weightedBy === 'bytes' ? `bytes in ${periodLabel}` : 'the number of lines'}.`"
        :data-hover="hovered ? 'true' : undefined"
      >
        <g class="route-columns" aria-hidden="true">
          <text v-for="column in columns" :key="column.rank" :x="column.x" y="12">{{ column.label }}</text>
        </g>
        <g :transform="`translate(0 ${HEADER})`">
          <g class="route-edges">
            <path
              v-for="edge in map.edges"
              :key="edge.id"
              class="route-edge"
              :d="path(edge)"
              :data-state="edge.state"
              :data-off="edge.offFleet ? 'true' : undefined"
              :data-lit="touches(edge, hovered) ? 'true' : undefined"
              :style="{ strokeWidth: edge.width }"
            >
              <title>{{ edgeName(edge) }}</title>
            </path>
          </g>
          <g
            v-for="box in map.boxes"
            :key="box.id"
            class="route-box"
            :data-off="box.offFleet ? 'true' : undefined"
            :data-lit="hovered === box.id ? 'true' : undefined"
            :transform="`translate(${box.x} ${box.y})`"
            :role="box.offFleet ? 'img' : 'button'"
            :tabindex="box.offFleet ? undefined : 0"
            :aria-label="boxName(box)"
            @mouseenter="hovered = box.id"
            @mouseleave="hovered = undefined"
            @focus="hovered = box.id"
            @blur="hovered = undefined"
            @click="choose(box)"
            @keydown.enter.prevent="choose(box)"
            @keydown.space.prevent="choose(box)"
          >
            <rect :width="ROUTE_BOX_WIDTH" :height="ROUTE_BOX_HEIGHT" rx="4" />
            <text class="route-box-name" x="10" :y="ROUTE_BOX_HEIGHT / 2 + 4">{{ clip(box.label, box.offFleet ? 40 : 31) }}</text>
            <text v-if="!box.offFleet" class="route-box-meta" :data-unknown="box.silent || undefined" :x="ROUTE_BOX_WIDTH - 9" :y="ROUTE_BOX_HEIGHT / 2 + 4" text-anchor="end">{{ boxFigure(box) }}</text>
            <title>{{ boxName(box) }}</title>
          </g>
        </g>
      </svg>
    </div>
    <p v-if="scale < 1 && renderWidth > width" class="topology-graph-note" role="status">The map is wider than this panel at the smallest readable size, so it scrolls sideways.</p>
  </div>
</template>
