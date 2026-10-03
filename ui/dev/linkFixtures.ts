/**
 * Identity links for the harness, answering like lattice-server's
 * users-admin link_* (identity_link_api.go): the same status shape, the same
 * answer table (route facts first, then the identity's policy, then its
 * lines), the same refusal codes. The data is invented and deterministic.
 *
 * Seeded per scenario so each state the panel has to show is one click away:
 * an active link fetched by mihomo a few minutes ago, one never fetched since
 * the server started, a paused one, an expired identity and an over-quota one
 * serving the placeholder, and identities with no link. Lines are left out in
 * the server's reasons, two of them with a plan the panel can file, and a
 * filed plan "applies" twenty seconds later so the watch can be seen landing.
 */

type Binding = { line_hash_id: string; enabled: boolean };
type User = Record<string, any> & { id: string; email: string; enabled: boolean; bindings: Binding[] };
type Line = { line_hash_id: string; name?: string; type?: string; protocol?: string };
type Group = { node_id: string; node_name: string; lines: Line[] };

interface StoredLink {
  slug: string;
  token: string;
  disabled: boolean;
  issued_at: string;
  rotated_at?: string;
  expires_at?: string;
  update_interval_hours: number;
  last_fetch?: { at: string; ua_class: string; answer: string };
}

export class LinkFixtureError extends Error {
  readonly apiCode: string;
  readonly httpStatus: number;
  constructor(httpStatus: number, apiCode: string, message: string) {
    super(message);
    this.apiCode = apiCode;
    this.httpStatus = httpStatus;
  }
}

const stores = new Map<string, Map<string, StoredLink>>();
const applied = new Map<string, number>();
const APPLY_AFTER_MS = 20_000;
const SUPPORTED = new Set(["vless", "vmess", "trojan", "hysteria2", "tuic", "anytls", "shadowsocks"]);

export function resetLinkStores(): void {
  stores.clear();
  applied.clear();
}

function randomish(seed: string, length: number): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyz23456789";
  let hash = 2166136261;
  let out = "";
  for (let i = 0; out.length < length; i++) {
    hash = Math.imul(hash ^ seed.charCodeAt(i % seed.length) ^ i, 16777619) >>> 0;
    out += alphabet[hash % alphabet.length];
  }
  return out;
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function seed(users: User[]): Map<string, StoredLink> {
  const links = new Map<string, StoredLink>();
  const bound = users.filter((user) => user.bindings.some((binding) => binding.enabled));
  const make = (user: User, extra: Partial<StoredLink> = {}) => {
    links.set(user.id, {
      slug: `u-${randomish(user.id, 10)}`,
      token: randomish(`${user.id}:token`, 43),
      disabled: false,
      issued_at: minutesAgo(60 * 24 * 9),
      update_interval_hours: 2,
      ...extra,
    });
  };
  const active = bound.filter((user) => user.enabled && !isExpired(user) && !isOverQuota(user));
  if (active[0]) make(active[0], { last_fetch: { at: minutesAgo(14), ua_class: "clashmeta", answer: "nodes" } });
  if (active[1]) make(active[1]);
  if (active[2]) make(active[2], { disabled: true, last_fetch: { at: minutesAgo(60 * 30), ua_class: "shadowrocket", answer: "nodes" } });
  if (active[3]) make(active[3], { rotated_at: minutesAgo(50), update_interval_hours: 6, last_fetch: { at: minutesAgo(60 * 15), ua_class: "singbox", answer: "nodes" } });
  for (const user of users.filter((value) => isExpired(value) || isOverQuota(value))) {
    make(user, { last_fetch: { at: minutesAgo(38), ua_class: "clashmeta", answer: "placeholder" } });
  }
  return links;
}

function isExpired(user: User): boolean {
  const at = user.expires_at ? Date.parse(user.expires_at) : Number.NaN;
  return Number.isFinite(at) && at > Date.UTC(1971, 0, 1) && at <= Date.now();
}

function isOverQuota(user: User): boolean {
  return !!user.quota_bytes && (user.used_period_bytes ?? 0) >= user.quota_bytes;
}

