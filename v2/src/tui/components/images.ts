// Drawing an image in the terminal with the Kitty graphics protocol, which
// Ghostty, Kitty and WezTerm speak. Everything here is pure: env in, escape
// strings out. term.ts writes them; app.ts drives the overlay. A terminal that
// does not speak the protocol gets null and the caller opens the desktop viewer.
//
// Protocol: https://sw.kovidgoyal.net/kitty/graphics-protocol/

/** The image protocol a terminal supports, decided from its environment. Only Kitty graphics for now;
 * Ghostty does not answer iTerm2's cell-size query (CSI 16 t is its way), so TERM is the reliable signal. */
export function imageProtocol(env: Record<string, string | undefined>): "kitty" | null {
  const term = env.TERM ?? "", program = env.TERM_PROGRAM ?? "";
  if (term === "xterm-kitty" || env.KITTY_WINDOW_ID) return "kitty";
  if (term === "xterm-ghostty" || program === "ghostty" || env.GHOSTTY_RESOURCES_DIR || env.GHOSTTY_BIN_DIR) return "kitty";
  if (program === "WezTerm" || env.WEZTERM_PANE) return "kitty";
  return null;
}

/** A PNG's pixel size from its IHDR, or null when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Fit an image into a cell box without distortion. A cell is cellW×cellH pixels (assume 10×21 when the
 * terminal never reported it); the image keeps its aspect ratio and fills whichever side binds first. */
export function fitCells(
  image: { width: number; height: number },
  cell: { width: number; height: number },
  box: { cols: number; rows: number },
): { cols: number; rows: number } {
  const wantCols = image.width / Math.max(1, cell.width), wantRows = image.height / Math.max(1, cell.height);
  const scale = Math.min(box.cols / wantCols, box.rows / wantRows);
  return { cols: Math.max(1, Math.round(wantCols * scale)), rows: Math.max(1, Math.round(wantRows * scale)) };
}

const CHUNK = 4096; // kitty's maximum base64 payload per escape.

/** The Kitty escape(s) that transmit a PNG and display it at the cursor, scaled to cols×rows cells.
 * Large images are split across escapes with the m=1/m=0 continuation flag. */
export function kittyImage(png: Uint8Array, size: { cols: number; rows: number }): string {
  const data = Buffer.from(png).toString("base64");
  const chunks: string[] = [];
  for (let i = 0; i < data.length; i += CHUNK) chunks.push(data.slice(i, i + CHUNK));
  if (!chunks.length) chunks.push("");
  return chunks.map((chunk, i) => {
    const more = i < chunks.length - 1 ? 1 : 0;
    const control = i === 0 ? `a=T,f=100,c=${size.cols},r=${size.rows},m=${more}` : `m=${more}`;
    return `\x1b_G${control};${chunk}\x1b\\`;
  }).join("");
}

/** Delete every image the terminal is showing. */
export function kittyClear(): string {
  return "\x1b_Ga=d\x1b\\";
}
