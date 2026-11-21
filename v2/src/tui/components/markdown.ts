import { cells, LINK_CLOSE, linkOpen, RESET, wordWrap } from "./text";

const SGR = { bold: "\x1b[1m", dim: "\x1b[2m", italic: "\x1b[3m", underline: "\x1b[4m", strike: "\x1b[9m", code: "\x1b[1m" };
const dim = (s: string) => `${SGR.dim}${s}${RESET}`;

type Hit = { out: string; next: number };
type Rule = (s: string, i: number, outer: string, links: boolean) => Hit | null;

const isAlnum = (c: string | undefined) => c !== undefined && c !== "" && /[A-Za-z0-9]/.test(c);
const isSpace = (c: string | undefined) => c === undefined || c === "" || /\s/.test(c);

const span = (open: string, content: string, outer: string, links: boolean) => `${open}${inline(content, outer + open, links)}${RESET}${outer}`;

const runAt = (s: string, i: number) => {
  let k = i;
  while (s[k] === s[i]) k++;
  return k - i;
};

function codeEnd(s: string, i: number): number {
  const r = runAt(s, i);
  const fence = "`".repeat(r);
  let j = s.indexOf(fence, i + r);
  while (j !== -1 && runAt(s, j) !== r) j = s.indexOf(fence, j + runAt(s, j));
  return j === -1 ? -1 : j + r;
}

function skipAt(s: string, j: number): number {
  if (s[j] === "\\") return j + 2;
  if (s[j] !== "`") return j;
  const end = codeEnd(s, j);
  return end === -1 ? j + runAt(s, j) : end;
}

const canOpen = (s: string, j: number, n: number) => !isAlnum(s[j - 1]) && !isSpace(s[j + n]);
const canClose = (s: string, j: number, r: number, from: number) => j > from && !isSpace(s[j - 1]) && !isAlnum(s[j + r]);

function closer(s: string, from: number, c: string, n: number): [number, number] | null {
  let j = from;
  while (j < s.length) {
    const skip = skipAt(s, j);
    if (skip !== j || s[j] !== c) { j = Math.max(skip, j + 1); continue; }
    const step = atRun(s, j, from, n);
    if (Array.isArray(step)) return step;
    j = step;
  }
  return null;
}

function atRun(s: string, j: number, from: number, n: number): [number, number] | number {
  const r = runAt(s, j);
  const closes = canClose(s, j, r, from);
  if (closes && r === n) return [j, j + r];
  const m = Math.min(r, 3);
  const inner = canOpen(s, j, m) ? closer(s, j + m, s[j] ?? "", m) : null;
  if (inner !== null) return inner[1];
  return closes && r > n ? [j, j + n] : j + r;
}

const EMPHASIS: Record<string, Record<number, string>> = {
  "*": { 1: SGR.italic, 2: SGR.bold, 3: SGR.bold + SGR.italic },
  _: { 1: SGR.italic, 2: SGR.bold, 3: SGR.bold + SGR.italic },
  "~": { 2: SGR.strike },
};

const emphasis: Rule = (s, i, outer, links) => {
  const c = s[i] ?? "";
  const r = runAt(s, i);
  const n = Math.min(r, 3);
  const style = EMPHASIS[c]?.[n];
  const literal = { out: s.slice(i, i + r), next: i + r };
  if (style === undefined || !canOpen(s, i, n)) return literal;
  const end = closer(s, i + n, c, n);
  if (end === null) return literal;
  return { out: span(style, s.slice(i + n, end[0]), outer, links), next: end[1] };
};

const codeSpan: Rule = (s, i, outer) => {
  const r = runAt(s, i);
  const end = codeEnd(s, i);
  if (end === -1) return { out: "`".repeat(r), next: i + r };
  let code = s.slice(i + r, end - r);
  if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
  return { out: `${SGR.code}${code}${RESET}${outer}`, next: end };
};