function storeFor(scenario: string, users: User[]): Map<string, StoredLink> {
  let store = stores.get(scenario);
  if (!store) {
    store = seed(users);
    stores.set(scenario, store);
  }
  return store;
}

function summaryOf(link: StoredLink | undefined) {
  if (!link) return undefined;
  return {
    slug: link.slug,
    enabled: !link.disabled,
    issued_at: link.issued_at,
    ...(link.rotated_at ? { rotated_at: link.rotated_at } : {}),
    ...(link.expires_at ? { expires_at: link.expires_at } : {}),
    update_interval_hours: link.update_interval_hours,
  };
}

function lineState(user: User, binding: Binding, index: number, lines: Map<string, { line: Line; group: Group }>) {
  const found = lines.get(binding.line_hash_id);
  const base = {
    line_hash_id: binding.line_hash_id,
    ...(found ? { node_id: found.group.node_id, node_name: found.group.node_name, line_name: found.line.name ?? binding.line_hash_id } : {}),
    ...(found ? { protocol: String(found.line.protocol ?? found.line.type ?? "vless").toLowerCase() } : {}),
  };
  if (!binding.enabled) return { ...base, reason: "binding_disabled" };
  if (!found) return { ...base, reason: "line_unknown", fix: "wait_for_discovery" };
  if (!SUPPORTED.has(base.protocol ?? "")) return { ...base, reason: "protocol_unsupported" };
  const key = `${user.id}|${binding.line_hash_id}`;
  const done = applied.get(key);
  const isApplied = done !== undefined && Date.now() >= done;
  if (!isApplied && index % 5 === 3) return { ...base, reason: "credential_not_applied", fix: "plan_add" };
  if (!isApplied && index % 7 === 5) return { ...base, reason: "rotation_not_applied", fix: "plan_update" };
  if (index % 11 === 9) return { ...base, reason: "template_lossy", fix: "wait_for_template", detail: "drops utls fingerprint, ech" };
  return base;
}

