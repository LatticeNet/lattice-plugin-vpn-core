/**
 * identityLinkModel.ts, what one identity's subscription link serves and why.
 *
 * The server owns every decision (lattice-server identity_link.go): which
 * bound lines go in, which are left out and the fix for each, and what a
 * fetch gets now. users-admin link_get reports that without the token. This
 * module turns the report into the sentences the panel shows, so the panel
 * holds no rules of its own and the wording is testable away from the view.
 *
 * The token reaches this page only from link_reveal, which the console
 * answers after the operator's step-up, and it is held in the panel, never
 * in page state, the address or a log.
 */
import { formatAge } from "./observedAge";
import { formatDay } from "./usersModel";

export type LinkAnswer = "nodes" | "placeholder" | "decoy";
export type LinkAnswerReason =
  | "active"
  | "no_lines"
  | "transient_empty"
  | "disabled"
  | "operator"
  | "expiry"
  | "quota"
  | "link_disabled"
  | "link_expired"
  | "not_issued";

export type LinkLineReason =
  | "binding_disabled"
  | "line_unknown"
  | "managed_line_unsupported"
  | "protocol_unsupported"
  | "credential_not_applied"
  | "rotation_not_applied"
  | "credential_unknown"
  | "parked_on_line"
  | "no_client_template"
  | "template_lossy"
  | "template_unusable"
  | "service_down";

export type LinkFix =
  | "plan_add"
  | "plan_update"
  | "wait_for_discovery"
  | "wait_for_template"
  | "resume"
  | "check_line_service"
  | "wait_for_line_uuid";

export interface LinkLine {
  line_hash_id: string;
  node_id?: string;
  node_name?: string;
  line_name?: string;
  protocol?: string;
  reason?: LinkLineReason | string;
  fix?: LinkFix | string;
  /** What a reason needs spelled out, such as the parameters a lossy template dropped. Never a value. */
  detail?: string;
}

/** The link as every identity view carries it: route facts, never the token. */
export interface LinkSummary {
  slug: string;
  enabled: boolean;
  issued_at: string;
  rotated_at?: string;
  expires_at?: string;
  update_interval_hours: number;
}

export interface LinkFetch {
  at: string;
  ua_class: string;
  answer: LinkAnswer | string;
}

export interface LinkFormats {
  native: string[];
  converted: string[];
  convert_available: boolean;
  fallback?: string;
}

/** users-admin link_get, link_issue, link_set, link_revoke and link_rotate. */
export interface LinkStatus {
  identity_id: string;
  issued: boolean;
  link?: LinkSummary;
  answer: LinkAnswer | string;
  answer_reason: LinkAnswerReason | string;
  placeholder?: string;
  subscription_userinfo?: string;
  included: LinkLine[];
  excluded: LinkLine[];
  formats: LinkFormats;
  /** The last fetch since the server started; memory only on the server. */
  last_fetch?: LinkFetch;
}

/** users-admin link_reveal, after the console's step-up. */
export interface LinkReveal {
  kind: "identity";
  id: string;
  slug: string;
  token: string;
  path: string;
  url?: string;
}

export type LinkTone = "healthy" | "warning" | "error" | "neutral";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function lineOf(value: unknown): LinkLine | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const hash = text(record.line_hash_id);
  if (!hash) return undefined;
  const line: LinkLine = { line_hash_id: hash };
  for (const key of ["node_id", "node_name", "line_name", "protocol", "reason", "fix", "detail"] as const) {
    const field = text(record[key]);
    if (field) line[key] = field;
  }
  return line;
}

function linesOf(value: unknown): LinkLine[] {
  return Array.isArray(value) ? value.map(lineOf).filter((line): line is LinkLine => !!line) : [];
}

function setTime(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const at = Date.parse(raw);
  // Go writes an unset time as year 1.
  return Number.isFinite(at) && at > Date.UTC(1971, 0, 1) ? raw : undefined;
}

/**
 * The server's answer read defensively: a field missing from an older or
 * partial answer becomes the empty value rather than a crash, and anything
 * that is not a status at all is undefined, which the panel shows as an
 * error rather than as "no link".
 */
