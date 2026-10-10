// @vitest-environment jsdom
import { createApp, h } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import MiddleText from "./MiddleText.vue";
import { markWholeSelected, widenToCopies } from "./middleText";

/* Layout is not computed here, so this guards the structure the copy relies
 * on; the harness check (`?layout=1`, property 4) selects every cut value in
 * a real engine and compares what it copies. */

const NODE = "amsterdam-equinix-am7-transit-egress-cluster-node-017-primary";

function mount(props: { text: string; suffix?: string }): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  createApp({ render: () => h(MiddleText, props) }).mount(host);
  return host;
}

/* The text an assistive technology reads: every text node outside an
 * aria-hidden subtree. */
function spoken(root: Node): string {
  let out = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest("[aria-hidden='true']")) out += node.textContent;
  }
  return out;
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

describe("a middle-cut value", () => {
  it("is read once, whole, and its cut face is hidden from assistive technology", () => {
    const host = mount({ text: NODE });
    expect(host.querySelector(".mid-face")?.getAttribute("aria-hidden")).toBe("true");
    expect(host.querySelector(".mid-head")?.textContent).toBe("amsterdam-equinix-am7-transit-egress-cluster-node");
    expect(host.querySelector(".mid-tail")?.textContent).toBe("-017-primary");
    expect(host.querySelector(".mid-copy")?.textContent).toBe(NODE);
    expect(spoken(host)).toBe(NODE);
  });

  it("reads the suffix with the value it follows", () => {
    const host = mount({ text: "VLESS-REALITY-34656.json", suffix: " +2" });
    expect(spoken(host)).toBe("VLESS-REALITY-34656.json +2");
    expect(host.querySelector(".mid-tail")?.textContent).toBe("-34656.json +2");
  });

  it("collapses white space in the copy and the face alike, as the end-truncated cell showed and copied it", () => {
    /* The copy is in flow and sizes the box, so a newline kept under `pre`
     * would make the row two lines tall. The cell it replaced copied and read
     * "edge node frankfurt -017-primary" too. */
    const host = mount({ text: "edge\tnode  frankfurt\n-017-primary" });
    expect(host.querySelector(".mid-copy")?.textContent).toBe("edge node frankfurt -017-primary");
    expect(host.querySelector(".mid-face")?.textContent).toBe("edge node frankfurt -017-primary");
  });
});

describe("a value selected whole", () => {
  it("is marked, so its face can take the selection's text colour, and only while it is whole", () => {
    const first = mount({ text: NODE });
    const second = mount({ text: "nd_01J8ZQK4X9F7M2P5R8T1V4W7Y0B3D6G9J2L5N8Q1S4U7X0Z3C6F9H2K5M8P1R40H" });
    const [a, b] = [first, second].map((host) => host.querySelector<HTMLElement>(".mid-text")!);
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStartBefore(first);
    range.setEndAfter(second);
    selection.removeAllRanges();
    selection.addRange(range);
    markWholeSelected(document);
    expect([a.hasAttribute("data-whole-selected"), b.hasAttribute("data-whole-selected")]).toEqual([true, true]);
    const part = document.createRange();
    part.setStart(a.querySelector(".mid-copy")!.firstChild!, 0);
    part.setEnd(b.querySelector(".mid-copy")!.firstChild!, 5);
    selection.removeAllRanges();
    selection.addRange(part);
    markWholeSelected(document);
    expect([a.hasAttribute("data-whole-selected"), b.hasAttribute("data-whole-selected")]).toEqual([true, false]);
    selection.removeAllRanges();
    markWholeSelected(document);
    expect(document.querySelectorAll("[data-whole-selected]")).toHaveLength(0);
  });
});

describe("the selection colours", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.selectionRecolours;
  });

  async function load(platform: string): Promise<string | undefined> {
    delete document.documentElement.dataset.selectionRecolours;
    vi.resetModules();
    vi.stubGlobal("navigator", { platform });
    await import("./MiddleText.vue");
    return document.documentElement.dataset.selectionRecolours;
  }

  it("are the copy's own where the platform paints selected text in a selection colour", async () => {
    expect(await load("Linux x86_64")).toBe("");
    expect(await load("Win32")).toBe("");
  });

  it("are the engine's on Apple platforms, which keep selected text in its own colour", async () => {
    expect(await load("MacIntel")).toBeUndefined();
    expect(await load("iPhone")).toBeUndefined();
  });
});