export function linkHandlers(scenario: string, users: User[], groups: Group[]) {
  const store = storeFor(scenario, users);
  const lines = new Map<string, { line: Line; group: Group }>();
  for (const group of groups) for (const line of group.lines) lines.set(line.line_hash_id, { line, group });
  const find = (id: unknown) => {
    const user = users.find((value) => value.id === String(id ?? "").trim());
    if (!user) throw new LinkFixtureError(404, "not_found", `no identity ${String(id)}`);
    return user;
  };

  const status = (user: User) => {
    // An applied add binds the identity to the line, as the server's task
    // result does (lineusers.go reconcileLineUserBinding).
    for (const [key, at] of applied) {
      const [owner, hash] = key.split("|");
      if (owner === user.id && Date.now() >= at && !user.bindings.some((binding) => binding.line_hash_id === hash)) {
        user.bindings.push({ line_hash_id: hash, enabled: true });
      }
    }
    const link = store.get(user.id);
    const included: unknown[] = [];
    const excluded: unknown[] = [];
    user.bindings.forEach((binding, index) => {
      const line = lineState(user, binding, index, lines);
      if ("reason" in line && line.reason) excluded.push(line);
      else included.push(line);
    });
    const boundLines = user.bindings.filter((binding) => binding.enabled).length;
    let answer = "nodes";
    let reason = "active";
    let placeholder: string | undefined;
    if (!user.enabled) [answer, reason, placeholder] = ["placeholder", "disabled", "Disabled by the operator"];
    else if (isExpired(user)) [answer, reason, placeholder] = ["placeholder", "expiry", `Expired on ${String(user.expires_at).slice(0, 10)}`];
    else if (isOverQuota(user)) [answer, reason, placeholder] = ["placeholder", "quota", "Quota used: 23.4 GiB of 20.0 GiB, resets 2026-11-01"];
    else if (!boundLines) [answer, reason, placeholder] = ["placeholder", "no_lines", "No lines assigned yet"];
    else if (!included.length) [answer, reason] = ["decoy", "transient_empty"];
    const used = Math.max(0, user.used_period_bytes ?? 0);
    const total = user.quota_bytes ?? 0;
    let userinfo: string | undefined = answer === "decoy" ? undefined
      : `upload=0; download=${answer === "placeholder" ? Math.max(used, total || 1) : used}; total=${answer === "placeholder" ? Math.max(used, total || 1) : total}; expire=0`;
    if (!link) [answer, reason, placeholder, userinfo] = ["decoy", "not_issued", undefined, undefined];
    else if (link.disabled) [answer, reason, placeholder, userinfo] = ["decoy", "link_disabled", undefined, undefined];
    return {
      identity_id: user.id,
      issued: !!link,
      ...(link ? { link: summaryOf(link) } : {}),
      answer,
      answer_reason: reason,
      ...(placeholder ? { placeholder } : {}),
      ...(userinfo ? { subscription_userinfo: userinfo } : {}),
      included,
      excluded,
      formats: {
        native: ["URI", "V2Ray"],
        converted: ["ClashMeta", "Clash", "Stash", "sing-box", "Surge", "SurgeMac", "Loon", "QX", "Shadowrocket", "Egern", "Surfboard", "JSON"],
        convert_available: true,
      },
      ...(link?.last_fetch ? { last_fetch: link.last_fetch } : {}),
    };
  };

  const plan = (op: string) => (payload: Record<string, any>) => {
    const user = find(payload.user_id);
    const hash = String(payload.line_hash_id ?? "");
    applied.set(`${user.id}|${hash}`, Date.now() + APPLY_AFTER_MS);
    const id = `apr_${op === "plan_add" ? "add" : "upd"}_${randomish(`${user.id}${hash}${Date.now()}`, 6)}`;
    const verb = op === "plan_add" ? "sb user add" : "sb user update";
    return { approval: { id, plan: JSON.stringify({ summary: `${verb} ${user.email} on ${lines.get(hash)?.line.name ?? hash}` }) } };
  };

  return {
    summaryFor: (id: string) => summaryOf(store.get(id)),
    "users-admin/link_get": (payload: Record<string, any>) => status(find(payload.user_id)),
    "users-admin/link_issue": (payload: Record<string, any>) => {
      const user = find(payload.user_id);
      if (store.has(user.id)) throw new LinkFixtureError(409, "link_already_issued", "this identity already has a link");
      store.set(user.id, {
        slug: `u-${randomish(`${user.id}${Date.now()}`, 10)}`,
        token: randomish(`${user.id}:${Date.now()}`, 43),
        disabled: false,
        issued_at: new Date().toISOString(),
        update_interval_hours: 2,
      });
      return status(user);
    },
    "users-admin/link_set": (payload: Record<string, any>) => {
      const user = find(payload.user_id);
      const link = store.get(user.id);
      if (!link) throw new LinkFixtureError(404, "link_not_issued", "this identity has no link");
      if (payload.enabled !== undefined) link.disabled = !payload.enabled;
      return status(user);
    },
    "users-admin/link_revoke": (payload: Record<string, any>) => {
      const user = find(payload.user_id);
      if (!store.delete(user.id)) throw new LinkFixtureError(404, "link_not_issued", "this identity has no link");
      return status(user);
    },
    "users-admin/link_rotate": (payload: Record<string, any>) => {
      const user = find(payload.user_id);
      const link = store.get(user.id);
      if (!link) throw new LinkFixtureError(404, "link_not_issued", "this identity has no link");
      link.token = randomish(`${user.id}:${Date.now()}:rotated`, 43);
      link.rotated_at = new Date().toISOString();
      delete link.last_fetch;
      return status(user);
    },
    "users-admin/link_reveal": (payload: Record<string, any>) => {
      const user = find(payload.user_id);
      const link = store.get(user.id);
      if (!link) throw new LinkFixtureError(404, "link_not_issued", "this identity has no link");
      return { kind: "identity", id: user.id, slug: link.slug, token: link.token, path: `/sub/${link.slug}/${link.token}` };
    },
    "users-admin/plan_add": plan("plan_add"),
    "users-admin/plan_update": plan("plan_update"),
  };
}
