<script lang="ts">
import { widenToCopies } from "./middleText";

/* One listener for every instance, after the browser has placed the
 * selection a pointer made. */
if (typeof document !== "undefined") document.addEventListener("pointerup", () => widenToCopies(document.getSelection()));
</script>

<script setup lang="ts">
/**
 * An identifier cut in the middle rather than at the end, so line hashes,
 * ULIDs, generated paths and node names minted from one template stay
 * distinguishable when the column is narrow (middleText.ts says where the cut
 * goes). The title stays on the element that holds this, as before.
 *
 * Two layers, because the cut cannot be the text. The face is two flex items,
 * and a browser turns block boxes into text with a break between them:
 * selecting a cut node name copied "...-cluster-node\n-017-primary", the
 * accessible name carried a space at the cut, and find-in-page no longer
 * matched the value. So the face is only drawn: hidden from assistive
 * technology, not selectable, and transparent to the pointer. The copy is
 * the value once, whole, in a transparent layer over the same box. It is
 * what a screen reader reads, what find-in-page matches, and what the pointer
 * selects, as one unit: its glyphs are laid out uncut under a face that is
 * cut, so a word or a stretch picked by position is not the one the face
 * shows there. `user-select: all` makes a click or a double-click take the
 * whole value, and widenToCopies() finishes the drags Chromium leaves partial.
 * styles.css has the rules.
 *
 * `suffix` is appended after the identifier and is never cut either: a count
 * such as "+2" must not decide where the identifier itself is split.
 */
import { computed } from "vue";

import { splitTail } from "./middleText";

const props = withDefaults(defineProps<{ text: string; suffix?: string }>(), { suffix: "" });
/* The face collapses runs of white space as the end-truncated cell it
 * replaced did (`nowrap`), so a tab or a newline in an operator-chosen name
 * cannot make a row two lines tall under `white-space: pre`. The copy keeps
 * the value exactly. */
const parts = computed(() => splitTail(props.text.replace(/\s+/g, " ").trim()));
</script>

<template>
  <span class="mid-text"><span class="mid-copy">{{ text }}{{ suffix }}</span><span class="mid-face" aria-hidden="true"><span class="mid-head">{{ parts.head }}</span><span v-if="parts.tail || suffix" class="mid-tail">{{ parts.tail }}{{ suffix }}</span></span></span>
</template>
