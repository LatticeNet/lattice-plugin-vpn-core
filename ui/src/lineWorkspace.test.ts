import { describe, expect, it, vi } from "vitest";

import { LineWorkspaceLoader } from "./lineWorkspace";
import type { LineChain, LineGroup } from "./vpnModel";

const groups: LineGroup[] = [{ node_id: "node-a", lines: [] }];

describe("LineWorkspaceLoader", () => {
  it("calls list and chains exactly once and publishes one immutable composite", async () => {
    const call = vi.fn(async (_service: string, method: string) => method === "list" ? { groups } : { chains: [] });
    const loader = new LineWorkspaceLoader(call);
    const snapshot = await loader.refresh();
    expect(call.mock.calls.map(([, method]) => method)).toEqual(["list", "chains"]);
    expect(snapshot).toMatchObject({ availability: "available", generation: 1, groups, chains: [] });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.groups[0])).toBe(true);
    expect(Object.isFrozen(snapshot?.groups[0].lines)).toBe(true);
  });

  it("deep-freezes copied lines, metadata, chains, current, and attempts", async () => {
    const sourceGroups: LineGroup[] = [{ node_id: "node-a", lines: [{
      id: "line-a", line_hash_id: "hash-a", line_uuid: "line-a", node_id: "node-a", core: "sing-box",
      source: "managed", managed: true, name: "A", user_count: 1, user_known: true,
      jump_edges: ["line-b"], declared_jump_edges: ["line-b"], metadata: { owner: "alpha" },
    }] }];
    const sourceChains: LineChain[] = [{
      source_line_uuid: "line-a", status: "applying",
      current: { target_line_uuid: "line-b", status: "converged" },
      attempt: { operation: "replace", candidate_target_line_uuid: "line-c", approval_id: "approval", status: "applying" },
    }];
    const loader = new LineWorkspaceLoader(async (_service, method) => method === "list" ? { groups: sourceGroups } : { chains: sourceChains });
    const snapshot = await loader.refresh();
    sourceGroups[0].lines[0].name = "mutated";
    sourceGroups[0].lines[0].jump_edges?.push("line-z");
    sourceGroups[0].lines[0].metadata!.owner = "mutated";
    sourceChains[0].current!.target_line_uuid = "line-z";
    sourceChains[0].attempt!.approval_id = "mutated";
    expect(snapshot?.groups[0].lines[0]).toMatchObject({ name: "A", jump_edges: ["line-b"], metadata: { owner: "alpha" } });
    expect(snapshot?.chains[0]).toMatchObject({ current: { target_line_uuid: "line-b" }, attempt: { approval_id: "approval" } });
    expect(Object.isFrozen(snapshot?.groups[0].lines[0].metadata)).toBe(true);
    expect(Object.isFrozen(snapshot?.chains[0].current)).toBe(true);
    expect(Object.isFrozen(snapshot?.chains[0].attempt)).toBe(true);
  });

  it("does not let an older successful refresh overwrite a newer publication", async () => {
    const deferred: Array<{ resolve: (value: unknown) => void; reject: (reason: Error) => void }> = [];
    const call = vi.fn(() => new Promise((resolve, reject) => deferred.push({ resolve, reject })));
    const loader = new LineWorkspaceLoader(call);
    const older = loader.refresh();
    const newer = loader.refresh();
    deferred[2].resolve({ groups: [{ node_id: "new", lines: [] }] });
    deferred[3].resolve({ chains: [] });
    await expect(newer).resolves.toMatchObject({ generation: 1, groups: [{ node_id: "new" }] });
    deferred[0].resolve({ groups: [{ node_id: "old", lines: [] }] });
    deferred[1].resolve({ chains: [] });
    await expect(older).resolves.toBe(loader.snapshot);
    expect(loader.snapshot).toMatchObject({ generation: 1, groups: [{ node_id: "new" }] });
  });

  it("does not let an older failed refresh overwrite the latest error state", async () => {
    const deferred: Array<{ resolve: (value: unknown) => void; reject: (reason: Error) => void }> = [];
    const loader = new LineWorkspaceLoader(() => new Promise((resolve, reject) => deferred.push({ resolve, reject })));
    const older = loader.refresh();
    const newer = loader.refresh();
    deferred[2].resolve({ groups: [{ node_id: "new", lines: [] }] });
    deferred[3].resolve({ chains: [] });
    await newer;
    deferred[0].resolve({ groups: [{ node_id: "old", lines: [] }] });
    deferred[1].reject(new Error("old failure"));
    await older;
    expect(loader.error).toBe("");
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
