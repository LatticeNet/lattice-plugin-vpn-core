import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("vpn-core refresh policy", () => {
  it("keeps page data operator-driven instead of interval-polled", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./App.vue", import.meta.url)),
      "utf8",
    );

    expect(source).not.toContain("setInterval");
    expect(source).not.toContain("pollInterval");
    expect(source).toContain('@click="loadCurrent(true)"');
  });

  it("times one read only, a filed plan's watch, and bounds it", () => {
    const watch = readFileSync(fileURLToPath(new URL("./planWatch.ts", import.meta.url)), "utf8");
    // A timeout chain that re-arms only while a plan is pending, never an interval.
    expect(watch).not.toContain("setInterval");
    expect(watch).toContain("PLAN_WATCH_MAX_MS = 30 * 60_000");
    for (const file of ["./identityLink.ts", "./IdentityLinkPanel.vue"]) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      expect(source).not.toContain("setInterval");
    }
  });
});
