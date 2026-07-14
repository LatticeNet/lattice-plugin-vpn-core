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
});
