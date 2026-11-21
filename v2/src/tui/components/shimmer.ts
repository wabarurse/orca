// The shimmer on what is running (a tool call's line, the conversation tail's
// "thinking…"), like Claude Code and Codex: a soft highlight band sweeps left
// to right across the text, once every SHIMMER_MS. Pure in `now`, so frames
// are deterministic under an injected clock. With truecolor and a known
// terminal background the band blends a mid grey towards the terminal's
// opposite (white on dark, black on light); otherwise it steps dim → normal →
// bold, as Codex does without truecolor. NO_COLOR: plain bold, no sweep.

import { cells } from "./text";
import { noColour, terminalBackground, truecolor, isLight, type Rgb } from "./style";

/** One sweep across the text. */
export const SHIMMER_MS = 2000;
/** Columns the band starts before the text and ends after it, so it enters and leaves smoothly. */
const PAD = 10;
/** Half the band's width, in columns. */
const HALF = 5;

type Env = Record<string, string | undefined>;

/** How bright column `i` is at `now`: 1 at the band's centre, 0 outside it. */
export function intensity(i: number, length: number, now: number): number {
  const pos = ((((now % SHIMMER_MS) + SHIMMER_MS) % SHIMMER_MS) / SHIMMER_MS) * (length + 2 * PAD) - PAD;
  const d = Math.abs(i - pos);
  return d < HALF ? 0.5 * (1 + Math.cos((Math.PI * d) / HALF)) : 0;
}

const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);

/** The SGR for a level of brightness: a blended grey with truecolor and a known background, else dim, normal or bold. */
function level(t: number, bg: Rgb | null): string {
  if (bg) {
    const to = isLight(bg) ? 0 : 255;
    const v = mix(mix(bg.r, to, 0.45), to, t);
    return `\x1b[38;2;${v};${v};${v}m`;
  }
  return t > 0.6 ? "\x1b[1m" : t > 0.2 ? "" : "\x1b[2m";
}

/** `text` (plain, one line) with the shimmer at `now`; each run of one style shares one SGR, and it ends reset. */
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
