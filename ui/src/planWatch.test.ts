import { describe, expect, it, vi } from "vitest";

import type { LinkStatus } from "./identityLinkModel";
import { PlanWatcher, planOutcome, type WatchedPlan } from "./planWatch";

function linkStatus(included: string[], excluded: Array<[string, string]>): LinkStatus {
  return {
    identity_id: "vu_a", issued: true, answer: "nodes", answer_reason: "active",
    included: included.map((hash) => ({ line_hash_id: hash })),
    excluded: excluded.map(([hash, reason]) => ({ line_hash_id: hash, reason })),
    formats: { native: [], converted: [], convert_available: false },
  };
}

describe("what the line says about a plan", () => {
  it("waits on a credential not yet applied and lands when the line carries it", () => {
    expect(planOutcome("plan_add", linkStatus([], [["lh", "credential_not_applied"]]), "lh")).toBe("pending");
    expect(planOutcome("plan_add", linkStatus(["lh"], []), "lh")).toBe("applied");
    expect(planOutcome("plan_update", linkStatus([], [["lh", "rotation_not_applied"]]), "lh")).toBe("pending");
    // Left out for a reason after the credential check: the credential is there.
    expect(planOutcome("plan_update", linkStatus([], [["lh", "no_client_template"]]), "lh")).toBe("applied");
    expect(planOutcome("plan_add", linkStatus([], [["lh", "parked_on_line"]]), "lh")).toBe("applied");
  });

  it("cannot watch a line whose state stops before the credential", () => {
    for (const reason of ["binding_disabled", "line_unknown", "managed_line_unsupported", "protocol_unsupported"]) {
      expect(planOutcome("plan_add", linkStatus([], [["lh", reason]]), "lh")).toBe("unobservable");
    }
    expect(planOutcome("plan_update", linkStatus([], []), "lh")).toBe("unobservable");
  });

  it("waits on an add for an unbound identity until the applied result binds the line", () => {
    expect(planOutcome("plan_add", linkStatus([], []), "lh")).toBe("pending");
    expect(planOutcome("plan_add", linkStatus(["lh"], []), "lh")).toBe("applied");
  });

  it("lands a removal when the applied credential is cleared or the binding is gone", () => {
    expect(planOutcome("plan_remove", linkStatus(["lh"], []), "lh")).toBe("pending");
    expect(planOutcome("plan_remove", linkStatus([], [["lh", "credential_not_applied"]]), "lh")).toBe("applied");
    expect(planOutcome("plan_remove", linkStatus([], []), "lh")).toBe("applied");
  });
});

function harness(reads: Array<LinkStatus | Error>) {
  let now = 0;
  const timers: Array<{ run: () => void; at: number }> = [];
  const read = vi.fn(async () => {
    const next = reads.length > 1 ? reads.shift()! : reads[0];
    if (next instanceof Error) throw next;
    return next;
  });
  const changes: Array<{ plans: readonly WatchedPlan[]; applied: readonly WatchedPlan[] }> = [];
  const watcher = new PlanWatcher({
    read,
    onChange: (plans, applied) => changes.push({ plans, applied }),
    intervalMs: 10_000,
    maxMs: 60_000,
    now: () => now,
    schedule: (run, ms) => {
      const timer = { run, at: now + ms };
      timers.push(timer);
      return timer;
    },
    cancel: (handle) => {
      const index = timers.indexOf(handle as (typeof timers)[number]);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  async function tick(): Promise<void> {
    const timer = timers.shift();
    if (!timer) return;
    now = timer.at;
    timer.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { watcher, read, changes, tick, timers };
}

const plan = { approvalId: "apr_1", userId: "vu_a", lineHash: "lh", op: "plan_add" as const, summary: "sb user add" };

describe("following a filed plan", () => {
  it("reads on a timer while pending, reports the plan that lands, and then stops", async () => {
    const { watcher, read, changes, tick, timers } = harness([
      linkStatus([], [["lh", "credential_not_applied"]]),
      linkStatus(["lh"], []),
    ]);
    watcher.watch(plan);
    expect(changes.at(-1)!.plans[0].state).toBe("pending");
    expect(timers).toHaveLength(1);
    await tick();
    expect(read).toHaveBeenCalledTimes(1);
    expect(changes.at(-1)!.applied).toHaveLength(0);
    await tick();
    expect(changes.at(-1)!.applied.map((entry) => entry.approvalId)).toEqual(["apr_1"]);
    expect(changes.at(-1)!.plans[0].state).toBe("applied");
    expect(timers).toHaveLength(0);
  });

  it("reads each identity once per tick however many of its plans are pending", async () => {
    const { watcher, read, tick } = harness([linkStatus([], [["lh", "credential_not_applied"], ["lh2", "credential_not_applied"]])]);
    watcher.watch(plan);
    watcher.watch({ ...plan, approvalId: "apr_2", lineHash: "lh2" });
    await tick();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("gives up after the limit and says to check Approvals", async () => {
    const { watcher, changes, tick, timers } = harness([linkStatus([], [["lh", "credential_not_applied"]])]);
    watcher.watch(plan);
    for (let i = 0; i < 6; i++) await tick();
    expect(changes.at(-1)!.plans[0]).toMatchObject({ state: "stopped" });
    expect(changes.at(-1)!.plans[0].note).toMatch(/after 1 minute\./);
    expect(timers).toHaveLength(0);
  });

  it("stops on a read that fails rather than retrying forever", async () => {
    const { watcher, changes, tick, timers } = harness([new Error("capability_denied")]);
    watcher.watch(plan);
    await tick();
    expect(changes.at(-1)!.plans[0].state).toBe("stopped");
    expect(changes.at(-1)!.plans[0].note).toMatch(/capability_denied/);
    expect(timers).toHaveLength(0);
  });

  it("forgets everything when disposed", async () => {
    const { watcher, read, timers } = harness([linkStatus([], [["lh", "credential_not_applied"]])]);
    watcher.watch(plan);
    watcher.dispose();
    expect(timers).toHaveLength(0);
    expect(watcher.list).toHaveLength(0);
    watcher.watch(plan);
    expect(timers).toHaveLength(0);
    expect(read).not.toHaveBeenCalled();
  });
});