export function parseLinkStatus(value: unknown): LinkStatus | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const identity = text(record.identity_id);
  if (!identity || typeof record.issued !== "boolean") return undefined;
  const status: LinkStatus = {
    identity_id: identity,
    issued: record.issued,
    answer: text(record.answer) || "decoy",
    answer_reason: text(record.answer_reason) || (record.issued ? "active" : "not_issued"),
    included: linesOf(record.included),
    excluded: linesOf(record.excluded),
    formats: { native: [], converted: [], convert_available: false },
  };
  const link = record.link;
  if (record.issued && link && typeof link === "object") {
    const raw = link as Record<string, unknown>;
    const hours = Number(raw.update_interval_hours);
    status.link = {
      slug: text(raw.slug),
      enabled: raw.enabled !== false,
      issued_at: text(raw.issued_at),
      update_interval_hours: Number.isInteger(hours) && hours > 0 ? hours : 2,
      ...(setTime(raw.rotated_at) ? { rotated_at: setTime(raw.rotated_at) } : {}),
      ...(setTime(raw.expires_at) ? { expires_at: setTime(raw.expires_at) } : {}),
    };
  }
  const placeholder = text(record.placeholder);
  if (placeholder) status.placeholder = placeholder;
  const userinfo = text(record.subscription_userinfo);
  if (userinfo) status.subscription_userinfo = userinfo;
  const formats = record.formats;
  if (formats && typeof formats === "object") {
    const raw = formats as Record<string, unknown>;
    const list = (value: unknown) => (Array.isArray(value) ? value.map(text).filter(Boolean) : []);
    status.formats = {
      native: list(raw.native),
      converted: list(raw.converted),
      convert_available: raw.convert_available === true,
      ...(text(raw.fallback) ? { fallback: text(raw.fallback) } : {}),
    };
  }
  const fetch = record.last_fetch;
  if (fetch && typeof fetch === "object") {
    const raw = fetch as Record<string, unknown>;
    const at = setTime(raw.at);
    if (at) status.last_fetch = { at, ua_class: text(raw.ua_class) || "other", answer: text(raw.answer) || "nodes" };
  }
  return status;
}

export function parseLinkReveal(value: unknown): LinkReveal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const path = text(record.path);
  const token = text(record.token);
  if (!path.startsWith("/sub/") || !token) return undefined;
  const url = text(record.url);
  return {
    kind: "identity",
    id: text(record.id),
    slug: text(record.slug),
    token,
    path,
    ...(url ? { url } : {}),
  };
}

// ── what the link answers now ────────────────────────────────────────────

export type LinkStateKey = "none" | "active" | "placeholder" | "empty" | "paused" | "expired";

