/**
 * identityForm.ts, what the identity dialog sends to users-admin.
 *
 * The update handler (lattice-server internal/server/vpnusers.go) reads two
 * kinds of field, and the form has to respect both:
 *
 * - Pointer fields (`enabled`, `quota_bytes`, `quota_period`,
 *   `quota_reset_day`, `expires_at`): absent means "leave it". So the form
 *   sends one only when the operator changed it, judged against the value the
 *   dialog opened with. An emptied field is a change: it removes the quota
 *   (0, the value create stores for none) or the expiry (Go's zero time,
 *   which every expiry check reads as none).
 * - Plain fields (`name`, `group`, `comment`): assigned on every update,
 *   absent or not. So the form always sends them, trimmed, or an edit that
 *   never touched the group would empty it.
 *
 * The call is a parameter, so the payload the server sees is what the tests
 * pin, not a copy of it.
 */

import { quotaResetDayFromInput } from "./usageModel";
import { expiryPayload } from "./usersModel";
import type { VpnUser } from "./vpnModel";

export const GIB = 1024 ** 3;

export interface IdentityForm {
  email: string;
  name: string;
  enabled: boolean;
  /** GiB as typed. */
  quotaGiB: string;
  /** "none" or "monthly". */
  quotaPeriod: string;
  quotaResetDay: string;
  /** A `datetime-local` value, "" for none. */
  expiresAt: string;
  group: string;
  comment: string;
  protocol: string;
  secret: string;
  flow: string;
}

/** What the dialog opened with, for the fields that send only on change. */
export interface IdentityInitial {
  quotaGiB: string;
  expiresAt: string;
}

export function blankIdentityForm(): IdentityForm {
  return { email: "", name: "", enabled: true, quotaGiB: "", quotaPeriod: "none", quotaResetDay: "", expiresAt: "", group: "", comment: "", protocol: "vless", secret: "", flow: "" };
}

/** The quota in GiB as the field shows it, "" for none. */
export function quotaInput(bytes: number | undefined): string {
  return bytes && bytes > 0 ? String(bytes / GIB) : "";
}

/**
 * What an edit sends for the quota: nothing when the field was not touched,
 * 0 (no quota) when it was emptied or set to 0, the bytes otherwise. A value
 * that is not a number of GiB sends nothing, since storing a number nobody
 * typed is worse than keeping the one they had.
 */
export function quotaPayload(initial: string, current: string): number | undefined {
  const value = current.trim();
  if (value === initial.trim()) return undefined;
  if (!value) return 0;
  const gib = Number(value);
  if (!Number.isFinite(gib) || gib < 0) return undefined;
  return Math.round(gib * GIB);
}

export interface IdentityWrite {
  method: "create" | "update";
  payload: Record<string, unknown>;
  /** What changed that the outcome should say, beyond "saved". */
  removed: { quota: boolean; expiry: boolean };
}

export function identityWrite(form: IdentityForm, initial: IdentityInitial, editing?: Pick<VpnUser, "id">): IdentityWrite {
  const payload: Record<string, unknown> = {
    email: form.email.trim(),
    name: form.name.trim(),
    enabled: form.enabled,
    group: form.group.trim(),
    comment: form.comment.trim(),
  };
  const quota = quotaPayload(initial.quotaGiB, form.quotaGiB);
  if (quota !== undefined) payload.quota_bytes = quota;
  // The period is a select, so it always states a value and is always sent.
  // "none" is the server's word for no reset, and it clears the reset day
  // server-side, so a quota never keeps a day it no longer uses.
  payload.quota_period = form.quotaPeriod === "monthly" ? "monthly" : "none";
  if (form.quotaPeriod === "monthly") {
    const day = quotaResetDayFromInput(form.quotaResetDay);
    if (day !== undefined) payload.quota_reset_day = day;
  }
  const expiresAt = expiryPayload(initial.expiresAt, form.expiresAt);
  if (expiresAt !== undefined) payload.expires_at = expiresAt;
  const removed = {
    quota: !!editing && quota === 0 && initial.quotaGiB.trim() !== "",
    expiry: !!editing && expiresAt !== undefined && !form.expiresAt.trim(),
  };
  if (editing) return { method: "update", payload: { ...payload, id: editing.id }, removed };
  const credential: Record<string, string> = { protocol: form.protocol };
  if (["vless", "vmess", "tuic"].includes(form.protocol)) credential.uuid = form.secret.trim();
  else credential.password = form.secret;
  if (form.flow.trim()) credential.flow = form.flow.trim();
  return { method: "create", payload: { ...payload, credentials: [credential] }, removed };
}

export type AdminCall = <T>(method: "create" | "update", payload: Record<string, unknown>) => Promise<T>;

/** Send the dialog: one call, the payload `identityWrite` built. */
export async function saveIdentity(call: AdminCall, form: IdentityForm, initial: IdentityInitial, editing?: Pick<VpnUser, "id">): Promise<{ write: IdentityWrite; createdId?: string }> {
  const write = identityWrite(form, initial, editing);
  const result = await call<{ user?: { id?: string } } | undefined>(write.method, write.payload);
  return { write, createdId: write.method === "create" ? result?.user?.id : undefined };
}
