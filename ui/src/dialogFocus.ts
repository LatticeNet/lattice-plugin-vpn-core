/**
 * Keep Tab inside a modal dialog.
 *
 * The dialogs here say aria-modal, and nothing kept the promise: in Delete
 * identity, with Delete disabled until the name is typed, Tab went from the
 * field to Cancel and then out of the frame into the console, where this
 * frame's Escape no longer reached. Past the last control Tab wraps to the
 * first, and Shift+Tab before the first wraps to the last. The same rule as
 * plugin-bridge's trapDialogTab; this page's dialogs are its own, not the
 * chassis's, so it keeps this copy until it moves onto the chassis.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function trapTab(event: KeyboardEvent, root: HTMLElement): void {
  if (event.key !== "Tab" || event.defaultPrevented) return;
  const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("[hidden], [inert]"));
  if (!focusable.length) {
    event.preventDefault();
    root.focus();
    return;
  }
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const target = event.target instanceof Node ? event.target : null;
  const inside = !!target && root.contains(target);
  if (event.shiftKey && (!inside || target === first || target === root)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (!inside || target === last || target === root)) {
    event.preventDefault();
    first.focus();
  }
}
