import { describe, expect, it } from "vitest";

import { blankIdentityForm, GIB, quotaInput, quotaPayload, saveIdentity, type AdminCall, type IdentityForm, type IdentityInitial } from "./identityForm";
import { NO_EXPIRY, expiryInput } from "./usersModel";

/** A stand-in for pluginCall: records what would cross the bridge. */
function stub(reply: unknown = { ok: true }) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const call: AdminCall = async <T>(method: "create" | "update", payload: Record<string, unknown>) => {
    calls.push({ method, payload });
    return reply as T;
  };
  return { call, calls };
}

/** The dialog as openEditUser fills it for this identity. */
function opened(extra: Partial<{ quota: number; expires: string; group: string; comment: string }> = {}): { form: IdentityForm; initial: IdentityInitial } {
  const initial = { quotaGiB: quotaInput(extra.quota), expiresAt: expiryInput(extra.expires ?? NO_EXPIRY) };
  const form = {
    ...blankIdentityForm(),
    email: "probe@lattice.invalid", name: "Liveness probe",
    quotaGiB: initial.quotaGiB, expiresAt: initial.expiresAt,
    group: extra.group ?? "probe", comment: extra.comment ?? "",
  };
  return { form, initial };
}

const probe = { id: "u_probe" };

describe("what an edit sends to users-admin update", () => {
  it("sends no expiry and no quota for fields the operator did not touch", async () => {
    const { call, calls } = stub();
    const { form, initial } = opened({ quota: 500 * GIB, expires: "2026-10-20T08:00:00Z" });
    await saveIdentity(call, form, initial, probe);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("update");
    expect(calls[0]!.payload).not.toHaveProperty("expires_at");
    expect(calls[0]!.payload).not.toHaveProperty("quota_bytes");
    expect(calls[0]!.payload.id).toBe("u_probe");
  });

  it("sends the zero time for an emptied expiry and 0 for an emptied quota", async () => {
    const { call, calls } = stub();
    const { form, initial } = opened({ quota: 500 * GIB, expires: "2026-10-20T08:00:00Z" });
    form.expiresAt = "";
    form.quotaGiB = "  ";
    const { write } = await saveIdentity(call, form, initial, probe);
    expect(calls[0]!.payload.expires_at).toBe(NO_EXPIRY);
    expect(calls[0]!.payload.quota_bytes).toBe(0);
    expect(write.removed).toEqual({ quota: true, expiry: true });
  });

  it("sends a changed quota in bytes and a typed zero as no quota", async () => {
    const { call, calls } = stub();
    const { form, initial } = opened({ quota: 500 * GIB });
    form.quotaGiB = "1.5";
    await saveIdentity(call, form, initial, probe);
    expect(calls[0]!.payload.quota_bytes).toBe(Math.round(1.5 * GIB));
    form.quotaGiB = "0";
    await saveIdentity(call, form, initial, probe);
    expect(calls[1]!.payload.quota_bytes).toBe(0);
  });

  it("always sends name, group and comment, trimmed, because update assigns them whether sent or not", async () => {
    const { call, calls } = stub();
    const { form, initial } = opened({ group: "probe", comment: "keep me" });
    form.group = "  probe  ";
    await saveIdentity(call, form, initial, probe);
    expect(calls[0]!.payload).toMatchObject({ name: "Liveness probe", group: "probe", comment: "keep me" });
    form.group = "";
    form.comment = "";
    await saveIdentity(call, form, initial, probe);
    // An emptied group or comment is sent empty, which is how update clears it.
    expect(calls[1]!.payload).toMatchObject({ group: "", comment: "" });
  });

  it("always states the quota period, and a reset day only for a monthly quota", async () => {
    const { call, calls } = stub();
    const { form, initial } = opened();
    form.quotaResetDay = "5";
    await saveIdentity(call, form, initial, probe);
    expect(calls[0]!.payload.quota_period).toBe("none");
    expect(calls[0]!.payload).not.toHaveProperty("quota_reset_day");
    form.quotaPeriod = "monthly";
    await saveIdentity(call, form, initial, probe);
    expect(calls[1]!.payload).toMatchObject({ quota_period: "monthly", quota_reset_day: 5 });
  });
});

describe("what a create sends", () => {
  it("sends one credential, and neither a quota nor an expiry the operator left blank", async () => {
    const { call, calls } = stub({ user: { id: "u_new" } });
    const form = { ...blankIdentityForm(), email: " new@example.invalid ", secret: " 4f2a1c88-0d55-4a3e-9d31-6b71f0c2a9de " };
    const { createdId } = await saveIdentity(call, form, { quotaGiB: "", expiresAt: "" });
    expect(calls[0]!.method).toBe("create");
    expect(calls[0]!.payload).toMatchObject({ email: "new@example.invalid", credentials: [{ protocol: "vless", uuid: "4f2a1c88-0d55-4a3e-9d31-6b71f0c2a9de" }] });
    expect(calls[0]!.payload).not.toHaveProperty("quota_bytes");
    expect(calls[0]!.payload).not.toHaveProperty("expires_at");
    expect(calls[0]!.payload).not.toHaveProperty("id");
    expect(createdId).toBe("u_new");
  });

  it("puts a password protocol's secret in password, untrimmed", async () => {
    const { call, calls } = stub();
    const form = { ...blankIdentityForm(), email: "t@example.invalid", protocol: "trojan", secret: " pass word " };
    await saveIdentity(call, form, { quotaGiB: "", expiresAt: "" });
    expect(calls[0]!.payload.credentials).toEqual([{ protocol: "trojan", password: " pass word " }]);
  });
});

describe("the quota field", () => {
  it("reads blank as no quota and compares against what the dialog opened with", () => {
    expect(quotaInput(0)).toBe("");
    expect(quotaInput(undefined)).toBe("");
    expect(quotaInput(500 * GIB)).toBe("500");
    expect(quotaPayload("500", "500")).toBeUndefined();
    expect(quotaPayload("", "")).toBeUndefined();
    expect(quotaPayload("500", "")).toBe(0);
    expect(quotaPayload("", "abc")).toBeUndefined();
    expect(quotaPayload("", "-4")).toBeUndefined();
  });
});
