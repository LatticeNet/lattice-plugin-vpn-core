import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

describe("vpn-core frame model", () => {
  it("never reports its own height back to the host", () => {
    // The host frame is a viewport it sizes itself and it ignores the reported
    // number. Measuring the document to say how tall it is costs a full
    // synchronous layout on every body resize and buys nothing.
    const app = read("./App.vue");
    expect(app).not.toContain("ResizeObserver");
    expect(app).not.toContain("bridge?.resize");
    expect(read("./bridge.ts")).not.toContain("lattice.plugin.resize");
  });

  it("bounds a table scrollport against the window rather than its row count", () => {
    // 111 rows left this box 5900px tall and the document 8800px tall, which on
    // a wide console is enough composited area to stop the renderer producing
    // frames at all. Every row still renders; only the painted box is capped.
    const css = read("./styles.css");
    expect(css).toContain(".table-wrap { width: 100%; max-height: calc(100dvh - var(--sp-7)); overflow: auto; }");
    expect(css).toContain("thead th { position: sticky; top: 0;");
  });
});
