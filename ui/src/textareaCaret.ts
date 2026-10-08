/**
 * textareaCaret.ts: where a character of a textarea's value is drawn, so a
 * selection made from code can be scrolled into view.
 *
 * A logical line number says nothing about the drawn position once lines
 * soft-wrap: a minified outbound is one line, and its fault can sit
 * hundreds of pixels down. The textarea does not expose its layout, so an
 * unseen copy with the same box and type is laid out instead and the
 * character's top is read from it.
 *
 * The copy never holds the paste. Letters and digits become "x" and
 * everything else is kept: in the editor's monospace face that is the same
 * width, and letters and digits break lines the same way among themselves,
 * so it wraps where the paste wraps without carrying a credential into the
 * DOM.
 */

const COPIED = [
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontFamily",
  "fontSize",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "letterSpacing",
  "lineHeight",
  "tabSize",
  "textIndent",
  "textTransform",
  "wordSpacing",
] as const;

/** The value with every letter and digit masked; same length, same breaks. */
export function maskForLayout(text: string): string {
  return text.replace(/[A-Za-z0-9]/g, "x");
}

/** The top of the character at `offset`, in the textarea's scroll coordinates. */
export function caretTop(el: HTMLTextAreaElement, offset: number): number {
  const style = getComputedStyle(el);
  const copy = document.createElement("div");
  copy.setAttribute("aria-hidden", "true");
  for (const name of COPIED) copy.style[name] = style[name];
  Object.assign(copy.style, {
    position: "absolute",
    top: "0",
    left: "-10000px",
    visibility: "hidden",
    overflow: "hidden",
    border: "0",
    boxSizing: "border-box",
    // The textarea's content box: clientWidth already leaves out its border and scrollbar.
    width: `${el.clientWidth}px`,
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    wordBreak: style.wordBreak,
  });
  const masked = maskForLayout(el.value);
  copy.textContent = masked.slice(0, offset);
  const mark = document.createElement("span");
  mark.textContent = masked.slice(offset, offset + 1) || "x";
  copy.append(mark);
  document.body.append(copy);
  try {
    return mark.offsetTop;
  } finally {
    copy.remove();
  }
}

/**
 * Scroll the textarea so the character at `offset` sits a third of the way
 * down its box, where a reader looks first.
 */
export function revealOffset(el: HTMLTextAreaElement, offset: number): void {
  el.scrollTop = Math.max(0, caretTop(el, offset) - el.clientHeight / 3);
}
