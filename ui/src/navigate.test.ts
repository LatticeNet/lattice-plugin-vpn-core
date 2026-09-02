import { describe, expect, it, vi } from "vitest";

import { evidenceRoute, hostOriginFromHash, NAVIGATE_MESSAGE_TYPE, postNavigate } from "./navigate";

describe("evidenceRoute", () => {
  it("names the node, the lens only when it is not the default, and the line by uuid", () => {
    expect(evidenceRoute("node_ob46mh4ltshdpkhc", "connections")).toBe("/platform/evidence?node_id=node_ob46mh4ltshdpkhc");
    expect(evidenceRoute("node_ob46mh4ltshdpkhc", "log")).toBe("/platform/evidence?node_id=node_ob46mh4ltshdpkhc&lens=log");
    expect(evidenceRoute("n", "connections", " 0000abcd-0000-4000-8000-000000000001 "))
      .toBe("/platform/evidence?node_id=n&line_uuid=0000abcd-0000-4000-8000-000000000001");
    expect(evidenceRoute("n", "log", "")).toBe("/platform/evidence?node_id=n&lens=log");
  });

  it("only ever uses keys the host allows for a plugin", () => {
    const keys = new Set(new URLSearchParams(evidenceRoute("n", "log", "u").split("?")[1]).keys());
    for (const key of keys) expect(["lens", "node_id", "line_uuid", "tab"]).toContain(key);
  });
});

describe("hostOriginFromHash", () => {
  it("reads the pinned host origin and refuses anything that is not http(s)", () => {
    expect(hostOriginFromHash("#lattice_nonce=abc&host_origin=https%3A%2F%2Flattice.roobli.org")).toBe("https://lattice.roobli.org");
    expect(hostOriginFromHash("#host_origin=http%3A%2F%2F127.0.0.1%3A5179%2Fdev.html")).toBe("http://127.0.0.1:5179");
    expect(hostOriginFromHash("#lattice_nonce=abc")).toBeNull();
    expect(hostOriginFromHash("#host_origin=javascript%3Aalert(1)")).toBeNull();
    expect(hostOriginFromHash("")).toBeNull();
  });
});

describe("postNavigate", () => {
  it("posts the route to the parent at the pinned origin and nowhere else", () => {
    const postMessage = vi.fn();
    const win = { parent: { postMessage } } as unknown as Window;
    postNavigate(win, "/platform/evidence?node_id=n", "https://lattice.roobli.org");
    expect(postMessage).toHaveBeenCalledWith({ type: NAVIGATE_MESSAGE_TYPE, route: "/platform/evidence?node_id=n" }, "https://lattice.roobli.org");
  });
});
