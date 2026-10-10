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
 * Widens a selection that ends inside a middle-cut value's copy to the whole
 * copy (MiddleText.vue calls it once a pointer selection is finished).
 *
 * The copy's glyphs are laid out uncut under a face that is cut, so a
 * selection that stops partway through the copy holds the value's hidden
 * middle while the face shows its tail highlighted: dragging across
 * `nd_01J8...M8P1R429` copied `nd_01J8...F9H2`. `user-select: all` says the
 * copy is taken whole, and Chromium does so for a click and for most drags,
 * but not for every drag that starts or ends inside it. Returns whether it
 * changed the selection.
 */
export function widenToCopies(selection: Selection | null): boolean {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  const copyOf = (node: Node) => (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest(".mid-copy") ?? null;
  const first = copyOf(range.startContainer);
  const last = copyOf(range.endContainer);
  const wide = range.cloneRange();
  if (first) wide.setStart(first, 0);
  if (last) wide.setEnd(last, last.childNodes.length);
  if (wide.compareBoundaryPoints(Range.START_TO_START, range) === 0 && wide.compareBoundaryPoints(Range.END_TO_END, range) === 0) return false;
  selection.removeAllRanges();
  selection.addRange(wide);
  return true;
}
