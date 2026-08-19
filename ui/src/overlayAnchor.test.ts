import { describe, expect, it } from "vitest";

import { MIN_ANCHOR_TOP, anchorTopFrom, clampAnchorTop, isInsideOverlay } from "./overlayAnchor";

const rectEvent = (top: number) => ({
  currentTarget: { getBoundingClientRect: () => ({ top }) },
}) as unknown as Event;

describe("anchorTopFrom", () => {
  it("anchors just above the element the operator clicked", () => {
    expect(anchorTopFrom(rectEvent(940))).toBe(932);
  });

  it("never opens flush against the document top", () => {
    expect(anchorTopFrom(rectEvent(0))).toBe(MIN_ANCHOR_TOP);
    expect(anchorTopFrom(rectEvent(-400))).toBe(MIN_ANCHOR_TOP);
  });

  it("falls back to the top of the frame without an event", () => {
    expect(anchorTopFrom()).toBe(MIN_ANCHOR_TOP);
    expect(anchorTopFrom(null)).toBe(MIN_ANCHOR_TOP);
  });

  it("falls back to the event target when currentTarget cannot be measured", () => {
    // What a document-level capture listener actually sees.
    const event = {
      currentTarget: { nodeType: 9 },
      target: { getBoundingClientRect: () => ({ top: 5297 }) },
    } as unknown as Event;
    expect(anchorTopFrom(event)).toBe(5289);
  });

  it("ignores an event whose target cannot be measured", () => {
    expect(anchorTopFrom({ target: { nodeName: "DIV" } } as unknown as Event)).toBe(MIN_ANCHOR_TOP);
  });
});

describe("clampAnchorTop", () => {
  it("keeps a tall overlay inside the frame the host already sized", () => {
    expect(clampAnchorTop(2300, 640, 2400)).toBe(1748);
  });

  it("leaves an anchor alone when the overlay already fits below it", () => {
    expect(clampAnchorTop(400, 300, 2400)).toBe(400);
  });

  it("collapses to the minimum when the overlay cannot fit at all", () => {
    expect(clampAnchorTop(500, 900, 600)).toBe(MIN_ANCHOR_TOP);
  });
});

describe("isInsideOverlay", () => {
  it("detects a click inside an open overlay", () => {
    expect(isInsideOverlay({ closest: (value: string) => (value === ".overlay-scrim" ? {} : null) })).toBe(true);
  });

  it("treats page clicks and non-elements as outside", () => {
    expect(isInsideOverlay({ closest: () => null })).toBe(false);
    expect(isInsideOverlay(null)).toBe(false);
    expect(isInsideOverlay({})).toBe(false);
  });
});
