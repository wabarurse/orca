import { RGBA, StyledText, TextAttributes, type TextChunk } from "@opentui/core";

type Style = { fg: RGBA | null; bg: RGBA | null; attributes: number; link: string | null };

const PLAIN: Style = { fg: null, bg: null, attributes: TextAttributes.NONE, link: null };
const ESCAPE = /\x1b\[([0-9;:]*)m|\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)|\x1b\[[0-9;?<>=]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;
const SET: Record<number, number> = { 1: TextAttributes.BOLD, 2: TextAttributes.DIM, 3: TextAttributes.ITALIC, 4: TextAttributes.UNDERLINE, 5: TextAttributes.BLINK, 7: TextAttributes.INVERSE, 8: TextAttributes.HIDDEN, 9: TextAttributes.STRIKETHROUGH };
const CLEAR: Record<number, number> = { 21: TextAttributes.BOLD, 22: TextAttributes.BOLD | TextAttributes.DIM, 23: TextAttributes.ITALIC, 24: TextAttributes.UNDERLINE, 25: TextAttributes.BLINK, 27: TextAttributes.INVERSE, 28: TextAttributes.HIDDEN, 29: TextAttributes.STRIKETHROUGH };

const byte = (value: number | undefined): number | null => value !== undefined && Number.isInteger(value) && value >= 0 && value <= 255 ? value : null;

function extended(codes: number[], at: number): { color: RGBA | null; used: number } {
  const kind = codes[at + 1];
  if (kind === 5) {
    const index = byte(codes[at + 2]);
    return { color: index === null ? null : RGBA.fromIndex(index), used: 3 };
  }
  if (kind === 2) {
    const r = byte(codes[at + 2]), g = byte(codes[at + 3]), b = byte(codes[at + 4]);
    return { color: r === null || g === null || b === null ? null : RGBA.fromInts(r, g, b), used: 5 };
  }
  return { color: null, used: 1 };
}

export function applySgr(style: Style, params: string): Style {
  const codes = params === "" ? [0] : params.replace(/:+/g, ";").split(";").map(part => part === "" ? 0 : Number(part));
  let next = style;
  for (let at = 0; at < codes.length;) {
    const code = codes[at];
    if (code === undefined) break;
    if (code === 38 || code === 48) {
      const { color, used } = extended(codes, at);
      if (color !== null) next = code === 38 ? { ...next, fg: color } : { ...next, bg: color };
      at += used;
      continue;
    }
    const set = SET[code], clear = CLEAR[code];
    if (code === 0) next = { ...PLAIN, link: next.link };
    else if (set !== undefined) next = { ...next, attributes: next.attributes | set };
    else if (clear !== undefined) next = { ...next, attributes: next.attributes & ~clear };
    else if (code >= 30 && code <= 37) next = { ...next, fg: RGBA.fromIndex(code - 30) };
    else if (code >= 90 && code <= 97) next = { ...next, fg: RGBA.fromIndex(code - 82) };
    else if (code === 39) next = { ...next, fg: null };
    else if (code >= 40 && code <= 47) next = { ...next, bg: RGBA.fromIndex(code - 40) };
    else if (code >= 100 && code <= 107) next = { ...next, bg: RGBA.fromIndex(code - 92) };
    else if (code === 49) next = { ...next, bg: null };
    at += 1;
  }
  return next;
}

function chunk(text: string, style: Style): TextChunk {
  return {
    __isChunk: true, text,
    ...(style.fg === null ? {} : { fg: style.fg }),
    ...(style.bg === null ? {} : { bg: style.bg }),
    ...(style.attributes === TextAttributes.NONE ? {} : { attributes: style.attributes }),
    ...(style.link === null ? {} : { link: { url: style.link } }),
  };
}

export function rowChunks(row: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  let style = PLAIN, from = 0;
  const emit = (text: string) => { if (text.length > 0) chunks.push(chunk(text, style)); };
  for (const match of row.matchAll(ESCAPE)) {
    emit(row.slice(from, match.index));
    from = match.index + match[0].length;
    const sgr = match[1], link = match[2];
    if (sgr !== undefined) style = applySgr(style, sgr);
    else if (link !== undefined) style = { ...style, link: link === "" ? null : link };
  }
  emit(row.slice(from));
  return chunks;
}

export function styledRows(rows: readonly string[]): StyledText {
  const chunks: TextChunk[] = [];
  rows.forEach((row, index) => {
    if (index > 0) chunks.push(chunk("\n", PLAIN));
    chunks.push(...rowChunks(row));
  });
  return new StyledText(chunks);
}
