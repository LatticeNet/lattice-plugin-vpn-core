<script setup lang="ts">
/**
 * An identifier cut in the middle rather than at the end, so line hashes,
 * ULIDs, generated paths and node names minted from one template stay
 * distinguishable when the column is narrow (middleText.ts says where the cut
 * goes). The whole value is in the text, so it is copied and read aloud
 * entire; the title stays on the element that holds this, as before.
 *
 * `suffix` is appended after the identifier and is never cut either: a count
 * such as "+2" must not decide where the identifier itself is split.
 */
import { computed } from "vue";

import { splitTail } from "./middleText";

const props = withDefaults(defineProps<{ text: string; suffix?: string }>(), { suffix: "" });
const parts = computed(() => splitTail(props.text));
</script>

<template>
  <span class="mid-text"><span class="mid-head">{{ parts.head }}</span><span v-if="parts.tail || suffix" class="mid-tail">{{ parts.tail }}{{ suffix }}</span></span>
</template>
