import { cells } from "./text";
import { noColour, terminalBackground, truecolor, isLight, nearest256, type Rgb } from "./style";

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

export const WAVE_MS = 330;
export const GLOW_MS = 2500;
const WAVE = [..."~∽^∽~∽~^"];
const GLOW_BASE: Rgb = { r: 110, g: 150, b: 210 };
const GLOW_PEAK: Rgb = { r: 235, g: 248, b: 255 };

export function waves(now: number): string {
  const step = Math.floor(Math.max(0, now) / WAVE_MS);
  return [0, 1, 2].map(i => WAVE[(i + step) % WAVE.length] ?? "~").join("");
}

export function glow(i: number, length: number, now: number): number {
  const pos = ((((now % GLOW_MS) + GLOW_MS) % GLOW_MS) / GLOW_MS) * (length + 6) - 3;
  return Math.max(0, 1 - Math.abs(i - pos) / 2.5);
}

const glowColour = (k: number) => `\x1b[38;2;${mix(GLOW_BASE.r, GLOW_PEAK.r, k * k)};${mix(GLOW_BASE.g, GLOW_PEAK.g, k * k)};${mix(GLOW_BASE.b, GLOW_PEAK.b, k * k)}m`;

export function swimming(elapsed: string | null, now: number, env: Env = process.env): string {
  const text = `${waves(now)} swimming`;
  const after = elapsed === null ? "" : ` (${elapsed})`;
  if (noColour(env)) return `${text}${after}`;
  const rest = after === "" ? "" : `\x1b[2m${after}\x1b[0m`;
  if (!truecolor(env)) return `\x1b[38;5;${nearest256(GLOW_BASE)}m${text}\x1b[0m${rest}`;
  const cs = cells(text);
  let out = "";
  let style: string | null = null;
  cs.forEach((c, i) => {
    const s = glowColour(glow(i, cs.length, now));
    if (s !== style) { out += s; style = s; }
    out += c.text;
  });
  return `${out}\x1b[0m${rest}`;
}
