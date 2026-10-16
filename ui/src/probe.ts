/**
 * probe.ts, the state behind the Probe layer.
 *
 * The page creates one of these and the layer renders it, so switching to
 * another Lines layer and back keeps the paste, the options and the last
 * result. Every call goes to latticenet.vpn-core/probe (lattice-server, which
 * forwards to lattice-probe over its unix socket): health and targets when
 * the layer first opens, run when the operator asks.
 *
 * The pasted outbound is held in `draft`, and for UNDO_CLEAR_MS after Clear
 * in the Undo slot. The tested outbound and its hops leave the frame once
 * per run, as that call's payload; nothing pasted enters page state, the
 * address, storage, a log, or any message this page builds. Results live in
 * page memory and go with the page.
 */
import { computed, ref, shallowRef, watch } from "vue";

import {
  buildProbeRequest,
  chainPath,
  classifyRunError,
  keepTestTag,
  outboundLabel,
  MAX_TARGETS_PER_RUN,
  parseHealth,
  parseProbeResult,
  parseSavedTarget,
  parseTargets,
  readDraft,
  RUN_CALL_TIMEOUT_MS,
  SAMPLES_DEFAULT,
  TARGET_EDIT_METHODS,
  THROUGHPUT_DEFAULT_BYTES,
  type BuildResult,
  type CustomTargets,
  type ProbeHealth,
  type ProbeMethod,
  type ProbeResult,
  type ProbeTarget,
  type RunFailure,
} from "./probeModel";
import type { TargetInput } from "./probeTargetForm";
import { safeErrorMessage } from "./vpnModel";

export interface ProbeDeps {
  /** One call to the probe service, cancellable while it is in flight. */
  call: <T>(method: ProbeMethod, payload: Record<string, unknown>, timeoutMs?: number) => { promise: Promise<T>; cancel: () => void };
  /** Whether this session may call the method at all (declared and granted). */
  can: (method: ProbeMethod) => boolean;
  now?: () => number;
}

export type ReadState = "idle" | "loading" | "ready" | "error";
export type RunPhase = "idle" | "running" | "done" | "failed";

export interface RunFailureState extends Omit<RunFailure, "kind"> {
  kind: RunFailure["kind"] | "cancelled";
}

/** What was asked, kept beside the answer so the result says what it measured. */
export interface Tested {
  label: string;
  targets: number;
  samples: number;
  udp: boolean;
  throughput: boolean;
  /** The deadline the run gave the probe. */
  timeoutMs: number;
  at: number;
}

const READ_TIMEOUT_MS = 10_000;
/** How long Clear can be undone before the paste is gone for good. */
export const UNDO_CLEAR_MS = 10_000;

