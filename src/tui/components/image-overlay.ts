// Drawing a delivered image over the full screen, for terminals that speak the
// Kitty graphics protocol (Ghostty, Kitty, WezTerm). While `active`, the app's
// frame differ pauses so the image is not painted over, and the next key calls
// `close`. A terminal without the protocol, a non-PNG, or any failure returns
// false from `open`, and the app opens the desktop viewer instead.
import { fitCells, kittyClear, kittyImage, pngSize } from "./images";
import type { Terminal } from "./term";
import { dim } from "./text";

export class ImageOverlay {
  active = false;

  /** Load the image's bytes and draw it; true when it was drawn, false (any failure included) to use the viewer. */
  async show(term: Terminal, load: () => Promise<{ name: string; bytes: Uint8Array }>): Promise<boolean> {
    try { const { name, bytes } = await load(); return this.open(term, name, bytes); } catch { return false; }
  }

  /** Draw the PNG over the screen, scaled to fit. true when it was drawn; false to use the desktop viewer. */
  open(term: Terminal, name: string, png: Uint8Array): boolean {
    const size = pngSize(png);
    if (term.imageProtocol !== "kitty" || !size) return false;
    const cell = term.imageCell ?? { width: 10, height: 21 };
    const fit = fitCells(size, cell, { cols: Math.max(1, term.cols - 2), rows: Math.max(1, term.rows - 3) });
    this.active = true;
    term.write(`\x1b[2J\x1b[H${dim(`${name} — press any key to close`)}\x1b[2;1H${kittyImage(png, fit)}`);
    return true;
  }

  /** Remove the image. The app then forces a full repaint. */
  close(term: Terminal): void {
    this.active = false;
    term.write(kittyClear());
  }
}