const PUNCTUATION = /[\p{P}\p{S}]/u;
const escape: Rule = (s, i) => {
  const c = s[i + 1];
  return c !== undefined && c !== "" && c < "\x7f" && PUNCTUATION.test(c) ? { out: c, next: i + 2 } : null;
};

const cleanUrl = (u: string) => u.replace(/[\x00-\x20\x7f-\x9f]/g, "");

function linkable(url: string): boolean {
  if (/[\x00-\x20\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(url)) return false;
  try {
    const parsed = new URL(url);
    return ((parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname !== "" && parsed.username === "" && parsed.password === "")
      || (parsed.protocol === "mailto:" && parsed.pathname !== "");
  } catch { return false; }
}

function link(rawText: string, rawUrl: string, outer: string): string {
  const url = cleanUrl(rawUrl);
  const text = rawText.trim() !== "" ? rawText : url;
  const label = inline(text, outer, false);
  const clickable = linkable(rawUrl);
  const shown = clickable ? `${linkOpen(url)}${label}${LINK_CLOSE}` : label;
  const destination = clickable ? `${linkOpen(url)}(${url})${LINK_CLOSE}` : `(${url})`;
  return text === url ? shown : `${shown} ${SGR.dim}${destination}${RESET}${outer}`;
}

const LINK = /^\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*<?((?:[^\s<>()]|\([^\s<>()]*\))+)>?(?:\s+"[^"]*")?\s*\)/;
const markdownLink: Rule = (s, i, outer) => {
  const m = LINK.exec(s.slice(i));
  return m !== null ? { out: link(m[1] ?? "", m[2] ?? "", outer), next: i + m[0].length } : null;
};

const autolink: Rule = (s, i, outer) => {
  const m = /^<((?:https?|mailto):[^\s<>]+)>/.exec(s.slice(i));
  return m !== null ? { out: link(m[1] ?? "", m[1] ?? "", outer), next: i + m[0].length } : null;
};

const RULES: Record<string, Rule> = { "\\": escape, "`": codeSpan, "[": markdownLink, "<": autolink, "*": emphasis, _: emphasis, "~": emphasis };

const bareLink: Rule = (s, i) => {
  if (i > 0 && /[\w@/]/u.test(s[i - 1] ?? "")) return null;
  const match = /^https?:\/\/[^\s<>`"\x00-\x1f\x7f-\x9f]+/i.exec(s.slice(i));
  if (match === null) return null;
  let url = match[0];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  while (url !== "") {
    const last = url.at(-1) ?? "";
    const open = pairs[last];
    if (/[.,;:!?'“”‘’«»]/u.test(last)
      || (open !== undefined && url.split(last).length > url.split(open).length)) url = url.slice(0, -1);
    else break;
  }
  if (!linkable(url)) return null;
  return { out: `${linkOpen(url)}${url}${LINK_CLOSE}`, next: i + url.length };
};

export function inline(s: string, outer = "", links = true): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const rule = !links && (s[i] === "[" || s[i] === "<") ? undefined : RULES[s[i] ?? ""];
    const hit = rule?.(s, i, outer, links) ?? (links && /[hH]/.test(s[i] ?? "") ? bareLink(s, i, outer, links) : null);
    if (hit !== null) { out += hit.out; i = hit.next; }
    else { out += s[i]; i++; }
  }
  return out;
}

const width = (s: string) => Bun.stringWidth(s);

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
export const isBlank = (l: string) => l.trim() === "";
const isTableRow = (l: string) => l.includes("|") && !isBlank(l);
const isDelimiter = (l: string, header: string) => DELIMITER.test(l) && l.includes("|") && splitRow(l).length === splitRow(header).length;

function fenceEnd(lines: string[], i: number): number {
  const mark = FENCE.exec(lines[i] ?? "")?.[2] ?? "";
  for (let j = i + 1; j < lines.length; j++) {
    const close = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[j] ?? "")?.[1];
    if (close !== undefined && close[0] === mark[0] && close.length >= mark.length) return j;
  }
  return -1;
}

function runLength(lines: string[], i: number, test: (l: string) => boolean): number {
  let j = i;
  while (j < lines.length && test(lines[j] ?? "")) j++;
  return j - i;
}

function blockLength(lines: string[], i: number, end: boolean): number {
  const line = lines[i] ?? "";
  const left = lines.length - i;
  const upTo = (n: number) => (n < left || end ? n : 0);
  if (isBlank(line)) return upTo(runLength(lines, i, isBlank));
  if (FENCE.test(line)) { const j = fenceEnd(lines, i); return j !== -1 ? j - i + 1 : upTo(left); }
  if (!isTableRow(line)) return 1;
  if (left === 1) return upTo(left);
  if (!isDelimiter(lines[i + 1] ?? "", line)) return 1;
  return upTo(2 + runLength(lines, i + 2, isTableRow));
}

export function takeBlocks(lines: string[], end: boolean): { blocks: string[]; used: number } {
  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const n = blockLength(lines, i, end);
    if (n === 0) break;
    const trailing = i + n === lines.length && isBlank(lines[i] ?? "");
    if (!trailing) blocks.push(isBlank(lines[i] ?? "") ? "" : lines.slice(i, i + n).join("\n"));
    i += n;
  }
  return { blocks, used: i };
}

export function sourceLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const first = lines.findIndex((l) => !isBlank(l));
  return first === -1 ? [] : lines.slice(first);
}

export type RowTrace = (rows: string[], mode?: "literal" | "block") => void;

function traced(rows: string[], trace?: RowTrace, mode?: "literal" | "block"): string[] {
  trace?.(rows, mode);
  return rows;
}

export function renderMarkdown(text: string, width: number, trace?: RowTrace): string[] {
  return takeBlocks(sourceLines(text), true).blocks.flatMap((b) => renderBlock(b, width, trace));
}

export function renderLabelled(label: string, text: string, width: number, trace?: RowTrace): string[] {
  const blocks = takeBlocks(sourceLines(text), true).blocks;
  const first = blocks[0] ?? "";
  const head = !isParagraph(first)
    ? [...traced([label], trace), ...(first !== "" ? renderBlock(first, width, trace) : [])]
    : traced(wordWrap(`${label} ${inline(clean(first))}`, width), trace);
  return [...head, ...blocks.slice(1).flatMap((b) => renderBlock(b, width, trace))];
}

const isParagraph = (block: string) =>
  block !== "" && !block.includes("\n") && !FENCE.test(block) && LINE_RULES.findIndex(([re]) => re.test(block)) === LINE_RULES.length - 1 && !/^\s/.test(block);

const ANY_ESCAPE = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[ -\/]*[0-~])?/g;

function clean(s: string): string {
  return s.replace(ANY_ESCAPE, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").split("\n").map(expandTabs).join("\n");
}

function expandTabs(line: string): string {
  let out = "";
  for (const ch of line) out += ch === "\t" ? " ".repeat(4 - (width(out) % 4)) : ch;
  return out;
}

export function renderBlock(block: string, cols: number, trace?: RowTrace): string[] {
  const w = Math.max(1, cols);
  const lines = clean(block).split("\n");
  if (block === "") return traced([""], trace);
  if (FENCE.test(lines[0] ?? "")) return codeBlock(lines, w, trace);
  if (lines.length > 1) return traced(table(lines, w), trace, "block");
  return renderLine(lines[0] ?? "", w, trace);
}

type LineRule = [RegExp, (m: RegExpExecArray, w: number, trace?: RowTrace) => string[]];

const HEADING_STYLE = [SGR.bold + SGR.underline, SGR.bold, SGR.bold + SGR.italic];

const LINE_RULES: LineRule[] = [
  [/^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/, (m, w, trace) => {
    const style = HEADING_STYLE[Math.min((m[1] ?? "").length, 3) - 1] ?? "";
    return traced(wordWrap(`${style}${inline(m[2] ?? "", style)}${RESET}`, w), trace);
  }],
  [/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/, (_m, w, trace) => traced([dim("─".repeat(w))], trace, "block")],
  [/^\s*>\s?(.*)$/, (m, w, trace) => renderLine(m[1] ?? "", w - 2, trace).map((l) => `${dim("│")} ${l}`)],
  [/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/, (m, w, trace) => listItem((m[1] ?? "").length, m[2] ?? "", m[3] ?? "", w, trace)],
  [/^(\s*)(.*)$/, (m, w, trace) => hanging(Math.min((m[1] ?? "").length, Math.floor(w / 2)), "", m[2] ?? "", w, trace)],
];

function renderLine(line: string, w: number, trace?: RowTrace): string[] {
  for (const [re, render] of LINE_RULES) {
    const m = re.exec(line);
    if (m !== null) return render(m, Math.max(1, w), trace);
  }
  return traced([line], trace);
}

function hanging(indent: number, marker: string, text: string, w: number, trace?: RowTrace): string[] {
  const lead = " ".repeat(indent) + marker;
  const pad = " ".repeat(width(lead));
  return traced(wordWrap(inline(text), w - width(lead)), trace).map((l, i) => (i > 0 ? pad : lead) + l);
}

function listItem(indent: number, mark: string, text: string, w: number, trace?: RowTrace): string[] {
  const marker = /\d/.test(mark) ? `${mark} ` : "- ";
  return hanging(Math.min(indent, Math.floor(w / 2)), marker, text, w, trace);
}

const GUTTER = dim("│") + " ";

function codeBlock(lines: string[], w: number, trace?: RowTrace): string[] {
  const fence = FENCE.exec(lines[0] ?? "");
  const indent = fence?.[1] ?? "", lang = fence?.[3] ?? "";
  const closed = lines.length > 1 && /^\s*(`{3,}|~{3,})\s*$/.test(lines.at(-1) ?? "");
  const body = lines.slice(1, closed ? -1 : undefined).map((l) => stripIndent(l, indent.length));
  const label = lang !== "" ? traced([GUTTER + dim(lang)], trace, "block") : [];
  return [...label, ...body.flatMap((l) => traced(cut(l, w - 2), trace, "literal").map((r) => GUTTER + r))];
}

const stripIndent = (l: string, n: number) => l.replace(new RegExp(`^ {0,${n}}`), "");

function cut(text: string, w: number): string[] {
  const rows: string[] = [];
  let row = "";
  let used = 0;
  for (const c of cells(text)) {
    if (used > 0 && used + c.width > Math.max(1, w)) { rows.push(row); row = ""; used = 0; }
    row += c.text;
    used += c.width;
  }
  rows.push(row);
  return rows;
}

type Align = "left" | "center" | "right";

export function splitRow(line: string): string[] {
  const cellsOut: string[] = [];
  let cell = "";
  let code = false;
  const s = line.trim().replace(/^\|/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? "";
    if (c === "\\" && s[i + 1] === "|") { cell += "|"; i++; continue; }
    if (c === "`") code = !code;
    if (c === "|" && !code) { cellsOut.push(cell.trim()); cell = ""; continue; }
    cell += c;
  }
  if (cell.trim() !== "" || !line.trim().endsWith("|")) cellsOut.push(cell.trim());
  return cellsOut;
}

const alignOf = (d: string): Align => {
  const t = d.trim();
  if (t.startsWith(":") && t.endsWith(":")) return "center";
  return t.endsWith(":") ? "right" : "left";
};

const cellText = (raw: string, header: boolean) =>
  raw.split(/<br\s*\/?>/i).map((p) => (header ? `${SGR.bold}${inline(p, SGR.bold)}${RESET}` : inline(p)));

const cellWidth = (parts: string[]) => Math.max(0, ...parts.map(width));

const MIN_COLUMN = 6;

export function fitColumns(natural: number[], room: number): number[] | null {
  const sum = (ws: number[]) => ws.reduce((a, b) => a + b, 0);
  if (sum(natural) <= room) return natural;
  const floor = natural.map((n) => Math.min(n, MIN_COLUMN));
  if (sum(floor) > room) return null;
  const at = (cap: number) => natural.map((n, i) => Math.max(floor[i] ?? 0, Math.min(n, cap)));
  let cap = Math.max(...natural);
  while (sum(at(cap)) > room) cap--;
  const widths = at(cap);
  let extra = room - sum(widths);
  for (let i = 0; i < widths.length && extra > 0; i++) {
    const shown = widths[i] ?? 0;
    if (shown < (natural[i] ?? 0)) { widths[i] = shown + 1; extra--; }
  }
  return widths;
}

function pad(s: string, w: number, align: Align): string {
  const free = Math.max(0, w - width(s));
  const left = align === "right" ? free : align === "center" ? Math.floor(free / 2) : 0;
  return " ".repeat(left) + s + " ".repeat(free - left);
}

const border = (ws: number[], [l, m, r]: string) => dim(l + ws.map((w) => "─".repeat(w + 2)).join(m) + r);

function rowLines(row: string[][], ws: number[], aligns: Align[]): string[] {
  const wrapped = row.map((parts, i) => parts.flatMap((p) => wordWrap(p, ws[i] ?? 0)));
  const height = Math.max(1, ...wrapped.map((c) => c.length));
  const bar = dim("│");
  return Array.from({ length: height }, (_, r) =>
    `${bar} ${wrapped.map((c, i) => pad(c[r] ?? "", ws[i] ?? 0, aligns[i] ?? "left")).join(` ${bar} `)} ${bar}`);
}

function table(lines: string[], w: number): string[] {
  const header = splitRow(lines[0] ?? "");
  const n = header.length;
  const aligns = splitRow(lines[1] ?? "").map(alignOf);
  const fill = (r: string[]) => Array.from({ length: n }, (_, i) => r[i] ?? "");
  const body = lines.slice(2).map((l) => fill(splitRow(l)));
  const rows = [header.map((c) => cellText(c, true)), ...body.map((r) => r.map((c) => cellText(c, false)))];
  const natural = Array.from({ length: n }, (_, i) => Math.max(1, ...rows.map((r) => cellWidth(r[i] ?? []))));
  const ws = fitColumns(natural, w - (3 * n + 1));
  if (ws === null) return stacked(header, body, w);
  const drawn = rows.map((r) => rowLines(r, ws, aligns));
  const ruled = drawn.slice(1).some((r) => r.length > 1);
  const between = border(ws, "├┼┤");
  const bodyLines = drawn.slice(1).flatMap((r, i) => (ruled && i > 0 ? [between, ...r] : r));
  return [border(ws, "┌┬┐"), ...(drawn[0] ?? []), between, ...bodyLines, border(ws, "└┴┘")];
}

function stacked(header: string[], body: string[][], w: number): string[] {
  const key = (h: string, i: number) => `${SGR.bold}${inline(h !== "" ? h : `${i + 1}`, SGR.bold)}${RESET}`;
  const indent = w >= 4 ? 2 : 0;
  const entry = (first: string, rest = "") =>
    wordWrap(first + rest, w - indent).map((l, j) => (j > 0 ? " ".repeat(indent) : "") + l);
  if (body.length === 0) return header.flatMap((h, i) => entry(key(h, i)));
  return body.flatMap((row, r) => [
    ...(r > 0 ? [""] : []),
    ...row.flatMap((cell, i) => entry(`${key(header[i] ?? "", i)}${SGR.bold}:${RESET} `, inline(cell.replace(/<br\s*\/?>/gi, " ")))),
  ]);
}
