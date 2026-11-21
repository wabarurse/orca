import { cells } from "./text";
import { noColour, terminalBackground, truecolor, isLight, type Rgb } from "./style";

export const SHIMMER_MS = 2000;
const PAD = 10;
const HALF = 5;

type Env = Record<string, string | undefined>;

export function intensity(i: number, length: number, now: number): number {
  const pos = ((((now % SHIMMER_MS) + SHIMMER_MS) % SHIMMER_MS) / SHIMMER_MS) * (length + 2 * PAD) - PAD;
  const d = Math.abs(i - pos);
  return d < HALF ? 0.5 * (1 + Math.cos((Math.PI * d) / HALF)) : 0;
}

const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);

function level(t: number, bg: Rgb | null): string {
  if (bg !== null) {
    const to = isLight(bg) ? 0 : 255;
    const v = mix(mix(bg.r, to, 0.45), to, t);
    return `\x1b[38;2;${v};${v};${v}m`;
  }
  return t > 0.6 ? "\x1b[1m" : t > 0.2 ? "" : "\x1b[2m";
}

export function shimmer(text: string, now: number, env: Env = process.env): string {
  if (noColour(env)) return `\x1b[1m${text}\x1b[0m`;
  const bg = truecolor(env) ? terminalBackground() : null;
  const cs = cells(text);
  let out = "";
  let style: string | null = null;
  cs.forEach((c, i) => {
    const s = level(intensity(i, cs.length, now), bg);
    if (s !== style) { out += `\x1b[0m${s}`; style = s; }
    out += c.text;
  });
  return `${out}\x1b[0m`;
}
