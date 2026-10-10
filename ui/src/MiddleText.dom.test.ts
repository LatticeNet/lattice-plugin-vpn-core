// @vitest-environment jsdom
import { createApp, h } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import MiddleText from "./MiddleText.vue";
import { widenToCopies } from "./middleText";

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

  it("keeps the value exactly in the copy while the face collapses white space as a cell did", () => {
    const name = "edge\tnode  frankfurt\n-017-primary";
    const host = mount({ text: name });
    expect(host.querySelector(".mid-copy")?.textContent).toBe(name);
    const face = host.querySelector(".mid-face")?.textContent;
    expect(face).toBe("edge node frankfurt -017-primary");
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