export function useProbe(deps: ProbeDeps) {
  const now = deps.now ?? (() => Date.now());

  const draft = ref("");
  const read = computed(() => readDraft(draft.value));
  const outbounds = computed(() => (read.value.kind === "ok" ? read.value.outbounds : []));
  /** The operator's pick, kept while the paste still has that tag. */
  const chosenTest = ref("");
  const test = computed(() => keepTestTag(outbounds.value, chosenTest.value));
  /** The tags a run sends: the tested outbound and the hops it passes through. */
  const sent = computed(() => new Set(chainPath(outbounds.value, test.value).tags));
  const chosenTargets = ref<string[]>([]);
  const samples = ref(SAMPLES_DEFAULT);
  const udp = ref(true);
  const throughput = ref(false);
  const throughputBytes = ref(THROUGHPUT_DEFAULT_BYTES);

  const health = shallowRef<ProbeHealth>();
  const healthState = ref<ReadState>("idle");
  const healthError = ref("");
  const healthBusy = ref(false);
  const targets = shallowRef<ProbeTarget[]>([]);
  const targetsState = ref<ReadState>("idle");
  const targetsError = ref("");
  /** Whether saved targets run; absent when the server keeps none. */
  const custom = shallowRef<CustomTargets>();
  /** A save or delete in flight. */
  const editBusy = ref(false);

  const phase = ref<RunPhase>("idle");
  const result = shallowRef<ProbeResult>();
  const tested = shallowRef<Tested>();
  const failure = shallowRef<RunFailureState>();
  const startedAt = ref(0);
  /** The deadline of the run in flight, for the running state to state. */
  const deadlineMs = ref(0);
  /** A call came back refused for want of a scope, whatever init said. */
  const refused = ref(false);

  let inflight: { cancel: () => void; generation: number } | undefined;
  let generation = 0;

  const allowed = computed(() => deps.can("run") && !refused.value);
  /** The probe said it is not there. A health read that failed is not that. */
  const unavailable = computed(() => healthState.value === "ready" && health.value?.available === false);
  const running = computed(() => phase.value === "running");
  /** The ids a run may name: built-in targets, and saved ones while the probe runs them. */
  const runnable = computed(() => targets.value.filter((target) => target.source === "builtin" || custom.value?.supported).map((target) => target.id));
  const ready = computed(() => allowed.value && !unavailable.value && runnable.value.length > 0);
  /** The server keeps a saved list and this session may change it. */
  const canEditTargets = computed(() => allowed.value && !!custom.value && TARGET_EDIT_METHODS.every((method) => deps.can(method)));
  const customCount = computed(() => targets.value.filter((target) => target.source === "custom").length);

  function options() {
    return {
      test: test.value,
      targets: chosenTargets.value,
      samples: samples.value,
      udp: udp.value,
      throughput: throughput.value,
      throughputBytes: throughputBytes.value,
    };
  }

  /** The request this run would send, or what stops it. Recomputed only when an input changes. */
  const request = computed<BuildResult>(() => buildProbeRequest(read.value, options(), runnable.value));

  function denied(cause: unknown): boolean {
    if (classifyRunError(cause).kind !== "denied") return false;
    refused.value = true;
    return true;
  }

  async function loadHealth(): Promise<void> {
    if (!deps.can("health") || healthBusy.value) return;
    healthBusy.value = true;
    if (!health.value) healthState.value = "loading";
    try {
      const parsed = parseHealth(await deps.call<unknown>("health", {}, READ_TIMEOUT_MS).promise);
      if (!parsed) throw new Error("The probe's health answer was not a health report, so nothing is shown rather than a guess.");
      health.value = parsed;
      healthState.value = "ready";
      healthError.value = "";
    } catch (cause) {
      if (denied(cause)) return;
      healthError.value = safeErrorMessage(cause, "The probe's health could not be read");
      healthState.value = "error";
    } finally {
      healthBusy.value = false;
    }
  }

  async function loadTargets(): Promise<void> {
    if (!deps.can("targets") || targetsState.value === "loading") return;
    targetsState.value = "loading";
    try {
      const parsed = parseTargets(await deps.call<unknown>("targets", {}, READ_TIMEOUT_MS).promise);
      if (!parsed) throw new Error("The probe's target answer was not a target list, so no target is offered rather than a guess.");
      targets.value = parsed.targets;
      custom.value = parsed.custom;
      const known = new Set(runnable.value);
      const kept = chosenTargets.value.filter((id) => known.has(id));
      chosenTargets.value = kept.length ? kept : runnable.value.slice(0, 1);
      targetsState.value = "ready";
      targetsError.value = "";
    } catch (cause) {
      if (denied(cause)) return;
      targetsError.value = safeErrorMessage(cause, "The probe's targets could not be read");
      targetsState.value = "error";
    }
  }

  /** Read the list again, after someone else changed it or a save was refused for that. */
  function reloadTargets(): void {
    if (allowed.value) void loadTargets();
  }

  /**
   * Save a new target, or a change to `existing` naming the version it was
   * read at. A new target that can run is chosen for the next run.
   */
  async function saveTarget(input: TargetInput, existing?: ProbeTarget): Promise<{ ok: true; target: ProbeTarget } | { ok: false; message: string; stale: boolean }> {
    const method = existing ? "target_update" : "target_create";
    if (editBusy.value || !canEditTargets.value) return { ok: false, message: "This session cannot change the saved targets.", stale: false };
    editBusy.value = true;
    try {
      const payload = existing ? { id: existing.id, version: existing.version, ...input } : { ...input };
      const saved = parseSavedTarget(await deps.call<unknown>(method, payload, READ_TIMEOUT_MS).promise);
      if (!saved) throw new Error("The server's answer was not a saved target. Reload the list to see what was saved.");
      if (existing) {
        targets.value = targets.value.map((target) => (target.id === existing.id ? saved : target));
      } else {
        targets.value = [...targets.value, saved];
        if (runnable.value.includes(saved.id) && chosenTargets.value.length < MAX_TARGETS_PER_RUN) chosenTargets.value = [...chosenTargets.value, saved.id];
      }
      return { ok: true, target: saved };
    } catch (cause) {
      return { ok: false, message: safeErrorMessage(cause, "The target could not be saved."), stale: isConflict(cause) };
    } finally {
      editBusy.value = false;
    }
  }

  /** Delete a saved target, naming the version it was read at. */
  async function deleteTarget(target: ProbeTarget): Promise<{ ok: true } | { ok: false; message: string; stale: boolean }> {
    if (editBusy.value || !canEditTargets.value) return { ok: false, message: "This session cannot change the saved targets.", stale: false };
    editBusy.value = true;
    try {
      await deps.call<unknown>("target_delete", { id: target.id, version: target.version }, READ_TIMEOUT_MS).promise;
      targets.value = targets.value.filter((item) => item.id !== target.id);
      chosenTargets.value = chosenTargets.value.filter((id) => id !== target.id);
      return { ok: true };
    } catch (cause) {
      return { ok: false, message: safeErrorMessage(cause, "The target could not be deleted."), stale: isConflict(cause) };
    } finally {
      editBusy.value = false;
    }
  }

  /** The layer opened: read what the probe offers, once. */
  function open(): void {
    if (!allowed.value) return;
    if (healthState.value === "idle") void loadHealth();
    if (targetsState.value === "idle") void loadTargets();
  }

  /** The operator asked to look again: health always, targets when they never arrived. */
  function refresh(): void {
    if (!allowed.value) return;
    void loadHealth();
    if (targetsState.value === "error" || targetsState.value === "idle") void loadTargets();
  }

  /**
   * Run the test, or return what stops it so the layer can point at it. A
   * run replaces the last result; a run still in flight is not doubled.
   */
  async function run(): Promise<BuildResult | undefined> {
    if (running.value || !allowed.value) return undefined;
    const built = request.value;
    if (!built.ok) return built;
    const mine = ++generation;
    const label = outboundLabel(outbounds.value, built.request.test);
    failure.value = undefined;
    result.value = undefined;
    tested.value = undefined;
    phase.value = "running";
    startedAt.value = now();
    deadlineMs.value = built.request.timeout_ms;
    const handle = deps.call<unknown>("run", built.request as unknown as Record<string, unknown>, RUN_CALL_TIMEOUT_MS);
    inflight = { cancel: handle.cancel, generation: mine };
    try {
      const answer = await handle.promise;
      if (mine !== generation) return built;
      const parsed = parseProbeResult(answer);
      if (!parsed) throw new Error("The probe's answer was not a probe result, so nothing is shown rather than a guess.");
      result.value = parsed;
      tested.value = {
        label,
        targets: built.request.targets.length,
        samples: built.request.samples,
        udp: built.request.udp,
        throughput: built.request.throughput,
        timeoutMs: built.request.timeout_ms,
        at: now(),
      };
      phase.value = "done";
    } catch (cause) {
      if (mine !== generation) return built;
      const classified = classifyRunError(cause);
      if (classified.kind === "denied") refused.value = true;
      failure.value = classified;
      phase.value = "failed";
    } finally {
      if (inflight?.generation === mine) inflight = undefined;
    }
    return built;
  }

  /** Stop waiting. The console aborts the call, the server closes the probe's request, and the probe removes what it created. */
  function cancel(): void {
    if (!running.value) return;
    generation += 1;
    const handle = inflight;
    inflight = undefined;
    handle?.cancel();
    failure.value = { kind: "cancelled", message: "Cancelled before the probe answered. The probe removes the outbound it created when the request closes." };
    phase.value = "failed";
  }

  /*
   * Clear sets the textarea's value from here, so the browser's own undo
   * cannot bring a hand-edited paste back. The Undo slot can, until the next
   * edit or UNDO_CLEAR_MS, whichever is first; then the paste is gone.
   */
  const undoable = ref(false);
  let undoDraft = "";
  let undoTest = "";
  let undoTimer: ReturnType<typeof setTimeout> | undefined;

  function dropUndo(): void {
    if (undoTimer !== undefined) clearTimeout(undoTimer);
    undoTimer = undefined;
    undoDraft = "";
    undoTest = "";
    undoable.value = false;
  }
  // Anything typed or pasted after Clear is the new draft; the old one is not offered back over it.
  watch(draft, (value) => {
    if (value) dropUndo();
  });

  /** Forget the paste and the result. The paste can come back with undoClear for a few seconds. */
  function clear(): void {
    cancel();
    dropUndo();
    if (draft.value) {
      undoDraft = draft.value;
      undoTest = chosenTest.value;
      undoable.value = true;
      undoTimer = setTimeout(dropUndo, UNDO_CLEAR_MS);
    }
    draft.value = "";
    chosenTest.value = "";
    result.value = undefined;
    tested.value = undefined;
    failure.value = undefined;
    phase.value = "idle";
  }

  /** Put back the paste Clear took, while it still can. */
  function undoClear(): boolean {
    if (!undoable.value) return false;
    const text = undoDraft;
    const pick = undoTest;
    dropUndo();
    draft.value = text;
    chosenTest.value = pick;
    return true;
  }

  /** Re-indent a paste that reads, so a minified outbound can be checked by eye. */
  function format(): boolean {
    const value = read.value;
    if (value.kind !== "ok") return false;
    draft.value = JSON.stringify(value.single ? value.outbounds[0] : value.outbounds, null, 2);
    return true;
  }

  function dispose(): void {
    cancel();
    dropUndo();
    draft.value = "";
  }

  return {
    draft,
    read,
    outbounds,
    chosenTest,
    test,
    sent,
    chosenTargets,
    samples,
    udp,
    throughput,
    throughputBytes,
    request,
    health,
    healthState,
    healthError,
    healthBusy,
    targets,
    targetsState,
    targetsError,
    custom,
    runnable,
    canEditTargets,
    customCount,
    editBusy,
    reloadTargets,
    saveTarget,
    deleteTarget,
    phase,
    result,
    tested,
    failure,
    startedAt,
    deadlineMs,
    allowed,
    unavailable,
    running,
    ready,
    open,
    refresh,
    run,
    cancel,
    clear,
    undoable,
    undoClear,
    format,
    dispose,
  };
}

/** Someone changed the target since it was read, or the list is full: a 409. */
function isConflict(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { httpStatus?: unknown }).httpStatus === 409;
}

export type ProbeState = ReturnType<typeof useProbe>;
