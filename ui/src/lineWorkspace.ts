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
  private refreshEpoch = 0;

  constructor(private readonly call: Caller) {}

  async refresh(): Promise<LineWorkspaceSnapshot | undefined> {
    const epoch = ++this.refreshEpoch;
    try {
      const [lineResult, chainResult] = await Promise.all([
        this.call(LINES_SERVICE, "list", {}) as Promise<{ groups?: LineGroup[] }>,
        this.call(LINES_SERVICE, "chains", {}) as Promise<{ chains?: LineChain[] }>,
      ]);
      if (epoch !== this.refreshEpoch) return this.snapshot;
      const next = Object.freeze({
        availability: "available" as const,
        generation: (this.snapshot?.generation ?? 0) + 1,
        groups: freezeGroups(lineResult.groups ?? []),
        chains: freezeChains(chainResult.chains ?? []),
      });
      this.snapshot = next;
      this.availability = "available";
      this.error = "";
      return next;
    } catch (cause) {
      if (epoch !== this.refreshEpoch) return this.snapshot;
      this.error = cause instanceof Error ? cause.message : "Line workspace unavailable";
      this.availability = this.snapshot ? "available" : "unavailable";
      return this.snapshot;
    }
  }
}

function freezeGroups(groups: readonly LineGroup[]): readonly LineGroup[] {
  return Object.freeze(groups.map((group) => Object.freeze({
    ...group,
    lines: Object.freeze(group.lines.map((line) => Object.freeze({
      ...line,
      jump_edges: line.jump_edges ? Object.freeze([...line.jump_edges]) : undefined,
      declared_jump_edges: line.declared_jump_edges ? Object.freeze([...line.declared_jump_edges]) : undefined,
      metadata: line.metadata ? Object.freeze({ ...line.metadata }) : undefined,
    }))) as unknown as LineGroup["lines"],
  })));
}

function freezeChains(chains: readonly LineChain[]): readonly LineChain[] {
  return Object.freeze(chains.map((chain) => Object.freeze({
    ...chain,
    current: chain.current ? Object.freeze({ ...chain.current }) : chain.current,
    attempt: chain.attempt ? Object.freeze({ ...chain.attempt }) : chain.attempt,
  })));
}
