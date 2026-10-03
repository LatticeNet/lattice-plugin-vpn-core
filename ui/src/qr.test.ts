import { describe, expect, it } from "vitest";

import { QR_QUIET_ZONE, qrDrawing } from "./qr";
import { qrcodegen } from "./vendor/qrcodegen";

/** The dark modules a drawing's path paints, as "x,y" in code coordinates. */
function painted(path: string, border = QR_QUIET_ZONE): Set<string> {
  const cells = new Set<string>();
  for (const match of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
    const [x, y, run] = [Number(match[1]), Number(match[2]), Number(match[3])];
    for (let i = 0; i < run; i++) cells.add(`${x + i - border},${y - border}`);
  }
  return cells;
}

describe("a link drawn as a QR code", () => {
  it("paints exactly the encoder's dark modules inside a four-module quiet zone", () => {
    const url = "https://lattice.example/sub/u-ugfcac2kfd/ugfcaccr7aer5gsbfqvg8ftrmygydw4d666x469mz5h?target=ClashMeta";
    const drawing = qrDrawing(url);
    const code = qrcodegen.QrCode.encodeText(url, qrcodegen.QrCode.Ecc.MEDIUM);
    expect(drawing.size).toBe(code.size + 2 * QR_QUIET_ZONE);
    const expected = new Set<string>();
    for (let y = 0; y < code.size; y++) for (let x = 0; x < code.size; x++) if (code.getModule(x, y)) expected.add(`${x},${y}`);
    expect(painted(drawing.path)).toEqual(expected);
  });

  it("puts the three finder patterns in their corners", () => {
    const drawing = qrDrawing("HELLO WORLD");
    // Version 1 is 21 modules a side.
    expect(drawing.size).toBe(21 + 2 * QR_QUIET_ZONE);
    const cells = painted(drawing.path);
    for (const [ox, oy] of [[0, 0], [14, 0], [0, 14]]) {
      // The outer ring and the 3x3 core are dark; the ring between is light.
      expect(cells.has(`${ox},${oy}`)).toBe(true);
      expect(cells.has(`${ox + 6},${oy + 6}`)).toBe(true);
      expect(cells.has(`${ox + 3},${oy + 3}`)).toBe(true);
      expect(cells.has(`${ox + 1},${oy + 1}`)).toBe(false);
    }
  });

  it("is the same drawing for the same link, and differs for another token", () => {
    expect(qrDrawing("https://x.example/sub/u-a/t1").path).toBe(qrDrawing("https://x.example/sub/u-a/t1").path);
    expect(qrDrawing("https://x.example/sub/u-a/t1").path).not.toBe(qrDrawing("https://x.example/sub/u-a/t2").path);
  });
});