export interface LinkHeadline {
  key: LinkStateKey;
  tone: LinkTone;
  title: string;
  detail: string;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The one sentence at the top of the section: what a client fetching the
 * link gets right now, and why. The route facts (no link, paused, expired)
 * come first because they decide before the identity's own state does.
 */
export function linkHeadline(status: LinkStatus): LinkHeadline {
  if (!status.issued || status.answer_reason === "not_issued") {
    return { key: "none", tone: "neutral", title: "No link", detail: "This identity has no subscription link. Issue one to hand it to a client." };
  }
  if (status.answer_reason === "link_disabled") {
    return {
      key: "paused",
      tone: "warning",
      title: "Paused",
      detail: "The link answers like an unknown URL until you resume it. Clients keep the servers they already have.",
    };
  }
  if (status.answer_reason === "link_expired") {
    const at = status.link?.expires_at ? Date.parse(status.link.expires_at) : Number.NaN;
    const when = Number.isFinite(at) ? ` on ${formatDay(new Date(at))}` : "";
    return {
      key: "expired",
      tone: "error",
      title: "Link expired",
      detail: `The link expired${when} and answers like an unknown URL. Clear or move the expiry to serve it again.`,
    };
  }
  const placeholder = status.placeholder ? `one entry named "${status.placeholder}"` : "one placeholder entry";
  if (status.answer === "placeholder") {
    const why = ({
      disabled: "The identity is turned off",
      operator: "The identity is suspended",
      expiry: "The identity has expired",
      quota: "The identity is over its quota",
      no_lines: "The identity is bound to no line",
    } as Record<string, string>)[status.answer_reason] ?? "The identity is not in service";
    return {
      key: "placeholder",
      tone: "warning",
      title: "Serving a placeholder",
      detail: `${why}, so a client gets ${placeholder} and no servers, with its quota shown as used up.`,
    };
  }
  if (status.answer === "decoy") {
    const left = status.excluded.length;
    return {
      key: "empty",
      tone: "error",
      title: "Serving nothing",
      detail: `Every bound line is left out right now (${plural(left, "line", "lines")}, below), so a fetch gets an empty answer and the client keeps its last list.`,
    };
  }
  const served = status.included.length;
  const left = status.excluded.length;
  return {
    key: "active",
    tone: left ? "warning" : "healthy",
    title: "Active",
    detail: left
      ? `Serves ${plural(served, "line", "lines")}; ${plural(left, "bound line is", "bound lines are")} left out, each with the reason below.`
      : `Serves ${plural(served, "line", "lines")}, every line this identity is bound to.`,
  };
}

// ── the last fetch ───────────────────────────────────────────────────────

const UA_FAMILIES: Record<string, string> = {
  clashmeta: "mihomo (Clash Verge, FlClash)",
  clash: "Clash",
  stash: "Stash",
  singbox: "sing-box",
  shadowrocket: "Shadowrocket",
  surge: "Surge",
  quantumultx: "Quantumult X",
  egern: "Egern",
  loon: "Loon",
  other: "an unrecognised client",
};

/** The client family the server classified a fetch's User-Agent into. */
export function clientFamily(uaClass: string): string {
  return UA_FAMILIES[uaClass] ?? UA_FAMILIES.other;
}

export type FetchFreshness = "fresh" | "stale" | "never";

export interface FetchLine {
  freshness: FetchFreshness;
  tone: LinkTone;
  text: string;
  /** The absolute time, for a title. */
  title: string;
}

/**
 * When the link was last fetched, by what, and what it got. Fresh means
 * within twice the refresh the link advertises: a client past that has
 * missed at least one refresh, so it is off, offline or failing.
 *
 * The server keeps the last fetch in memory, so "never" honestly means
 * "not since the server last started", and says so.
 */
export function fetchLine(status: LinkStatus, now: number): FetchLine {
  const fetch = status.last_fetch;
  if (!fetch) {
    return {
      freshness: "never",
      tone: "neutral",
      text: status.issued ? "Not fetched since the server last started" : "Never fetched",
      title: "The server keeps the last fetch in memory only, so a restart clears it.",
    };
  }
  const at = Date.parse(fetch.at);
  const age = Math.max(0, now - at);
  const interval = (status.link?.update_interval_hours ?? 2) * 3_600_000;
  const freshness: FetchFreshness = age <= interval * 2 ? "fresh" : "stale";
  const got = ({ nodes: "got the servers", placeholder: "got the placeholder", decoy: "got nothing" } as Record<string, string>)[fetch.answer] ?? "got an answer";
  return {
    freshness,
    tone: freshness === "fresh" ? "healthy" : "warning",
    text: `Fetched ${formatAge(age)} ago by ${clientFamily(fetch.ua_class)}, ${got}`,
    title: new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(at)),
  };
}

// ── lines left out ───────────────────────────────────────────────────────

const REASONS: Record<string, string> = {
  binding_disabled: "the binding is turned off",
  line_unknown: "no node reports this line now",
  managed_line_unsupported: "managed lines are not served in identity links yet",
  protocol_unsupported: "its protocol cannot carry a credential per identity",
  credential_not_applied: "this identity's credential was never applied on the line",
  rotation_not_applied: "the line still has this identity's old credential",
  credential_unknown: "the line's user id is not known yet",
  parked_on_line: "the identity is parked (suspended) on this line",
  no_client_template: "no client template has been read for this line",
  template_lossy: "the client template would drop parameters",
  template_unusable: "the client template cannot be used",
  service_down: "the line's service is down on its node",
};

