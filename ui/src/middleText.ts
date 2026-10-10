/**
 * Where to cut an identifier that differs at the end.
 *
 * End truncation keeps the head and drops the tail, which is right for prose
 * and wrong for identifiers minted from one template. ULIDs are time-ordered,
 * so two minted seconds apart share all but the last few characters; sibling
 * nodes are named `...-node-001-primary` and `...-node-007-primary`; managed
 * config paths differ in one directory near the end. Cut at the end, distinct
 * values read the same, and the hostile-content layout check counted 111 line
 * hashes showing as one.
 *
 * MiddleText.vue draws `head` and `tail` as two spans over a copy of the
 * whole value: the head gives way with an ellipsis and the tail never does,
 * so the value reads as `frankfurt-equin…-001-primary`. This module decides
 * the split (and widenToCopies below keeps a selection of the copy whole);
 * the width it is cut to is the browser's, so nothing here measures text.
 *
 * The tail is the part that tells siblings apart, chosen without knowing the
 * siblings:
 *
 *   1. From the last segment that carries a digit to the end, when that fits
 *      in MAX_TAIL. Numbered nodes, suffixed hosts (`VDS-cd1`) and paths with
 *      a numbered directory are told apart by their last number.
 *   2. Otherwise whole trailing segments, enough to reach MIN_TAIL, so a name
 *      that differs in its last word (`Frontier-VDS`, `Frontier-NAT`) keeps
 *      that word.
 *   3. Otherwise, for one long run with no separator (a bare ULID or hash),
 *      its last FIXED_TAIL characters.
 *
 * Segments are separated by the punctuation identifiers here use, and the
 * separator before the tail stays with the tail so the cut reads as a cut.
 */

const SEPARATOR = /[-_./:@\s]/;
/** Shorter values are left whole; there is nothing worth keeping apart. */
const SHORT = 12;
const MIN_TAIL = 5;
const MAX_TAIL = 26;
const FIXED_TAIL = 8;
/** The head keeps at least this much, or the value is not split at all. */
const MIN_HEAD = 4;

export interface MiddleSplit {
  head: string;
  tail: string;
}

export function splitTail(text: string): MiddleSplit {
  if (text.length <= SHORT) return { head: text, tail: "" };
  // Where each segment starts, counted with the separator in front of it.
  const starts: number[] = [];
  for (let i = 1; i < text.length; i += 1) {
    if (SEPARATOR.test(text[i - 1]) && !SEPARATOR.test(text[i])) starts.push(i - 1);
  }
  const fits = (at: number) => text.length - at <= MAX_TAIL && at >= MIN_HEAD;
  const widen = (at: number) => {
    let index = starts.indexOf(at);
    while (text.length - at < MIN_TAIL && index > 0 && fits(starts[index - 1])) at = starts[(index -= 1)];
    return at;
  };

  for (let index = starts.length - 1; index >= 0; index -= 1) {
    const at = starts[index];
    if (!fits(at)) break;
    const segment = text.slice(at, index + 1 < starts.length ? starts[index + 1] : text.length);
    if (/\d/.test(segment)) return cut(text, widen(at));
  }
  const last = starts[starts.length - 1];
  if (last !== undefined && fits(last)) return cut(text, widen(last));
  return cut(text, text.length - FIXED_TAIL);
}

function cut(text: string, at: number): MiddleSplit {
  // Never between the two halves of a surrogate pair.
  const code = text.charCodeAt(at);
  if (code >= 0xdc00 && code <= 0xdfff) at -= 1;
  return { head: text.slice(0, at), tail: text.slice(at) };
}

/**
 * Widens a selection with an end in or against a middle-cut value to the
 * whole value (MiddleText.vue calls it once a pointer selection is finished).
 *
 * When the value is cut, the copy's glyphs are laid out whole with its end
 * under the face's tail, so a selection that stops partway through the copy
 * holds a stretch the face does not show there: dragging across
 * `nd_01J8...M8P1R429` copied `nd_01J8...F9H2`. So a selection end anywhere
 * in the value's box (the copy, the face, or between them) moves to that end
 * of the copy. So does an end placed right after the value's box, or a start
 * right before it, where a browser can put a press in the cell's padding: the
 * box is a block, and a selection that ends after it copies a line break the
 * cell never showed.
 *
 * A pointer drag along a cut value can also end as a caret in its copy: the
 * copy's hidden head lies under the cell's left padding, and a press there
 * is placed in it, sometimes as a caret the drag then carries along. With
 * the drag given, a caret left in a copy by a drag that crossed that value's
 * box within its cell takes the whole value. A click, or a drag over empty
 * space beside a value, still selects nothing. Returns whether it changed
 * the selection.
 */
