/**
 * Keeps the selected layer tab in view.
 *
 * Below 620px the layer row is a segmented control that scrolls sideways and
 * is wider than a phone. A link or a reload onto a later layer (Attention,
 * Files, Shares) left its tab cut off or off screen, so the page did not say
 * which layer it was on. The row scrolls itself to show the selected tab on
 * mount and whenever the selection changes, and at no other time: a re-render
 * for anything else (the proof line's age ticks every second) must not snap
 * back a row the operator is swiping through.
 *
 * Only the row scrolls. scrollIntoView would also scroll the page and, in a
 * frame, the console around it.
 *
 * The rule itself is the chassis's revealSelectedTab (plugin-bridge 0.2.0),
 * the one PcLensTabs variant="layer" runs for the other plugin pages. This
 * page draws its own row, so it keeps the directive that calls it.
 */
import type { ObjectDirective } from "vue";
import { revealSelectedTab, type TabRow } from "@latticenet/plugin-bridge/chassis";

export { revealSelectedTab, type TabRow };

/** `v-reveal-selected="layer"` on the tab row: reveals on mount and when `layer` changes. */
export const vRevealSelected: ObjectDirective<HTMLElement, string> = {
  mounted: (el) => revealSelectedTab(el),
  updated: (el, binding) => {
    if (binding.value !== binding.oldValue) revealSelectedTab(el);
  },
};