/** Why a bound line is left out, as a clause. */
export function excludedReason(line: LinkLine): string {
  const reason = REASONS[line.reason ?? ""] ?? (line.reason ? line.reason.replace(/_/g, " ") : "left out");
  return line.detail ? `${reason} (${line.detail})` : reason;
}

export type FixAction = "plan_add" | "plan_update";

export interface LinkFixView {
  /** A plan the panel can file for this line, or none when the fix is waiting or elsewhere. */
  action?: FixAction;
  label: string;
}

/**
 * The way back in for a line left out. Two fixes are plans this page can
 * file (they still need approval in the console); the rest are waits or
 * work elsewhere, and say so.
 */
export function linkFix(line: LinkLine): LinkFixView | undefined {
  // The server names no fix for a binding turned off in Lattice; Turn on in
  // the Lines section is the way back.
  if (line.reason === "binding_disabled" && !line.fix) return { label: "turn the binding on in Lines below" };
  switch (line.fix) {
    case "plan_add": return { action: "plan_add", label: "Add to line" };
    case "plan_update": return { action: "plan_update", label: "Update on line" };
    case "wait_for_discovery": return { label: "waits for the node to report the line" };
    case "wait_for_template": return { label: "waits for the next discovery to read a template" };
    case "wait_for_line_uuid": return { label: "waits for discovery to report the line's user id" };
    case "resume": return { label: "comes back when the identity is resumed" };
    case "check_line_service": return { label: "check the service on its node" };
    default: return undefined;
  }
}

export function lineTitle(line: LinkLine): string {
  const node = line.node_name || line.node_id || "";
  const name = line.line_name || line.line_hash_id;
  return node ? `${node} / ${name}` : name;
}

// ── the revealed link ────────────────────────────────────────────────────

/**
 * The full URL of a revealed link. The server answers `url` when it knows
 * its public address; otherwise the link is served on the console's own
 * origin, which this frame knows from its host_origin.
 */
export function revealedUrl(reveal: LinkReveal, hostOrigin: string | null): string {
  if (reveal.url) return reveal.url;
  return hostOrigin ? `${hostOrigin}${reveal.path}` : reveal.path;
}

/** The link with its token cut to the ends, for showing beside Copy. */
export function maskedUrl(url: string): string {
  const at = url.lastIndexOf("/");
  if (at < 0) return url;
  const token = url.slice(at + 1);
  if (token.length <= 10) return url;
  return `${url.slice(0, at + 1)}${token.slice(0, 4)}…${token.slice(-4)}`;
}

/** The path a link is served under, with no token: what a list may show. */
export function linkPathHint(summary: Pick<LinkSummary, "slug">): string {
  return `/sub/${summary.slug}/…`;
}

export interface ClientLink {
  id: string;
  label: string;
  url: string;
  /** Said beside a link the server serves as the base64 list instead. */
  note?: string;
}

const CLIENT_LABELS: Record<string, string> = {
  ClashMeta: "mihomo (Clash Verge, FlClash)",
  Clash: "Clash",
  Stash: "Stash",
  "sing-box": "sing-box",
  Surge: "Surge",
  SurgeMac: "Surge Mac",
  Loon: "Loon",
  QX: "Quantumult X",
  Shadowrocket: "Shadowrocket",
  Egern: "Egern",
  Surfboard: "Surfboard",
  JSON: "JSON",
};

/**
 * The per-client links. The bare URL is the base64 URI list most clients
 * import; format=plain is the same list unencoded. A converted target is
 * offered only when the server says a converter is available, because
 * without one it serves the base64 list under that name.
 */
export function clientLinks(url: string, formats: LinkFormats): ClientLink[] {
  const links: ClientLink[] = [
    { id: "base64", label: "Universal (base64 URI list)", url },
    { id: "plain", label: "Plain URI list", url: `${url}?format=plain` },
  ];
  if (formats.convert_available) {
    for (const target of formats.converted) {
      links.push({ id: target, label: CLIENT_LABELS[target] ?? target, url: `${url}?target=${encodeURIComponent(target)}` });
    }
  }
  return links;
}

