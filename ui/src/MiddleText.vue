<script lang="ts">
import { markWholeSelected, widenToCopies } from "./middleText";

if (typeof document !== "undefined") {
  /* One pair of listeners for every instance: where the primary button went
   * down, and, once the browser has placed the selection that pointer made,
   * the widening. */
  let press: { x: number; y: number } | undefined;
  document.addEventListener("pointerdown", (event) => {
    press = event.button === 0 ? { x: event.clientX, y: event.clientY } : undefined;
  }, true);
  document.addEventListener("pointerup", (event) => {
    widenToCopies(document.getSelection(), press && { from: press, to: { x: event.clientX, y: event.clientY } });
    press = undefined;
  });
  document.addEventListener("selectionchange", () => markWholeSelected(document));
  /* Whether the platform paints selected text in a selection colour. Apple
   * platforms keep selected text in its own colour, in Chromium (the Mac
   * layout theme), WebKit and Gecko alike, so the transparent copy stays
   * transparent under the native highlight. Everywhere else the engine paints
   * selected text in the theme's selection foreground, whatever its colour
   * was, and the copy's uncut glyphs showed through the cut face. No media or
   * feature query exposes this, so the platform is the test; styles.css gives
   * the copy its own selection colours where it is set, and draws the face of
   * a value selected whole in the selection's text colour. */
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || "";
  if (!/mac|iphone|ipad|ipod/i.test(platform)) document.documentElement.dataset.selectionRecolours = "";
}
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
 * matched the value. Lifting the tail out of flow instead keeps the glyphs
 * real but splits the text the same way for find and the accessible name. So
 * the face is only drawn: hidden from assistive technology, not selectable,
 * and transparent to the pointer. The copy is the value once, whole, in a
 * transparent layer in the same box. It is what a screen reader reads, what
 * find-in-page matches, and what the pointer selects. styles.css has the
 * rules and says why each one is there.
 *
 * The copy selects as one unit: when the value is cut, its glyphs are laid out
 * whole with its end under the face's tail, so a word or a stretch picked by
 * position in the head is not the one the face shows there. A click selects
 * nothing, as on plain text; widenToCopies() widens a double-click or a drag
 * that ends inside a value to the whole value.
 *
 * `suffix` is appended after the identifier and is never cut either: a count
 * such as "+2" must not decide where the identifier itself is split.
 */
import { computed } from "vue";

import { splitTail } from "./middleText";

const props = withDefaults(defineProps<{ text: string; suffix?: string }>(), { suffix: "" });
/* Runs of white space collapse as they did in the end-truncated cell this
 * replaced (`nowrap`), so a tab or a newline in an operator-chosen name cannot
 * make a row two lines tall. That cell copied and read the collapsed text too,
 * so the copy holds it rather than the raw value; the title keeps the raw
 * value. */
const shown = computed(() => props.text.replace(/\s+/g, " ").trim());
const parts = computed(() => splitTail(shown.value));
</script>

<template>
  <span class="mid-text"><span class="mid-copy">{{ shown }}{{ suffix }}</span><span class="mid-face" aria-hidden="true"><span class="mid-head">{{ parts.head }}</span><span v-if="parts.tail || suffix" class="mid-tail">{{ parts.tail }}{{ suffix }}</span></span></span>
</template>
