/**
 * Where an overlay has to appear when the document is not a viewport.
 *
 * The host sizes this plugin's iframe to the height the plugin reports, so the
 * frame is as tall as its own content and the browser viewport scrolls the
 * parent document instead. Two consequences drive everything here.
 *
 * `position: fixed` resolves against the frame, not against what the operator
 * can see. On the Lines view the frame is around 2400px tall inside a 1500px
 * window, so a sheet centred with `inset: 0` lands roughly 1200px down: far
 * below the fold, and the click reads as doing nothing.
 *
 * `vh` units have the same defect. `calc(100vh - 40px)` on that frame resolves
 * to 2360px, which is not a ceiling at all. And `position: sticky` never
 * activates, because sticky needs a scrollport and the frame has none.
 *
 * So overlays are positioned in DOCUMENT coordinates, anchored to whatever the
 * operator just clicked, and capped in px. The frame does not scroll, so an
 * element that was visible enough to click is still visible.
 *
 * Ported from lattice-plugin-sub-store/ui/src/overlayAnchor.ts. Kept
 * DOM-independent (the event target is duck-typed) so the tests run without
 * jsdom.
 */

/** How far above the anchor an overlay starts, so the trigger stays visible. */
const ANCHOR_OFFSET = 8;
/** Never open flush against the document top; the page header lives there. */
export const MIN_ANCHOR_TOP = 12;

/**
 * The document-space Y an overlay opened from `event` should use.
 *
 * Falls back to the current scroll offset when there is no event (a keyboard
 * shortcut, or an overlay opened programmatically), which is the top of what
 * the operator can see in every case except a frame the host has scrolled
 * past, and that case has no better answer from inside the sandbox.
 */
export function anchorTopFrom(event?: Event | null): number {
  const scrollY = typeof window === "undefined" ? 0 : window.scrollY;
  // currentTarget first, for a handler bound to the control itself; then
  // target, because a document-level capture listener (which is how every
  // overlay in this plugin learns where the operator clicked) sees
  // currentTarget === document, and a document cannot be measured.
  for (const candidate of [event?.currentTarget, event?.target]) {
    const element = candidate as { getBoundingClientRect?: () => { top: number } } | null | undefined;
    if (element && typeof element.getBoundingClientRect === "function") {
      return Math.max(MIN_ANCHOR_TOP, element.getBoundingClientRect().top + scrollY - ANCHOR_OFFSET);
    }
  }
  return Math.max(MIN_ANCHOR_TOP, scrollY + ANCHOR_OFFSET);
}

/**
 * Clamp an overlay so it cannot start below the content it has to be read
 * against. `documentHeight` is the frame height the host already knows.
 */
export function clampAnchorTop(
  top: number,
  overlayHeight = 0,
  documentHeight = typeof document === "undefined" ? 0 : document.documentElement.scrollHeight,
): number {
  const maxTop = Math.max(MIN_ANCHOR_TOP, documentHeight - overlayHeight - MIN_ANCHOR_TOP);
  return Math.min(Math.max(MIN_ANCHOR_TOP, top), maxTop);
}

/**
 * True when a click landed inside an open overlay. The recorded anchor must
 * not move while an overlay is open, or the next overlay opens against a
 * position the operator never pointed at.
 */
export function isInsideOverlay(target: unknown, selector = ".overlay-scrim"): boolean {
  const element = target as { closest?: (value: string) => unknown } | null;
  return typeof element?.closest === "function" && element.closest(selector) != null;
}
