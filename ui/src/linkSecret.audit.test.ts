/**
 * Where a revealed subscription link may go. The token arrives only from
 * users-admin link_reveal, is held in identityLink.ts's `revealed`, drawn by
 * IdentityLinkPanel.vue, and leaves the frame only when the operator presses
 * Copy (the console's clipboard). It must never reach page state (the
 * console's address), the page's own address, storage, a log, or any other
 * postMessage. identityLink.test.ts pins that no call payload carries it, and
 * IdentityLinkPanel.dom.test.ts that the panel posts and stores nothing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

describe("a revealed link stays in the link section", () => {
  it("is read only by the section's state and its view", () => {
    // `.revealed` is the held reveal; nothing else in the page may read it.
    for (const file of ["./App.vue", "./UserSheet.vue", "./pageState.ts", "./bridge.ts", "./navigate.ts", "./planWatch.ts", "./usersModel.ts"]) {
      expect(read(file), file).not.toMatch(/\.revealed\b|revealedUrl|LinkReveal\b/);
    }
    expect(read("./IdentityLinkPanel.vue")).toMatch(/props\.link\.revealed\.value/);
  });

  it("is never written to page state, the address, storage or the console log", () => {
    for (const file of ["./identityLink.ts", "./IdentityLinkPanel.vue", "./identityLinkModel.ts"]) {
      const source = read(file);
      expect(source, file).not.toMatch(/sendState|history\.|location\.|localStorage|sessionStorage|console\.(log|info|warn|error|debug)/);
      expect(source, file).not.toMatch(/postMessage/);
    }
    // Page state is built from the page's own fields only.
    expect(read("./pageState.ts")).not.toMatch(/identityLink|token/i);
  });
});