export function widenToCopies(selection: Selection | null, drag?: PointerDrag): boolean {
  if (!selection || selection.rangeCount !== 1) return false;
  if (selection.isCollapsed) return drag ? takeCrossedValue(selection, drag) : false;
  const range = selection.getRangeAt(0);
  const first = copyAt(range.startContainer, range.startOffset, "start");
  const last = copyAt(range.endContainer, range.endOffset, "end");
  const wide = range.cloneRange();
  // Never past the other end: a value that only touches the selection from outside stays out.
  if (first && range.comparePoint(first, 0) <= 0) wide.setStart(first, 0);
  if (last && range.comparePoint(last, last.childNodes.length) >= 0) wide.setEnd(last, last.childNodes.length);
  if (wide.compareBoundaryPoints(Range.START_TO_START, range) === 0 && wide.compareBoundaryPoints(Range.END_TO_END, range) === 0) return false;
  selection.removeAllRanges();
  selection.addRange(wide);
  return true;
}

/**
 * Marks each middle-cut value the selection holds whole (`data-whole-selected`)
 * and unmarks the rest (MiddleText.vue calls it on every selection change).
 *
 * The face is not selectable, so an engine never draws it in the selection's
 * text colour. Where the platform draws selected text in that colour, or under
 * forced colours, styles.css draws a marked value's face in it, so the value
 * reads like the selected text beside it rather than as muted grey on the
 * selection colour. A value only partly selected (mid-drag, or by the
 * keyboard) is not marked: the highlight then covers only part of its box.
 */
export function markWholeSelected(doc: Document): void {
  const selection = doc.getSelection();
  const whole = new Set<Element>();
  for (let index = 0; index < (selection?.rangeCount ?? 0); index += 1) {
    const range = selection!.getRangeAt(index);
    if (range.collapsed) continue;
    const common = range.commonAncestorContainer;
    const scope = common.nodeType === 1 ? (common as Element) : common.parentElement;
    const own = scope?.closest(".mid-text");
    for (const value of own ? [own] : Array.from(scope?.querySelectorAll(".mid-text") ?? [])) {
      // Its text, not its element's edges: a selection from offset 0 of the text holds the value whole.
      const text = value.querySelector(":scope > .mid-copy")?.firstChild;
      if (text && range.comparePoint(text, 0) === 0 && range.comparePoint(text, text.textContent?.length ?? 0) === 0) whole.add(value);
    }
  }
  for (const value of Array.from(doc.querySelectorAll(".mid-text[data-whole-selected]"))) {
    if (!whole.has(value)) value.removeAttribute("data-whole-selected");
  }
  for (const value of whole) value.setAttribute("data-whole-selected", "");
}

/** Where a pointer went down and came up, in viewport coordinates. */
export interface PointerDrag {
  from: { x: number; y: number };
  to: { x: number; y: number };
}

/** Under this horizontal travel a pointer clicked rather than dragged. */
const DRAG_MIN = 3;

function takeCrossedValue(selection: Selection, drag: PointerDrag): boolean {
  if (Math.abs(drag.to.x - drag.from.x) < DRAG_MIN || !selection.anchorNode) return false;
  const copy = copyAt(selection.anchorNode, selection.anchorOffset, "end") ?? copyAt(selection.anchorNode, selection.anchorOffset, "start");
  const value = copy?.parentElement;
  if (!copy || !value) return false;
  const box = value.getBoundingClientRect();
  const cell = (value.closest("td, th, li") ?? value.parentElement ?? value).getBoundingClientRect();
  const within = (y: number) => y >= cell.top && y <= cell.bottom;
  const crossed = Math.min(drag.from.x, drag.to.x) < box.right && Math.max(drag.from.x, drag.to.x) > box.left;
  if (!crossed || !within(drag.from.y) || !within(drag.to.y)) return false;
  const range = copy.ownerDocument.createRange();
  range.selectNodeContents(copy);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/** The copy of the value a selection boundary is in, or directly against on the side it faces. */
function copyAt(node: Node, offset: number, edge: "start" | "end"): Element | null {
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  const value = element?.closest(".mid-text") ?? (node.nodeType === 1 ? node.childNodes[edge === "end" ? offset - 1 : offset] : undefined);
  return value?.nodeType === 1 && (value as Element).matches(".mid-text") ? (value as Element).querySelector(":scope > .mid-copy") : null;
}
