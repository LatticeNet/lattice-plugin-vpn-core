import { describe, expect, it, vi } from "vitest";

import { LineWorkspaceLoader } from "./lineWorkspace";
import type { LineGroup } from "./vpnModel";

const groups: LineGroup[] = [{ node_id: "node-a", lines: [] }];

describe("LineWorkspaceLoader", () => {
  it("calls list and chains exactly once and publishes one immutable composite", async () => {
    const call = vi.fn(async (_service: string, method: string) => method === "list" ? { groups } : { chains: [] });
    const loader = new LineWorkspaceLoader(call);
    const snapshot = await loader.refresh();
    expect(call.mock.calls.map(([, method]) => method)).toEqual(["list", "chains"]);
    expect(snapshot).toMatchObject({ availability: "available", generation: 1, groups, chains: [] });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("retains last-good data and rejects a mixed refresh generation", async () => {
    let failChains = false;
    const call = vi.fn(async (_service: string, method: string) => {
      if (method === "chains" && failChains) throw new Error("chains unavailable");
      return method === "list" ? { groups } : { chains: [] };
    });
    const loader = new LineWorkspaceLoader(call);
    const good = await loader.refresh();
    failChains = true;
    const stale = await loader.refresh();
    expect(stale).toBe(good);
    expect(loader.error).toBe("chains unavailable");
    expect(loader.snapshot?.generation).toBe(1);
  });

  it("distinguishes unavailable from an available empty workspace", async () => {
    const unavailable = new LineWorkspaceLoader(async () => { throw new Error("offline"); });
    await expect(unavailable.refresh()).resolves.toBeUndefined();
    expect(unavailable.availability).toBe("unavailable");

    const empty = new LineWorkspaceLoader(async (_service, method) => method === "list" ? { groups: [] } : { chains: [] });
    await expect(empty.refresh()).resolves.toMatchObject({ availability: "available", groups: [], chains: [] });
  });

  it("uses only fleet line RPCs and never invokes a node RPC", async () => {
    const call = vi.fn(async (_service: string, _method: string) => ({ groups: [], chains: [] }));
    await new LineWorkspaceLoader(call).refresh();
    expect(call.mock.calls.every(([service]) => service === "latticenet.vpn-core/lines")).toBe(true);
  });
});
