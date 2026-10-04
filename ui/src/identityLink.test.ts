import { afterEach, describe, expect, it, vi } from "vitest";

import { BridgeCallError } from "./bridge";
import { REVEAL_TIMEOUT_MS, REVEAL_TTL_MS, useIdentityLink, type IdentityLinkDeps } from "./identityLink";

function status(id: string, extra: Record<string, unknown> = {}) {
  return {
    identity_id: id, issued: true,
    link: { slug: "u-abcdefghij", enabled: true, issued_at: "2026-09-24T08:00:00Z", update_interval_hours: 2 },
    answer: "nodes", answer_reason: "active",
    included: [{ line_hash_id: "lh_1" }], excluded: [{ line_hash_id: "lh_2", reason: "credential_not_applied", fix: "plan_add" }],
    formats: { native: ["URI", "V2Ray"], converted: [], convert_available: false },
    ...extra,
  };
}

function deps(answers: Record<string, (payload: Record<string, unknown>) => unknown>, can: (method: string) => boolean = () => true) {
  const calls: Array<{ method: string; payload: Record<string, unknown>; timeoutMs?: number }> = [];
  const value: IdentityLinkDeps = {
    call: async <T,>(method: string, payload: Record<string, unknown>, timeoutMs?: number) => {
      calls.push({ method, payload, timeoutMs });
      const answer = answers[method];
      if (!answer) throw new Error(`no answer for ${method}`);
      return answer(payload) as T;
    },
    can,
    copy: vi.fn(async () => true),
  };
  return { value, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the link section's state", () => {
  it("reads the open identity's link and says denied without a call when the method is not granted", async () => {
    const granted = deps({ link_get: ({ user_id }) => status(String(user_id)) });
    const link = useIdentityLink(granted.value);
    await link.open("vu_a");
    expect(link.load.value).toBe("ready");
    expect(link.status.value?.identity_id).toBe("vu_a");

    const refused = deps({}, () => false);
    const none = useIdentityLink(refused.value);
    await none.open("vu_a");
    expect(none.load.value).toBe("denied");
    expect(refused.calls).toHaveLength(0);
  });

  it("tells the server's capability refusal apart from a failure", async () => {
    const denied = useIdentityLink(deps({ link_get: () => { throw new BridgeCallError("forbidden", "call_failed", "capability_denied", 403); } }).value);
    await denied.open("vu_a");
    expect(denied.load.value).toBe("denied");
    const failed = useIdentityLink(deps({ link_get: () => { throw new Error("upstream refused users-admin/link_get: 503"); } }).value);
    await failed.open("vu_a");
    expect(failed.load.value).toBe("error");
    expect(failed.error.value).toMatch(/503/);
  });

  it("asks for the link with a step-up's time, holds it five minutes, and drops it on rotate", async () => {
    vi.useFakeTimers();
    const { value, calls } = deps({
      link_get: ({ user_id }) => status(String(user_id)),
      link_reveal: () => ({ kind: "identity", id: "vu_a", slug: "u-abcdefghij", token: "T0KEN", path: "/sub/u-abcdefghij/T0KEN" }),
      link_rotate: ({ user_id }) => status(String(user_id), { link: { slug: "u-abcdefghij", enabled: true, issued_at: "2026-09-24T08:00:00Z", rotated_at: "2026-10-03T08:00:00Z", update_interval_hours: 2 } }),
    });
    const link = useIdentityLink(value);
    await link.open("vu_a");
    expect(await link.reveal()).toBe(true);
    expect(calls.find((call) => call.method === "link_reveal")?.timeoutMs).toBe(REVEAL_TIMEOUT_MS);
    expect(link.revealed.value?.token).toBe("T0KEN");
    await vi.advanceTimersByTimeAsync(REVEAL_TTL_MS + 1);
    expect(link.revealed.value).toBeUndefined();
    await link.reveal();
    expect(link.revealed.value).toBeDefined();
    await link.rotate();
    expect(link.revealed.value).toBeUndefined();
    expect(link.status.value?.link?.rotated_at).toBe("2026-10-03T08:00:00Z");
  });

  it("says a cancelled step-up plainly and reveals nothing", async () => {
    const link = useIdentityLink(deps({
      link_get: ({ user_id }) => status(String(user_id)),
      link_reveal: () => { throw new BridgeCallError("Step-up was cancelled", "step_up_required", "step_up_required", 403); },
    }).value);
    await link.open("vu_a");
    expect(await link.reveal()).toBe(false);
    expect(link.revealed.value).toBeUndefined();
    expect(link.outcome.value?.text).toMatch(/step-up did not complete/);
    expect(link.outcome.value?.place).toBe("reveal");
  });

  it("answers Copy beside the reveal controls and the other actions at the foot", async () => {
    const answers = deps({ link_get: ({ user_id }) => status(String(user_id)), link_set: ({ user_id }) => status(String(user_id)) });
    const link = useIdentityLink(answers.value);
    await link.open("vu_a");
    await link.copy("https://console.example/sub/u-abcdefghij/t", "Link");
    expect(link.outcome.value).toEqual({ tone: "success", place: "reveal", text: "Link copied." });
    vi.mocked(answers.value.copy).mockResolvedValueOnce(false);
    await link.copy("https://console.example/sub/u-abcdefghij/t", "Link");
    expect(link.outcome.value?.place).toBe("reveal");
    expect(link.outcome.value?.text).toMatch(/copy it by hand/);
    await link.setEnabled(false);
    expect(link.outcome.value?.place).toBeUndefined();
  });

  it("forgets the revealed link and ignores late answers when the panel moves to another identity", async () => {
    let release!: (value: unknown) => void;
    const link = useIdentityLink(deps({
      link_get: ({ user_id }) => status(String(user_id)),
      link_reveal: () => new Promise((resolve) => { release = resolve; }),
    }).value);
    await link.open("vu_a");
    const pending = link.reveal();
    await link.open("vu_b");
    release({ kind: "identity", id: "vu_a", slug: "u-a", token: "LATE", path: "/sub/u-a/LATE" });
    expect(await pending).toBe(false);
    expect(link.revealed.value).toBeUndefined();
    expect(link.status.value?.identity_id).toBe("vu_b");
  });

  it("files the plan a left-out line names and follows it", async () => {
    const { value, calls } = deps({
      link_get: ({ user_id }) => status(String(user_id)),
      plan_update: () => ({ approval: { id: "apr_7", plan: JSON.stringify({ summary: "sb user add a on VLESS" }) } }),
    });
    const link = useIdentityLink(value);
    await link.open("vu_a");
    await link.fix({ line_hash_id: "lh_2", fix: "plan_add" }, "plan_add");
    // A bound line takes plan_update even when the fix says add: the server
    // refuses plan_add for a bound identity, and both run sb user add.
    expect(calls.at(-1)).toMatchObject({ method: "plan_update", payload: { user_id: "vu_a", line_hash_id: "lh_2" } });
    expect(link.plans.value).toEqual([expect.objectContaining({ approvalId: "apr_7", state: "pending", summary: "sb user add a on VLESS" })]);
    expect(link.outcome.value?.text).toMatch(/approve it in Approvals/);
    await link.open("");
    expect(link.plans.value).toEqual([]);
  });

  it("issues, pauses and revokes through the server's answers", async () => {
    let issued = false;
    const link = useIdentityLink(deps({
      link_get: ({ user_id }) => status(String(user_id), { issued, link: undefined, answer: "decoy", answer_reason: "not_issued" }),
      link_issue: ({ user_id }) => { issued = true; return status(String(user_id)); },
      link_set: ({ user_id, enabled }) => status(String(user_id), { answer: "decoy", answer_reason: enabled ? "active" : "link_disabled" }),
      link_revoke: ({ user_id }) => status(String(user_id), { issued: false, link: undefined, answer: "decoy", answer_reason: "not_issued" }),
    }).value);
    await link.open("vu_a");
    expect(link.status.value?.issued).toBe(false);
    await link.issue();
    expect(link.status.value?.issued).toBe(true);
    await link.setEnabled(false);
    expect(link.status.value?.answer_reason).toBe("link_disabled");
    await link.revoke();
    expect(link.status.value?.issued).toBe(false);
    expect(link.outcome.value?.text).toMatch(/revoked/);
  });
});
