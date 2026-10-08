/**
 * Where a pasted outbound may go. It is typed into ProbePanel.vue's textarea,
 * held in probe.ts's `draft`, read by probeModel.ts, and leaves the frame
 * only as the payload of the run call. It must never reach page state (the
 * console's address), the page's own address, storage, a log, or any other
 * postMessage. These are source checks; the behaviour is held by
 * App.probe.frame.test.ts, which mounts the page with a fake console and
 * inspects every message it posts, and ProbePanel.dom.test.ts, which checks
 * the page never draws a credential outside the textarea.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

describe("a pasted outbound stays in the Probe layer", () => {
  it("is never written to page state, the address, storage, the console log or another message", () => {
    for (const file of ["./probe.ts", "./ProbePanel.vue", "./probeModel.ts", "./textareaCaret.ts"]) {
      const source = read(file);
      expect(source, file).not.toMatch(/sendState|history\.|location\.|localStorage|sessionStorage|indexedDB|console\.(log|info|warn|error|debug)/);
      expect(source, file).not.toMatch(/postMessage|\.copy\(/);
    }
  });

  it("is read only by the layer's state and its view", () => {
    // `.draft` is the paste; outside the layer only App.vue's dispose path may touch the instance.
    for (const file of ["./pageState.ts", "./bridge.ts", "./navigate.ts", "./vpnModel.ts"]) {
      expect(read(file), file).not.toMatch(/\.draft\b|useProbe|\bprobe\.[a-z]/);
    }
    expect(read("./App.vue")).not.toMatch(/probe\.draft|probe\.request|probe\.read\b/);
  });

  it("is laid out for Show in editor only with its letters and digits masked", () => {
    // The unseen copy that measures where a fault is drawn holds the masked value, never el.value itself.
    const caret = read("./textareaCaret.ts");
    expect(caret).toMatch(/const masked = maskForLayout\(el\.value\);/);
    expect(caret).not.toMatch(/textContent = el\.value/);
  });

  it("is never quoted from the engine's own parse error", () => {
    // V8's JSON.parse message repeats the text around the fault.
    const model = read("./probeModel.ts");
    // The native parse binds no error at all, so its message cannot be shown.
    expect(model).toMatch(/value = JSON\.parse\(text\);\s*\} catch \{\s*const fault = jsonFault\(text\)/);
  });
});
