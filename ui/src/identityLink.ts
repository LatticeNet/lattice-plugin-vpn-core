/**
 * identityLink.ts, the state behind one identity's link section.
 *
 * The page creates one of these and points it at whichever identity's panel
 * is open; the panel renders it and the page's confirm dialog calls rotate
 * and revoke on it, so the dialog sits in the page's overlay stack (Escape,
 * focus return) while the section keeps one source of truth.
 *
 * Every read and write goes through users-admin link_* (lattice-server
 * identity_link_api.go). The revealed link is held here only: it is dropped
 * when the panel moves to another identity or closes, when the link is
 * rotated or revoked here, when a fresh status shows it was rotated, revoked,
 * paused or expired elsewhere, when the page goes to the background, when a
 * later reveal is refused, and after five minutes. It never enters page
 * state, the address, a call payload or a log.
 */
import { ref, shallowRef } from "vue";

import {
  parseLinkReveal,
  parseLinkStatus,
  isPermissionError,
  revealRefusalText,
  lineTitle,
  type FixAction,
  type LinkLine,
  type LinkReveal,
  type LinkStatus,
} from "./identityLinkModel";
import { PlanWatcher, type WatchedPlan } from "./planWatch";
import { safeErrorMessage } from "./vpnModel";

export type LinkMethod = "link_get" | "link_issue" | "link_set" | "link_revoke" | "link_rotate" | "link_reveal";

