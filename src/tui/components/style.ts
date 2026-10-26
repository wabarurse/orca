// The background that sets the user's own text apart, like Codex's composer
// and user message cells: the input area and every "> …" row in the
// conversation are drawn on it, padded to the full width.
//
// The shade is the terminal's own background blended 10% towards white (dark
// terminals) or black (light ones), as Codex does. The terminal is asked for
// its background once at start (OSC 11, `BG_QUERY`; term.ts reads the reply);
// until it answers, or when it never does, COLORFGBG decides dark or light, and
// with neither a dark grey with an explicit light foreground is used, so the
// text stays readable on any terminal. Truecolor when COLORTERM says so, else
// the nearest xterm-256 colour. NO_COLOR (or TERM=dumb) turns it off; the "> "
// marker stays.

export interface Rgb { r: number; g: number; b: number }

type Env = Record<string, string | undefined>;

/** NO_COLOR (set and not empty) or TERM=dumb: no colours at all. */
export const noColour = (env: Env = process.env) => !!env.NO_COLOR || env.TERM === "dumb";
/** Whether 24-bit colour is supported, as COLORTERM says. */
export const truecolor = (env: Env = process.env) => /^(truecolor|24bit)$/i.test(env.COLORTERM ?? "");

/** Ask the terminal for its background colour; answered as `ESC ] 11 ; rgb:RRRR/GGGG/BBBB` and BEL or ST. */
export const BG_QUERY = "\x1b]11;?\x1b\\";
/** How long after the query a reply still counts; a later one is dropped, so the shade does not change after lines went into the scrollback. */
export const BG_REPLY_MS = 300;

/** The unknown-background fallback: grey 236 behind grey 252 text. */
const FALLBACK = "\x1b[48;5;236;38;5;252m";

/** Parse an OSC 11 reply body ("11;rgb:1e1e/1e1e/1e1e", "11;rgba:…", "11;#1e1e1e"); null for anything else. */
export function parseBgReply(body: string): Rgb | null {
  const m = /^11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\/[0-9a-f]{1,4})?$/i.exec(body);
  if (m) {
    const [r, g, b] = [m[1]!, m[2]!, m[3]!].map((h) => Math.round((parseInt(h, 16) / (16 ** h.length - 1)) * 255));
    return { r: r!, g: g!, b: b! };
  }
  const hex = /^11;#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(body);
  return hex ? { r: parseInt(hex[1]!, 16), g: parseInt(hex[2]!, 16), b: parseInt(hex[3]!, 16) } : null;
}

/** COLORFGBG ("fg;bg" or "fg;default;bg", ANSI indexes): black for a dark background, white for a light one, null when unset or unclear. */
function fromColorFgBg(v: string | undefined): Rgb | null {
  const bg = Number(v?.split(";").at(-1));
  if (!v || !Number.isInteger(bg) || bg < 0 || bg > 15) return null;
  return bg === 7 || bg >= 9 ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
}

export const isLight = (c: Rgb) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b > 128;

/** `c` moved `alpha` of the way towards white (dark backgrounds) or black (light ones). */
export function shade(c: Rgb, alpha = 0.1): Rgb {
  const to = isLight(c) ? 0 : 255;
  const mix = (v: number) => Math.round(v + (to - v) * alpha);
  return { r: mix(c.r), g: mix(c.g), b: mix(c.b) };
}

/** The xterm-256 palette entries above 15: the 6×6×6 cube, then the grey ramp. */
function palette(n: number): Rgb {
  if (n >= 232) { const v = 8 + 10 * (n - 232); return { r: v, g: v, b: v }; }
  const steps = [0, 95, 135, 175, 215, 255];
  const i = n - 16;
  return { r: steps[Math.floor(i / 36)]!, g: steps[Math.floor(i / 6) % 6]!, b: steps[i % 6]! };
}

/** The nearest xterm-256 colour (16–255; 0–15 are themed by the terminal, so never used). */
export function nearest256(c: Rgb): number {
  let best = 16;
  let dist = Infinity;
  for (let n = 16; n < 256; n++) {
    const p = palette(n);
    const d = (p.r - c.r) ** 2 + (p.g - c.g) ** 2 + (p.b - c.b) ** 2;
    if (d < dist) { dist = d; best = n; }
  }
  return best;
}

/** The SGR that starts the user background, or null for none; `terminal` is the background the terminal reported, if it did. */
export function pickFill(env: Env, terminal: Rgb | null = null): string | null {
  if (noColour(env)) return null;
  const bg = terminal ?? fromColorFgBg(env.COLORFGBG);
  if (!bg) return FALLBACK;
  const c = shade(bg);
  return truecolor(env) ? `\x1b[48;2;${c.r};${c.g};${c.b}m` : `\x1b[48;5;${nearest256(c)}m`;
}

let fill: string | null = pickFill(process.env);

/** The SGR that starts the user background now, or null when there is none. */
export const userFill = (): string | null => fill;
/** Set the user background directly (tests, or null to turn it off). */
export function setUserFill(f: string | null): void { fill = f; }
/** Use the background the terminal reported (OSC 11). */
export function useTerminalBackground(c: Rgb, env: Env = process.env): void { fill = pickFill(env, c); terminal = c; }

let terminal: Rgb | null = null;
/** The background the terminal reported, if it did (the shimmer blends towards its opposite). */
export const terminalBackground = (): Rgb | null => terminal;
/** Forget it (tests). */
export function setTerminalBackground(c: Rgb | null): void { terminal = c; }


const SGR = /\x1b\[([0-9;:]*)m/g;

/** How many arguments follow an extended colour (38/48/58) at ps[i]: 5;n or 2;r;g;b. */
export const colourArgs = (ps: string[], i: number) => (ps[i + 1] === "5" ? 2 : ps[i + 1] === "2" ? 4 : 1);

/** Whether one plain SGR param ends a background or foreground: a reset, 39 or 49. */
const resets = (p: string) => { const n = Number(p || 0); return n === 0 || n === 39 || n === 49; };

/** Whether an SGR's params end a background or foreground: a reset (empty, 0), 39 or 49; extended colour arguments are skipped. */
function resetsFill(params: string): boolean {
  if (params === "") return true;
  const ps = params.split(";");
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]!;
    if (/^(38|48|58)$/.test(p)) i += colourArgs(ps, i);
    else if (!p.includes(":") && resets(p)) return true; // 38:5:n / 48:2::r:g:b carry their own arguments
  }
  return false;
}

/**
 * One screen row (already wrapped to `cols`, escapes sanitized) drawn on
 * `fill`: the fill is re-applied after any reset inside, the row is padded with
 * spaces to `cols` display columns (CJK and emoji count two), and it ends reset.
 */
export function fillRow(row: string, cols: number, fill: string): string {
  const body = row.replace(SGR, (m, p: string) => (resetsFill(p) ? m + fill : m));
  return `${fill}${body}${" ".repeat(Math.max(0, cols - Bun.stringWidth(row)))}\x1b[0m`;
}
