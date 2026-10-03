/**
 * qr.ts, a subscription link as a QR code the page draws itself.
 *
 * A link is a credential, so it never leaves the page to be encoded: the
 * vendored encoder (vendor/qrcodegen.ts) runs here and the result is one SVG
 * path, which the panel paints dark on a light square in either theme,
 * because phone scanners read dark modules on a light ground most reliably.
 *
 * Medium error correction is enough on a screen and keeps a 120-character
 * link at a size a phone resolves from arm's length.
 */
import { qrcodegen } from "./vendor/qrcodegen";

export interface QrDrawing {
  /** Modules per side, quiet zone included: the SVG viewBox is size x size. */
  size: number;
  /** Every dark module, as horizontal runs, in viewBox units. */
  path: string;
}

/** The quiet zone the QR specification asks for, in modules. */
export const QR_QUIET_ZONE = 4;

export function qrDrawing(text: string, border = QR_QUIET_ZONE): QrDrawing {
  const code = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
  let path = "";
  for (let y = 0; y < code.size; y++) {
    let x = 0;
    while (x < code.size) {
      if (!code.getModule(x, y)) {
        x++;
        continue;
      }
      const start = x;
      while (x < code.size && code.getModule(x, y)) x++;
      const run = x - start;
      path += `M${start + border} ${y + border}h${run}v1h-${run}z`;
    }
  }
  return { size: code.size + border * 2, path };
}