export interface IdentityLinkDeps {
  /** users-admin call; the page's pluginCall with a timeout. */
  call: <T>(method: LinkMethod | FixAction, payload: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
  /** Whether this session may call the method at all (declared and granted). */
  can: (method: LinkMethod | FixAction) => boolean;
  copy: (text: string) => Promise<boolean>;
}

export type LinkLoad = "idle" | "loading" | "ready" | "denied" | "error";

export interface LinkOutcome {
  tone: "success" | "error" | "info";
  text: string;
  /**
   * Where the panel says it, beside the control that was pressed: "reveal"
   * for Reveal and Copy, "clients" for a per-client copy, "line" for a plan
   * filed from one left-out line (lineHash). At the section's foot, under
   * every line list, these were out of view, so the press looked ignored.
   * Without a place the note sits at the actions.
   */
  place?: "reveal" | "clients" | "line";
  lineHash?: string;
}

/** How long a revealed link stays on screen without being asked for again. */
export const REVEAL_TTL_MS = 5 * 60_000;
/*
 * The console's step-up prompt waits for the operator to type a code or
 * touch a passkey, so the reveal is given far longer than an ordinary call.
 * The console pauses its own timeout while its prompt is open.
 */
export const REVEAL_TIMEOUT_MS = 180_000;

/** The plan a left-out bound line gets, whichever fix the server names (see fix). */
export const BOUND_LINE_PLAN = "plan_update" as const;

export function useIdentityLink(deps: IdentityLinkDeps) {
  const userId = ref("");
  const load = ref<LinkLoad>("idle");
  const status = shallowRef<LinkStatus>();
  const error = ref("");
  const busy = ref<"" | "issue" | "pause" | "resume" | "expiry" | "rotate" | "revoke" | "reveal" | "plan">("");
  const outcome = ref<LinkOutcome>();
  const revealed = shallowRef<LinkReveal>();
  const plans = shallowRef<readonly WatchedPlan[]>([]);
  let revealTimer: ReturnType<typeof setTimeout> | undefined;
  /* What the link looked like when it was revealed. A status that differs
   * means the held token no longer serves. */
  let revealedFor: { slug: string; rotatedAt: string } | undefined;
  let watcher: PlanWatcher | undefined;
  let generation = 0;

  function forgetReveal(): void {
    if (revealTimer !== undefined) clearTimeout(revealTimer);
    revealTimer = undefined;
    revealed.value = undefined;
    revealedFor = undefined;
  }

  /** Forget the held link and say why beside Reveal. */
  function hideReveal(text: string): void {
    if (!revealed.value) return;
    forgetReveal();
    outcome.value = { tone: "info", place: "reveal", text };
  }

  /*
   * A status from any read or write. When another operator (or the REST door)
   * rotated, revoked, paused or let the link expire while this panel holds a
   * reveal, the held URL only gets the decoy now, so it is dropped rather than
   * copied or scanned for five more minutes.
   */
  function adopt(next: LinkStatus): void {
    const held = revealedFor;
    if (revealed.value && held) {
      const link = next.link;
      const stale = !next.issued || !link || !link.enabled || next.answer_reason === "link_expired" ||
        link.slug !== held.slug || (link.rotated_at ?? "") !== held.rotatedAt;
      if (stale) hideReveal("The link changed since it was revealed (rotated, revoked, paused or expired), so it was hidden. Reveal it again for the current one.");
    }
    status.value = next;
  }

  function stopWatching(): void {
    watcher?.dispose();
    watcher = undefined;
    plans.value = [];
  }

  async function readStatus(id: string): Promise<LinkStatus> {
    const answer = await deps.call<unknown>("link_get", { user_id: id });
    const parsed = parseLinkStatus(answer);
    if (!parsed) throw new Error("The server's link answer was not a link status, so nothing is shown rather than a guess.");
    return parsed;
  }

  /** Point the section at an identity, or at none (""), and read its link. */
  async function open(id: string): Promise<void> {
    if (id === userId.value && load.value !== "idle") return;
    generation += 1;
    forgetReveal();
    stopWatching();
    userId.value = id;
    status.value = undefined;
    error.value = "";
    outcome.value = undefined;
    busy.value = "";
    load.value = id ? "loading" : "idle";
    if (!id) return;
    if (!deps.can("link_get")) {
      load.value = "denied";
      return;
    }
    await refresh();
  }

  async function refresh(): Promise<void> {
    const id = userId.value;
    if (!id) return;
    const mine = generation;
    if (!status.value) load.value = "loading";
    try {
      const next = await readStatus(id);
      if (mine !== generation) return;
      adopt(next);
      load.value = "ready";
      error.value = "";
    } catch (cause) {
      if (mine !== generation) return;
      if (isPermissionError(cause)) {
        load.value = "denied";
        return;
      }
      error.value = safeErrorMessage(cause, "The link status could not be read");
      // A failed refresh keeps the last answer on screen, said as stale.
      load.value = status.value ? "ready" : "error";
    }
  }

  async function write(kind: Exclude<typeof busy.value, "" | "reveal" | "plan">, method: LinkMethod, payload: Record<string, unknown>, done: string): Promise<boolean> {
    const id = userId.value;
    if (!id || busy.value) return false;
    const mine = generation;
    busy.value = kind;
    outcome.value = undefined;
    try {
      const answer = await deps.call<unknown>(method, { user_id: id, ...payload });
      if (mine !== generation) return false;
      const parsed = parseLinkStatus(answer);
      if (parsed) adopt(parsed);
      else await refresh();
      outcome.value = { tone: "success", text: done };
      return true;
    } catch (cause) {
      if (mine !== generation) return false;
      outcome.value = { tone: "error", text: safeErrorMessage(cause, "The link could not be changed") };
      return false;
    } finally {
      if (mine === generation) busy.value = "";
    }
  }

  function issue(): Promise<boolean> {
    return write("issue", "link_issue", {}, "Link issued. Reveal it to copy it or show its QR code.");
  }

  function setEnabled(enabled: boolean): Promise<boolean> {
    return write(enabled ? "resume" : "pause", "link_set", { enabled },
      enabled ? "Link resumed: clients get their servers again on the next refresh." : "Link paused: it answers like an unknown URL until you resume it.");
  }

  /** The link stops expiring (users-admin link_set clear_expiry). */
  function clearExpiry(): Promise<boolean> {
    return write("expiry", "link_set", { clear_expiry: true }, "Link expiry removed: the link serves again on the next fetch.");
  }

  async function rotate(): Promise<boolean> {
    forgetReveal();
    return write("rotate", "link_rotate", {}, "New link issued. The old URL stopped working at once; reveal the new one to hand it out.");
  }

  async function revoke(): Promise<boolean> {
    forgetReveal();
    return write("revoke", "link_revoke", {}, "Link revoked. The old URL answers like an unknown one, and no link is issued now.");
  }

  /**
   * Ask for the token. The console runs its step-up prompt when the server
   * asks for one and answers this call once the operator has passed it, or
   * refuses it when they cancel.
   */
  async function reveal(): Promise<boolean> {
    const id = userId.value;
    if (!id || busy.value) return false;
    const mine = generation;
    busy.value = "reveal";
    outcome.value = undefined;
    try {
      const answer = await deps.call<unknown>("link_reveal", { user_id: id }, REVEAL_TIMEOUT_MS);
      if (mine !== generation) return false;
      const parsed = parseLinkReveal(answer);
      if (!parsed) throw new Error("The server's reveal answer carried no link.");
      forgetReveal();
      revealed.value = parsed;
      revealedFor = { slug: parsed.slug || status.value?.link?.slug || "", rotatedAt: status.value?.link?.rotated_at ?? "" };
      revealTimer = setTimeout(() => {
        revealTimer = undefined;
        hideReveal("The link was hidden after five minutes. Reveal it again to copy it or show its QR code.");
      }, REVEAL_TTL_MS);
      outcome.value = { tone: "success", place: "reveal", text: "Link revealed. It is hidden again after five minutes, or when you leave this identity." };
      return true;
    } catch (cause) {
      if (mine !== generation) return false;
      // A refused reveal leaves nothing on screen, not an older link.
      forgetReveal();
      outcome.value = {
        tone: "error",
        place: "reveal",
        text: revealRefusalText(cause) ?? safeErrorMessage(cause, "The link could not be revealed"),
      };
      return false;
    } finally {
      if (mine === generation) busy.value = "";
    }
  }

  /** Copy through the console. `place` says which control asked: Copy, or a client's button. */
  async function copy(text: string, what: string, place: "reveal" | "clients" = "reveal"): Promise<boolean> {
    const ok = await deps.copy(text);
    outcome.value = ok
      ? { tone: "success", place, text: `${what} copied.` }
      : { tone: "error", place, text: "The console did not copy it. The full link is selected below: copy it by hand." };
    return ok;
  }

  /** The page went to the background: a revealed link is not left on an unattended screen. */
  function pageHidden(): void {
    hideReveal("The link was hidden when this page went to the background. Reveal it again to copy it or show its QR code.");
  }

  function ensureWatcher(): PlanWatcher {
    watcher ??= new PlanWatcher({
      read: readStatus,
      onChange: (list, applied) => {
        plans.value = [...list];
        if (applied.length) {
          outcome.value = { tone: "success", text: `Applied: ${applied.length === 1 ? "the line now carries" : `${applied.length} lines now carry`} this identity's credential.` };
          void refresh();
        }
      },
    });
    return watcher;
  }

  /**
   * File the plan that brings a left-out line back, and follow it.
   *
   * Every line the status lists is one this identity is bound to, and for a
   * bound identity the server files only plan_update (lineusers.go refuses
   * plan_add for a bound user, "plan_update instead"). On an adopted line
   * both run `sb user add`, which adds or replaces the identity's entry, so
   * plan_update is the plan for either fix: "add" (the credential was never
   * applied) and "update" (the line holds an older one).
   */
  async function fix(line: LinkLine, action: FixAction): Promise<void> {
    const id = userId.value;
    if (!id || busy.value || !canFix()) return;
    const at = { place: "line" as const, lineHash: line.line_hash_id };
    // One plan per line at a time: a second press would file a second,
    // identical privileged plan for Approvals.
    if (pendingPlan(line.line_hash_id)) {
      outcome.value = { tone: "info", ...at, text: "A plan for this line is already waiting for approval. Review it in Approvals." };
      return;
    }
    const mine = generation;
    busy.value = "plan";
    outcome.value = undefined;
    try {
      const result = await deps.call<{ approval?: { id?: string; plan?: string } }>(BOUND_LINE_PLAN, { user_id: id, line_hash_id: line.line_hash_id });
      if (mine !== generation) return;
      const approvalId = result.approval?.id ?? "";
      let summary = action === "plan_add" ? `add to ${lineTitle(line)}` : `update on ${lineTitle(line)}`;
      try {
        summary = JSON.parse(result.approval?.plan ?? "{}").summary || summary;
      } catch {
        // the fallback above
      }
      if (!approvalId) {
        outcome.value = { tone: "info", ...at, text: "The plan was filed but the answer named no approval. Find it in Approvals." };
        return;
      }
      ensureWatcher().watch({ approvalId, userId: id, lineHash: line.line_hash_id, op: BOUND_LINE_PLAN, summary });
      outcome.value = { tone: "info", ...at, text: "Nothing changes on the node until you approve it in Approvals." };
    } catch (cause) {
      if (mine !== generation) return;
      outcome.value = { tone: "error", ...at, text: safeErrorMessage(cause, "The plan could not be filed") };
    } finally {
      if (mine === generation) busy.value = "";
    }
  }

  function canFix(): boolean {
    return deps.can(BOUND_LINE_PLAN);
  }

  /** The plan filed for a line that is still waiting for approval and apply, if any. */
  function pendingPlan(lineHash: string): WatchedPlan | undefined {
    return plans.value.find((plan) => plan.lineHash === lineHash && plan.state === "pending");
  }

  function dismiss(): void {
    outcome.value = undefined;
  }

  return {
    userId,
    load,
    status,
    error,
    busy,
    outcome,
    revealed,
    plans,
    open,
    refresh,
    issue,
    setEnabled,
    clearExpiry,
    rotate,
    revoke,
    reveal,
    forgetReveal,
    pageHidden,
    copy,
    fix,
    dismiss,
    canFix,
    pendingPlan,
    can: deps.can,
  };
}

export type IdentityLinkState = ReturnType<typeof useIdentityLink>;
