export const pastel = { grey: "38;5;246", red: "38;5;217", yellow: "38;5;223", green: "38;5;151", cyan: "38;5;152", purple: "38;5;183", blue: "38;5;67", lightBlue: "38;5;153" };

export const railMark = (s: string) => noColour() ? `\x1b[2m${s}\x1b[0m` : `\x1b[${pastel.blue}m${s}\x1b[0m`;

export type Rgb = { r: number; g: number; b: number };

type Env = Record<string, string | undefined>;

export const noColour = (env: Env = process.env) => (env.NO_COLOR ?? "") !== "" || env.TERM === "dumb";
export const truecolor = (env: Env = process.env) => /^(truecolor|24bit)$/i.test(env.COLORTERM ?? "");

export const BG_REPLY_MS = 300;

const FALLBACK = "\x1b[48;5;236;38;5;252m";

function fromColorFgBg(v: string | undefined): Rgb | null {
  const bg = Number(v?.split(";").at(-1));
  if (v === undefined || v === "" || !Number.isInteger(bg) || bg < 0 || bg > 15) return null;
  return bg === 7 || bg >= 9 ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
}

export const isLight = (c: Rgb) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b > 128;

export function shade(c: Rgb, alpha = 0.1): Rgb {
  const to = isLight(c) ? 0 : 255;
  const mix = (v: number) => Math.round(v + (to - v) * alpha);
  return { r: mix(c.r), g: mix(c.g), b: mix(c.b) };
}

function palette(n: number): Rgb {
  if (n >= 232) { const v = 8 + 10 * (n - 232); return { r: v, g: v, b: v }; }
  const steps = [0, 95, 135, 175, 215, 255];
  const i = n - 16;
  const step = (at: number): number => steps[at] ?? 0;
  return { r: step(Math.floor(i / 36)), g: step(Math.floor(i / 6) % 6), b: step(i % 6) };
}

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

export function pickFill(env: Env, terminal: Rgb | null = null): string | null {
  if (noColour(env)) return null;
  const bg = terminal ?? fromColorFgBg(env.COLORFGBG);
  if (bg === null) return FALLBACK;
  const c = shade(bg);
  return truecolor(env) ? `\x1b[48;2;${c.r};${c.g};${c.b}m` : `\x1b[48;5;${nearest256(c)}m`;
}

export function pickText(env: Env, terminal: Rgb | null = null): string | null {
  if (noColour(env)) return null;
  const bg = terminal ?? fromColorFgBg(env.COLORFGBG);
  if (bg === null || isLight(bg)) return null;
  return truecolor(env) ? "\x1b[38;2;255;255;255m" : "\x1b[38;5;231m";
}

let fill: string | null = pickFill(process.env);
let text: string | null = pickText(process.env);
export const baseText = (): string | null => text;
export function setBaseText(t: string | null): void { text = t; }

export const userFill = (): string | null => fill;
export function setUserFill(f: string | null): void { fill = f; }
export function useTerminalBackground(c: Rgb, env: Env = process.env): void { fill = pickFill(env, c); text = pickText(env, c); terminal = c; }

let terminal: Rgb | null = null;
export const terminalBackground = (): Rgb | null => terminal;
export function setTerminalBackground(c: Rgb | null): void { terminal = c; }

const SGR = /\x1b\[([0-9;:]*)m/g;

export const colourArgs = (ps: string[], i: number) => (ps[i + 1] === "5" ? 2 : ps[i + 1] === "2" ? 4 : 1);

const resets = (p: string) => { const n = p === "" ? 0 : Number(p); return n === 0 || n === 39 || n === 49; };

function resetsFill(params: string): boolean {
  if (params === "") return true;
  const ps = params.split(";");
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i] ?? "";
    if (/^(38|48|58)$/.test(p)) i += colourArgs(ps, i);
    else if (!p.includes(":") && resets(p)) return true;
  }
  return false;
}

export function fillRow(row: string, cols: number, fill: string): string {
  const body = row.replace(SGR, (m, p: string) => (resetsFill(p) ? m + fill : m));
  return `${fill}${body}${" ".repeat(Math.max(0, cols - Bun.stringWidth(row)))}\x1b[0m`;
}

export function textRow(row: string, colour: string): string {
  return colour + row.replace(SGR, (m, p: string) => (resetsFill(p) ? m + colour : m));
}

export function selectionMarks(env: Env = process.env, background: Rgb | null = terminal): { on: string; off: string } {
  if (noColour(env)) return { on: "\x1b[7m", off: "\x1b[27m" };
  const light = background !== null && isLight(background);
  if (truecolor(env)) return { on: light ? "\x1b[48;2;179;215;255m" : "\x1b[48;2;38;79;120m", off: "\x1b[49m" };
  return { on: light ? "\x1b[48;5;153m" : "\x1b[48;5;24m", off: "\x1b[49m" };
}
