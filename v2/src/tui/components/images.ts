export function imageProtocol(env: Record<string, string | undefined>): "kitty" | null {
  const term = env.TERM ?? "", program = env.TERM_PROGRAM ?? "";
  const set = (name: string): boolean => (env[name] ?? "") !== "";
  if (term === "xterm-kitty" || set("KITTY_WINDOW_ID")) return "kitty";
  if (term === "xterm-ghostty" || program === "ghostty" || set("GHOSTTY_RESOURCES_DIR") || set("GHOSTTY_BIN_DIR")) return "kitty";
  if (program === "WezTerm" || set("WEZTERM_PANE")) return "kitty";
  return null;
}

export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

export function fitCells(
  image: { width: number; height: number },
  cell: { width: number; height: number },
  box: { cols: number; rows: number },
): { cols: number; rows: number } {
  const wantCols = image.width / Math.max(1, cell.width), wantRows = image.height / Math.max(1, cell.height);
  const scale = Math.min(box.cols / wantCols, box.rows / wantRows);
  return { cols: Math.max(1, Math.round(wantCols * scale)), rows: Math.max(1, Math.round(wantRows * scale)) };
}

const CHUNK = 4096;

export function kittyImage(png: Uint8Array, size: { cols: number; rows: number }): string {
  const data = Buffer.from(png).toString("base64");
  const chunks: string[] = [];
  for (let i = 0; i < data.length; i += CHUNK) chunks.push(data.slice(i, i + CHUNK));
  if (chunks.length === 0) chunks.push("");
  return chunks.map((chunk, i) => {
    const more = i < chunks.length - 1 ? 1 : 0;
    const control = i === 0 ? `a=T,f=100,c=${size.cols},r=${size.rows},m=${more}` : `m=${more}`;
    return `\x1b_G${control};${chunk}\x1b\\`;
  }).join("");
}

export function kittyClear(): string {
  return "\x1b_Ga=d\x1b\\";
}
