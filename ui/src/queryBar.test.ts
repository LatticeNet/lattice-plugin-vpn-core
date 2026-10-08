/**
 * The query bar's stylesheet styles the bar and nothing else.
 *
 * vpn-core draws PcQueryBar from plugin-bridge without the bridge's
 * chassis.css (queryBar.css says why). Two things keep that honest across a
 * bridge bump: every class the bar draws has a rule in the port, so a new
 * part of the bar never renders unstyled, and no rule in the port can reach
 * an element outside the bar, so adopting it changes nothing else vpn-core
 * draws.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(join(here, file), "utf8");
/* The installed bridge, the one the bundle is built from (its exports are import-only, so not require.resolve). */
const queryBarSource = readFileSync(join(here, "..", "node_modules", "@latticenet", "plugin-bridge", "dist", "chassis", "queryBar.js"), "utf8");

const css = read("queryBar.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every rule's selector list, at the top level and inside @media blocks. */
function selectors(sheet: string): string[] {
  const out: string[] = [];
  const pattern = /([^{}@;]+)\{([^{}]*)\}/g;
  for (const match of sheet.matchAll(pattern)) out.push(...match[1].split(",").map((part) => part.trim()).filter(Boolean));
  return out;
}

/** Every rule as selector list and body, at any depth. */
function rules(sheet: string): Array<{ selector: string; body: string }> {
  return [...sheet.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1].trim(), body: match[2] }));
}

describe("the query bar stylesheet", () => {
  it("reaches only the bar, the row it stands in, and the panel it dims", () => {
    const all = selectors(css);
    expect(all.length).toBeGreaterThan(40);
    for (const selector of all) {
      // Anchored: a rule may start only at the bar, so `.x .pc-query` cannot pass.
      const scoped = /^\.pc-query(?![a-z])/.test(selector)
        || /^\.query-toolbar\b/.test(selector)
        || selector.startsWith('.data-panel[data-stale="true"]');
      expect(scoped, selector).toBe(true);
    }
    expect(css).not.toMatch(/:root|(^|[\s,}])(html|body|\*)\s*[{,]/);
  });

  it("declares its custom properties on the bar, never on the page", () => {
    for (const { selector, body } of rules(css)) {
      if (!/--[a-z-]+\s*:/.test(body)) continue;
      expect(selector, "a rule that declares a custom property").toBe(".pc-query");
    }
  });

  it("has a rule for every class the bar draws, and the property the bar reads inline", () => {
    const drawn = new Set(queryBarSource.match(/pc-query-[a-z-]+|pc-sr-only/g) ?? []);
    drawn.add("pc-query");
    // A suffix the bar builds at run time, never a class on its own.
    drawn.delete("pc-query-");
    expect(drawn.size).toBeGreaterThan(20);
    const styled = selectors(css).join(" ");
    for (const name of drawn) {
      // The id prefix the bar gives its parts, not a class.
      if (/pc-query-\d/.test(name)) continue;
      expect(styled, `.${name}`).toMatch(new RegExp(`\\.${name}(?![a-z-])`));
    }
    for (const inline of queryBarSource.match(/var\(--[a-z-]+/g) ?? []) {
      const property = inline.slice(4);
      expect(css, property).toMatch(new RegExp(`${property}\\s*:`));
    }
  });

  it("is the only part of the chassis stylesheet the page loads", () => {
    const sources = readdirSync(here).filter((file) => /\.(ts|vue|css)$/.test(file) && !file.endsWith(".test.ts"));
    for (const file of sources) expect(read(file), file).not.toMatch(/(import|@import)\s[^;\n]*chassis\.css/);
    expect(read("main.ts")).toMatch(/import "\.\/styles\.css";\s*import "\.\/queryBar\.css";/);
  });
});
