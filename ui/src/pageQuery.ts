/**
 * pageQuery.ts, the plugin document's own address bar.
 *
 * Layers, the open line and the table's grouping and search live in the
 * document's query string (`?view=lines&group=exit&open=lh_0042`), so a
 * reload of the frame lands on the same layer and object and a reviewer or an
 * agent can link a state. The frame runs sandboxed in an opaque origin, where
 * a browser may refuse `history.replaceState`; the write is best effort and
 * the page keeps its state in memory either way.
 *
 * The host builds the frame URL without a query today, so a reload of the
 * whole console starts the plugin on its default layer. Forwarding these keys
 * from the console's own address bar is a host change, not something a frame
 * can do for itself.
 */

export function currentQuery(): URLSearchParams {
  return new URLSearchParams(typeof location === "undefined" ? "" : location.search);
}

/** The value if it is one of `allowed`, otherwise the fallback. */
export function pick<T extends string>(value: string | null | undefined, allowed: readonly T[], fallback: T): T {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * Set or clear keys in the document's query string. An empty string or
 * undefined removes the key; a value equal to `defaults[key]` is removed too,
 * so the address stays short on the default layer.
 */
export function writeQuery(patch: Record<string, string | undefined>, defaults: Record<string, string> = {}): void {
  if (typeof location === "undefined" || typeof history === "undefined") return;
  const query = currentQuery();
  for (const [key, value] of Object.entries(patch)) {
    if (!value || value === defaults[key]) query.delete(key);
    else query.set(key, value);
  }
  const search = query.toString();
  const next = `${location.pathname}${search ? `?${search}` : ""}${location.hash}`;
  try {
    history.replaceState(history.state, "", next);
  } catch {
    // An opaque-origin frame may refuse; the state stays in memory.
  }
}