describe("a selection that ends inside a cut value", () => {
  function table(): { copies: HTMLElement[]; before: Text; after: Text } {
    const host = mount({ text: NODE });
    const second = mount({ text: "nd_01J8ZQK4X9F7M2P5R8T1V4W7Y0B3D6G9J2L5N8Q1S4U7X0Z3C6F9H2K5M8P1R40H" });
    const before = document.createTextNode("node ");
    const after = document.createTextNode(" exit");
    host.prepend(before);
    second.append(after);
    return { copies: [host, second].map((el) => el.querySelector<HTMLElement>(".mid-copy")!), before, after };
  }
  function select(startNode: Node, startOffset: number, endNode: Node, endOffset: number): Selection {
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    selection.removeAllRanges();
    selection.addRange(range);
    return selection;
  }

  it("takes the whole value at either end", () => {
    const { copies, before, after } = table();
    const into = select(before, 2, copies[0].firstChild!, 20);
    expect(widenToCopies(into)).toBe(true);
    expect(into.toString().endsWith(NODE)).toBe(true);
    const outOf = select(copies[1].firstChild!, 30, after, 3);
    expect(widenToCopies(outOf)).toBe(true);
    expect(outOf.toString().startsWith("nd_01J8ZQK4X9F7")).toBe(true);
  });

  it("takes the whole value when the selection starts and ends inside it", () => {
    const { copies } = table();
    const inside = select(copies[0].firstChild!, 3, copies[0].firstChild!, 30);
    expect(widenToCopies(inside)).toBe(true);
    expect(inside.toString()).toBe(NODE);
  });

  it("takes the whole value when an end is in the face or between the layers", () => {
    const { copies, before } = table();
    const mid = copies[0].parentElement!;
    const inFace = select(before, 2, mid.querySelector(".mid-tail")!.firstChild!, 3);
    expect(widenToCopies(inFace)).toBe(true);
    expect(inFace.toString()).toBe(`de ${NODE}`);
    const between = select(before, 2, mid, 1);
    expect(widenToCopies(between)).toBe(true);
    expect(between.toString()).toBe(`de ${NODE}`);
  });

  it("takes the whole value when an end sits right after it, where a press in the cell padding lands", () => {
    const { copies, before } = table();
    const mid = copies[0].parentElement!;
    const host = mid.parentElement!;
    const after = select(before, 0, host, Array.from(host.childNodes).indexOf(mid) + 1);
    expect(widenToCopies(after)).toBe(true);
    expect(after.getRangeAt(0).endContainer).toBe(copies[0]);
    const right = select(host, Array.from(host.childNodes).indexOf(mid), copies[0].firstChild!, 9);
    expect(widenToCopies(right)).toBe(true);
    expect(right.toString()).toBe(NODE);
  });

  it("leaves out a value that only touches the selection from outside", () => {
    const { copies, after } = table();
    const mid = copies[1].parentElement!;
    const host = mid.parentElement!;
    const start = Array.from(host.childNodes).indexOf(mid) + 1;
    const beyond = select(host, start, after, 3);
    expect(widenToCopies(beyond)).toBe(false);
    expect(beyond.toString()).toBe(" ex");
  });

  describe("a drag that leaves only a caret in a value", () => {
    /* jsdom lays nothing out, so the value's box and its cell are given. */
    function placed(): { copy: HTMLElement; caret: Selection } {
      const { copies } = table();
      const mid = copies[0].parentElement!;
      const box = { left: 100, right: 300, top: 40, bottom: 52 };
      const cell = { left: 88, right: 400, top: 20, bottom: 66 };
      vi.spyOn(mid, "getBoundingClientRect").mockReturnValue(box as DOMRect);
      const host = mid.parentElement!;
      vi.spyOn(host, "getBoundingClientRect").mockReturnValue(cell as DOMRect);
      return { copy: copies[0], caret: select(copies[0].firstChild!, 17, copies[0].firstChild!, 17) };
    }

    it("takes the whole value when the drag crossed the value's box in its cell", () => {
      const { caret } = placed();
      expect(widenToCopies(caret, { from: { x: 90, y: 46 }, to: { x: 200, y: 46 } })).toBe(true);
      expect(caret.toString()).toBe(NODE);
    });

    it("selects nothing for a click, a drag beside the value, or a drag from another row", () => {
      const { caret } = placed();
      expect(widenToCopies(caret, { from: { x: 150, y: 46 }, to: { x: 151, y: 46 } })).toBe(false);
      expect(widenToCopies(caret, { from: { x: 320, y: 46 }, to: { x: 390, y: 46 } })).toBe(false);
      expect(widenToCopies(caret, { from: { x: 90, y: 5 }, to: { x: 200, y: 46 } })).toBe(false);
      expect(widenToCopies(caret)).toBe(false);
      expect(caret.isCollapsed).toBe(true);
    });
  });

  it("leaves a selection alone that already holds whole values or none", () => {
    const { copies, before, after } = table();
    const whole = select(copies[0], 0, copies[0], 1);
    expect(widenToCopies(whole)).toBe(false);
    expect(whole.toString()).toBe(NODE);
    const outside = select(before, 0, before, 4);
    expect(widenToCopies(outside)).toBe(false);
    expect(outside.toString()).toBe("node");
    expect(widenToCopies(select(after, 1, after, 1))).toBe(false);
  });

  it("is widened when the pointer that made it is released", () => {
    const { copies } = table();
    const selection = select(copies[0].firstChild!, 3, copies[0].firstChild!, 30);
    document.dispatchEvent(new Event("pointerup"));
    expect(selection.toString()).toBe(NODE);
  });
});