/** The sentence under the client links when the converter is missing. */
export function convertNote(formats: LinkFormats): string {
  if (formats.convert_available) return "";
  return "No converter is available on this server, so a client that asks for its own format gets the base64 URI list instead (the response says so in a header).";
}

// ── who may see the section ──────────────────────────────────────────────

export interface LinkErrorLike {
  /** The console's own class for a refused call (BridgeCallError.code). */
  code?: string;
  message?: string;
  apiCode?: string;
  httpStatus?: number;
}

/**
 * A refusal for want of authority, told apart from a failure: the console
 * forwards the server's error code and status (bridge additive fields); an
 * older console forwards only the message.
 */
export function isPermissionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as LinkErrorLike;
  if (value.apiCode === "capability_denied" || value.httpStatus === 403) return true;
  return /capability_denied|requires vpncore:admin|not allowed|forbidden/i.test(value.message ?? "");
}

/** The step-up was refused, cancelled, or the console cannot run one. */
export function isStepUpError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as LinkErrorLike;
  return value.apiCode === "step_up_required" || /step_up_required|step-up/i.test(value.message ?? "");
}

/**
 * What to say when a reveal is refused for want of a step-up, or undefined for
 * any other failure. A console with the plugin step-up path answers with the
 * code step_up_required (the operator cancelled, or the grant had lapsed by
 * the time the call was repeated), and revealing again can succeed. A console
 * without it passes the server's refusal on as a plain message, and revealing
 * again from it cannot, so it says so instead of inviting a retry.
 */
export function revealRefusalText(error: unknown): string | undefined {
  if (!isStepUpError(error)) return undefined;
  const value = error as LinkErrorLike;
  if (value.code === "step_up_required" || value.apiCode === "step_up_required") {
    return "Nothing was revealed: the console's step-up did not complete. Reveal again and confirm with your authenticator or passkey.";
  }
  return "Nothing was revealed: this console cannot run the step-up a reveal needs, so revealing again from it will not work. Update the console, then reveal the link.";
}

/** How long a link was issued or rotated, for the facts row. */
export function linkAge(at: string | undefined, now: number): string {
  if (!at) return "";
  const when = Date.parse(at);
  if (!Number.isFinite(when) || when <= Date.UTC(1971, 0, 1)) return "";
  return `${formatAge(Math.max(0, now - when))} ago`;
}

/**
 * The link as a row in the identity list shows it: whether one is issued and
 * whether it answers. What it serves and when it was fetched need the
 * identity's own read, in its panel.
 */
export function linkBadge(summary: Pick<LinkSummary, "enabled" | "expires_at"> | null | undefined, now: number): { text: string; tone?: "warning" | "error" } | undefined {
  if (!summary) return undefined;
  if (!summary.enabled) return { text: "link paused", tone: "warning" };
  const at = summary.expires_at ? Date.parse(summary.expires_at) : Number.NaN;
  if (Number.isFinite(at) && at > Date.UTC(1971, 0, 1) && at <= now) return { text: "link expired", tone: "error" };
  return { text: "link" };
}

function bytesText(value: number): string {
  const gib = value / 1024 ** 3;
  if (gib >= 1) return `${gib >= 100 ? gib.toFixed(0) : gib.toFixed(1)} GiB`;
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}

/**
 * The Subscription-Userinfo header a fetch gets now, said in words: what the
 * client's quota bar will show. A placeholder answer reports the quota as
 * used up on purpose, so clients show the identity as out of service.
 */
export function userinfoText(header: string | undefined, answer: string): string {
  if (!header) return "";
  const fields = new Map(header.split(";").map((part) => {
    const [key, value] = part.split("=").map((piece) => piece.trim());
    return [key, Number(value)] as const;
  }));
  const used = (fields.get("upload") || 0) + (fields.get("download") || 0);
  const total = fields.get("total") || 0;
  const expire = fields.get("expire") || 0;
  let out = total > 0 ? `${bytesText(used)} of ${bytesText(total)}` : `${bytesText(used)} used, no limit`;
  if (answer === "placeholder") out += ", shown as used up";
  if (expire > 0) out += `, expires ${formatDay(new Date(expire * 1000))}`;
  return out;
}
