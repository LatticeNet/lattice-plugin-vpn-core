/**
 * navigate.ts, asking the console to change views from inside the frame.
 *
 * The bridge has no navigate capability and the frame is sandboxed, so the one
 * channel that exists is a postMessage to the host window. The console listens
 * for `lattice:navigate`, checks the route against its allowlist of internal
 * paths and query keys, and routes itself. Nothing is read back.
 *
 * The target origin is the `host_origin` the frame URL fragment carries, the
 * same value the bridge validates and pins for inbound messages, so a navigate
 * request can only ever go to the host this frame was embedded by.
 */

export const NAVIGATE_MESSAGE_TYPE = "lattice:navigate";

export type EvidenceLens = "connections" | "log";

/**
 * The host's Evidence area opened on one lens with a node, and optionally one
 * line, pre-filtered. `line_uuid` is the key the Connections lens reads; a
 * line without a uuid links to its node only, which is still the right page.
 */
export function evidenceRoute(nodeID: string, lens: EvidenceLens, lineUUID?: string): string {
  const query = new URLSearchParams();
  query.set("node_id", nodeID);
  if (lens !== "connections") query.set("lens", lens);
  if (lineUUID?.trim()) query.set("line_uuid", lineUUID.trim());
  return `/platform/evidence?${query.toString()}`;
}

/**
 * The host origin from the frame URL fragment, or null when there is nothing
 * trustworthy to post to. Fail-closed, mirroring the bridge: an absent or
 * non-http(s) value is not an origin, it is a reason to stay silent.
 */
export function hostOriginFromHash(hash: string): string | null {
  const raw = new URLSearchParams(hash.replace(/^#/, "")).get("host_origin")?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.origin;
}

/** Fire-and-forget: the console answers by navigating, not by replying. */
export function postNavigate(win: Window, route: string, hostOrigin: string): void {
  win.parent.postMessage({ type: NAVIGATE_MESSAGE_TYPE, route }, hostOrigin);
}
