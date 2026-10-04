/**
 * planWatch.ts, following a filed line-user plan until the line shows it.
 *
 * Adding, updating or removing an identity on an adopted line files an
 * approval; nothing reaches the node until the operator approves it in the
 * console and the agent applies it. No method this plugin may call reads an
 * approval or its task, so the watch reads what the plan changes instead:
 * the identity's link status (users-admin link_get) says per bound line
 * whether the credential Lattice holds is the one applied on that line, and
 * the server rewrites that the moment the task result comes back.
 *
 * This is the one timed read in the plugin, and it is bounded: it runs only
 * while a plan it was given is pending, reads one identity per tick, stops at
 * the outcome, and gives up after half an hour, saying so. Page data stays
 * operator-driven (refreshPolicy.test.ts); this is a wait on a thing the
 * operator just did.
 */
import type { LinkStatus } from "./identityLinkModel";

export type WatchedOp = "plan_add" | "plan_update" | "plan_remove";

export type WatchState =
  /** Waiting for approval and apply. */
  | "pending"
  /** The line shows the change. */
  | "applied"
  /** The line's state cannot show this change (it is unknown, managed, or the protocol carries no credential). */
  | "unobservable"
  /** Half an hour passed with no change, or the status could not be read. */
  | "stopped";

export interface WatchedPlan {
  approvalId: string;
  userId: string;
  lineHash: string;
  op: WatchedOp;
  /** What the plan does, from its own summary. */
  summary: string;
  state: WatchState;
  /** Why the watch stopped, when it did. */
  note?: string;
}

/*
 * The order identity_link.go checks a bound line in. A line left out for a
 * reason before the credential check says nothing about the credential, so a
 * plan on it cannot be watched; one left out after it has the credential
 * applied already.
 */
const BEFORE_CREDENTIAL = new Set(["binding_disabled", "line_unknown", "managed_line_unsupported", "protocol_unsupported"]);
const CREDENTIAL_PENDING = new Set(["credential_not_applied", "rotation_not_applied", "credential_unknown"]);

/** What the line's state says about one plan. */
export function planOutcome(op: WatchedOp, status: LinkStatus, lineHash: string): "applied" | "pending" | "unobservable" {
  const included = status.included.some((line) => line.line_hash_id === lineHash);
  const excluded = status.excluded.find((line) => line.line_hash_id === lineHash);
  if (op === "plan_remove") {
    // Remove clears the applied credential; a binding removed in Lattice too
    // leaves the line out of both lists.
    if (!included && !excluded) return "applied";
    if (excluded?.reason === "credential_not_applied") return "applied";
    if (excluded && BEFORE_CREDENTIAL.has(excluded.reason ?? "")) return "unobservable";
    return "pending";
  }
  if (included) return "applied";
  // plan_add is for an identity not yet bound to the line; the applied
  // result binds it (lineusers.go reconcileLineUserBinding), so until then
  // the line is in neither list.
  if (!excluded) return op === "plan_add" ? "pending" : "unobservable";
  if (BEFORE_CREDENTIAL.has(excluded.reason ?? "")) return "unobservable";
  if (CREDENTIAL_PENDING.has(excluded.reason ?? "")) return "pending";
  return "applied";
}

export interface PlanWatcherOptions {
  read: (userId: string) => Promise<LinkStatus>;
  /** Called after any plan changes state, with the plans that just settled as applied. */
  onChange: (plans: readonly WatchedPlan[], applied: readonly WatchedPlan[]) => void;
  intervalMs?: number;
  maxMs?: number;
  now?: () => number;
  schedule?: (run: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export const PLAN_WATCH_INTERVAL_MS = 10_000;
export const PLAN_WATCH_MAX_MS = 30 * 60_000;

export class PlanWatcher {
  private readonly options: Required<PlanWatcherOptions>;
  private plans: WatchedPlan[] = [];
  private started = new Map<string, number>();
  private timer: unknown;
  private reading = false;
  private disposed = false;

  constructor(options: PlanWatcherOptions) {
    this.options = {
      intervalMs: PLAN_WATCH_INTERVAL_MS,
      maxMs: PLAN_WATCH_MAX_MS,
      now: () => Date.now(),
      schedule: (run, ms) => setTimeout(run, ms),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      ...options,
    };
  }

  get list(): readonly WatchedPlan[] {
    return this.plans;
  }

  /** Start following one filed plan. The newest is listed first. */
  watch(plan: Omit<WatchedPlan, "state">): void {
    if (this.disposed || !plan.approvalId) return;
    this.plans = [{ ...plan, state: "pending" }, ...this.plans.filter((entry) => entry.approvalId !== plan.approvalId)];
    this.started.set(plan.approvalId, this.options.now());
    this.options.onChange(this.plans, []);
    this.arm();
  }

  /** Stop every watch and forget the plans: the panel closed or moved on. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) this.options.cancel(this.timer);
    this.timer = undefined;
    this.plans = [];
    this.started.clear();
  }

  private pending(): WatchedPlan[] {
    return this.plans.filter((plan) => plan.state === "pending");
  }

  private arm(): void {
    if (this.disposed || this.timer !== undefined || this.reading || !this.pending().length) return;
    this.timer = this.options.schedule(() => {
      this.timer = undefined;
      void this.tick();
    }, this.options.intervalMs);
  }

  private async tick(): Promise<void> {
    if (this.disposed) return;
    this.reading = true;
    const applied: WatchedPlan[] = [];
    const users = [...new Set(this.pending().map((plan) => plan.userId))];
    for (const userId of users) {
      let status: LinkStatus | undefined;
      let failure = "";
      try {
        status = await this.options.read(userId);
      } catch (cause) {
        failure = cause instanceof Error && cause.message ? cause.message : "the link status could not be read";
      }
      if (this.disposed) return;
      this.plans = this.plans.map((plan) => {
        if (plan.userId !== userId || plan.state !== "pending") return plan;
        if (!status) return { ...plan, state: "stopped", note: `Stopped watching: ${failure}. Check Approvals.` };
        const outcome = planOutcome(plan.op, status, plan.lineHash);
        if (outcome === "applied") {
          const next = { ...plan, state: "applied" as const };
          applied.push(next);
          return next;
        }
        if (outcome === "unobservable") {
          return { ...plan, state: "unobservable", note: "This line's state cannot show the change, so watch it in Approvals." };
        }
        const since = this.started.get(plan.approvalId) ?? this.options.now();
        if (this.options.now() - since >= this.options.maxMs) {
          const minutes = Math.round(this.options.maxMs / 60_000);
          return { ...plan, state: "stopped", note: `Still not applied after ${minutes} minute${minutes === 1 ? "" : "s"}. It may be waiting for approval; check Approvals.` };
        }
        return plan;
      });
    }
    this.reading = false;
    this.options.onChange(this.plans, applied);
    this.arm();
  }
}
