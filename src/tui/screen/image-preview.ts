import { stickyUpdate, type StickyScreen } from "./sticky";

export interface ImagePlacement {
  id: string; data: string; bytes: number; sourceWidth: number; sourceHeight: number;
  row: number; col: number; width: number; height: number; cellWidth: number; cellHeight: number;
}

/** Images aren't part of the text diff. Erase their old rows when moving/leaving,
 * and resend only if the image, geometry or text painted through it changed.
 * IIP is supported by xterm's image addon and iTerm2; bytes also work over SSH.
 * https://iterm2.com/documentation-images.html */
export function imagePreviewUpdate(next: StickyScreen, previous?: StickyScreen, image?: ImagePlacement, painted?: ImagePlacement): string {
  const same = image && painted && image.id === painted.id && image.row === painted.row && image.col === painted.col
    && image.width === painted.width && image.height === painted.height && image.cellWidth === painted.cellWidth && image.cellHeight === painted.cellHeight;
  const changed = (rect: ImagePlacement) => !previous || previous.cols !== next.cols || previous.rows.length !== next.rows.length
    || next.rows.slice(rect.row, rect.row + rect.height).some((line, i) => line !== previous.rows[rect.row + i]);
  const erase = painted && (!same || changed(painted));
  let before = previous;
  if (erase && previous) {
    const rows = [...previous.rows];
    for (let row = painted.row; row < Math.min(rows.length, painted.row + painted.height); row++) rows[row] = "\0";
    before = { ...previous, rows };
  }
  const output = stickyUpdate(next, before);
  if (!image || same && !erase && !changed(image)) return output;
  const scale = Math.min(1, image.width * image.cellWidth / image.sourceWidth, image.height * image.cellHeight / image.sourceHeight);
  const width = Math.max(1, Math.floor(image.sourceWidth * scale)), height = Math.max(1, Math.floor(image.sourceHeight * scale));
  // Fit both axes ourselves: older xterm IIP renderers ignore height when an
  // aspect-preserving width is set. Originals are never resized on disk.
  return output + `\x1b[${image.row + 1};${image.col + 1}H\x1b]1337;File=inline=1;size=${image.bytes};width=${width}px;height=${height}px;preserveAspectRatio=0:${image.data}\x07\x1b[${next.cursor + 1};${next.col + 1}H`;
}
