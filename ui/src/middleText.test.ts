import { describe, expect, it } from "vitest";

import { splitTail } from "./middleText";

const tail = (text: string) => splitTail(text).tail;

describe("where an identifier is cut", () => {
  it("leaves short values whole", () => {
    expect(splitTail("hkg-edge-01")).toEqual({ head: "hkg-edge-01", tail: "" });
    expect(tail("lh_0000")).toBe("");
  });

  it("keeps the last numbered segment and what follows it", () => {
    expect(tail("frankfurt-equinix-fr5-transit-egress-cluster-node-001-primary")).toBe("-001-primary");
    expect(tail("/var/lib/lattice/managed/sing-box/generated/production/cluster-am7/node-001/config.observed.json")).toBe("-001/config.observed.json");
  });

  it("widens a short tail to whole segments", () => {
    expect(tail("[cd]-qqpw-VDS-cd1")).toBe("-VDS-cd1");
    expect(tail("[Metix]-Aaitr-Frontier-VDS")).toBe("-Frontier-VDS");
  });

  it("falls back to the last segment when the last number is too far from the end", () => {
    expect(tail("frankfurt-equinix-fr5-transit-egress-cluster")).toBe("-cluster");
  });

  it("keeps the last eight characters of one long run", () => {
    expect(tail("01J8ZQK4X9F7M2P5R8T1V4W7Y0")).toBe("T1V4W7Y0");
    const shared = "nd_01J8ZQK4X9F7M2P5R8T1V4W7Y0B3D6G9J2L5N8Q1S4U7X0Z3C6F9H2K5M8P1R4";
    expect(tail(`${shared}0A`)).toBe("M8P1R40A");
  });

  it("keeps values that differ only at the end distinct", () => {
    const shared = "nd_01J8ZQK4X9F7M2P5R8T1V4W7Y0B3D6G9J2L5N8Q1S4U7X0Z3C6F9H2K5M8P1R4";
    const ids = Array.from({ length: 136 }, (_, i) => `${shared}${i.toString(32).toUpperCase().padStart(2, "0")}`);
    expect(new Set(ids.map(tail)).size).toBe(ids.length);
    const names = Array.from({ length: 21 }, (_, i) => `${["frankfurt-equinix-fr5", "amsterdam-equinix-am7", "singapore-equinix-sg3"][i % 3]}-transit-egress-cluster-node-${String(i + 1).padStart(3, "0")}-${i % 2 ? "secondary" : "primary"}`);
    expect(new Set(names.map(tail)).size).toBe(names.length);
  });

  it("puts every character in exactly one half", () => {
    for (const text of ["[Metix]-Aaitr-Frontier-NAT", "01J8ZQK4X9F7M2P5R8T1V4W7Y0", "a-b-c-d-e-f-g-h-i-j-k-l", "节点-香港-边缘-0001-主"]) {
      const { head, tail: end } = splitTail(text);
      expect(head + end).toBe(text);
      expect(head.length).toBeGreaterThan(0);
    }
  });

  it("never splits a surrogate pair", () => {
    const text = `${"x".repeat(20)}\u{1F600}abcdefg`;
    const { tail: end } = splitTail(text);
    expect(end.startsWith("\u{1F600}")).toBe(true);
  });
});
