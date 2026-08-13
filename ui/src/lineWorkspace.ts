import type { LineChain, LineGroup } from "./vpnModel";

const LINES_SERVICE = "latticenet.vpn-core/lines";

type Caller = (service: string, method: string, payload?: unknown) => Promise<unknown>;

export interface LineWorkspaceSnapshot {
  readonly availability: "available";
  readonly generation: number;
  readonly groups: readonly LineGroup[];
  readonly chains: readonly LineChain[];
}

export class LineWorkspaceLoader {
  snapshot: LineWorkspaceSnapshot | undefined;
  availability: "unavailable" | "available" = "unavailable";
  error = "";

  constructor(private readonly call: Caller) {}

  async refresh(): Promise<LineWorkspaceSnapshot | undefined> {
    this.error = "";
    try {
      const [lineResult, chainResult] = await Promise.all([
        this.call(LINES_SERVICE, "list", {}) as Promise<{ groups?: LineGroup[] }>,
        this.call(LINES_SERVICE, "chains", {}) as Promise<{ chains?: LineChain[] }>,
      ]);
      const next = Object.freeze({
        availability: "available" as const,
        generation: (this.snapshot?.generation ?? 0) + 1,
        groups: Object.freeze([...(lineResult.groups ?? [])]),
        chains: Object.freeze([...(chainResult.chains ?? [])]),
      });
      this.snapshot = next;
      this.availability = "available";
      return next;
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : "Line workspace unavailable";
      this.availability = this.snapshot ? "available" : "unavailable";
      return this.snapshot;
    }
  }
}
