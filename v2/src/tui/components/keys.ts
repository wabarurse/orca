export type Key = {
  name: string;
  x?: number;
  y?: number;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  cmd?: boolean;
  text?: string;
};

const CSI_FINAL = /[\x40-\x7e]/;
const NAMED_CODES: Record<number, string> = { 9: "tab", 13: "enter", 27: "escape", 127: "backspace", 8: "backspace" };
const TILDE_KEYS: Record<string, string> = { "1": "home", "7": "home", "4": "end", "8": "end", "2": "insert", "3": "delete", "5": "pageup", "6": "pagedown" };
const LETTER_KEYS: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };

const orOne = (n: number | undefined): number => n === undefined || Number.isNaN(n) || n === 0 ? 1 : n;

function withMods(key: Key, mod: number): Key {
  const bits = Math.max(0, mod - 1);
  if ((bits & 1) !== 0) key.shift = true;
  if ((bits & 2) !== 0) key.alt = true;
  if ((bits & 4) !== 0) key.ctrl = true;
  if ((bits & 8) !== 0) key.cmd = true;
  return key;
}

function fromCode(code: number, mod: number): Key | null {
  const named = NAMED_CODES[code];
  if (named !== undefined) return withMods({ name: named }, mod);
  if (code < 32 || code >= 0xe000) return null;
  const ch = String.fromCodePoint(code);
  const key: Key = mod > 1 ? { name: ch.toLowerCase() } : { name: "char", text: ch };
  return withMods(key, mod);
}

function fromKitty(params: string): Key | null {
  const match = /^(\d+)(?::\d*){0,2}(?:;(\d*)(?::([123]))?(?:;\d+(?::\d+)*)?)?$/.exec(params);
  if (match === null || match[3] === "3") return null;
  return fromCode(Number(match[1]), orOne(Number(match[2])));
}

function fromTilde(nums: number[]): Key | null {
  const code = nums[2];
  if (nums[0] === 27 && code !== undefined && Number.isFinite(code)) return fromCode(code, orOne(nums[1]));
  const name = TILDE_KEYS[String(nums[0])];
  return name !== undefined ? withMods({ name }, orOne(nums[1])) : null;
}

function wheel(button: number): Key | null {
  const base = button & ~28;
  if (!Number.isSafeInteger(button) || button < 0 || button > 255 || (base !== 64 && base !== 65)) return null;
  return { name: base === 64 ? "wheelup" : "wheeldown" };
}

function fromMouse(params: string, final: string): Key | null {
  const m = /^<(\d+);(\d+);(\d+)$/.exec(params);
  if (!["M", "m"].includes(final) || m === null || !m.slice(2).every(n => Number.isSafeInteger(Number(n)) && Number(n) > 0)) return null;
  const button = Number(m[1]);
  const scroll = final === "M" ? wheel(button) : null;
  if (scroll !== null) return scroll;
  if (button !== 0 && button !== 32) return null;
  return { name: final === "m" ? "mouseup" : button === 32 ? "mousemove" : "mousedown", x: Number(m[2]), y: Number(m[3]) };
}

function fromCsi(params: string, final: string): Key | null {
  if (params.startsWith("<")) return fromMouse(params, final);
  if (final === "u") return fromKitty(params);
  const nums = params.split(";").map((p) => (p === "" ? NaN : Number(p)));
  if (final === "~") return fromTilde(nums);
  if (final === "Z") return { name: "tab", shift: true };
  const name = LETTER_KEYS[final];
  return name !== undefined ? withMods({ name }, orOne(nums[1])) : null;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const MAX_PASTE = 1 << 20;
export const ESC_DELAY_MS = 25;
const UNTERMINATED_OSC = /^\x1b\]\d+;[^\x07\x1b]*\x1b?$/;
const REPLY_END = /\x07|\x1b\\|\x03/;

export function cleanPaste(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
}

function partialSuffix(s: string, marker: string): number {
  for (let n = Math.min(s.length, marker.length - 1); n > 0; n--) if (marker.startsWith(s.slice(-n))) return n;
  return 0;
}

export type SetTimer = (fn: () => void, ms: number) => () => void;
const realTimer: SetTimer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

export type KeyReader = {
  feed(chunk: string | Uint8Array): void;
  close(): void;
};

export function keyReader(emit: (k: Key) => void, idleMs = 300, setTimer: SetTimer = realTimer, expectReply: () => boolean = () => false): KeyReader {
  const r = new Reader(emit, idleMs, setTimer, expectReply);
  return { feed: (chunk) => r.feed(chunk), close: () => r.close() };
}

class Reader {
  private held = "";
  private inPaste = false;
  private paste = "";
  private cancel: (() => void) | null = null;
  private swallowing = false;
  private deferred = false;

  constructor(private readonly emit: (k: Key) => void, private readonly idleMs: number, private readonly setTimer: SetTimer, private readonly expectReply: () => boolean) {}

  feed(chunk: string | Uint8Array): void {
    this.stopTimer();
    let data: string | null = this.held + Buffer.from(chunk).toString("latin1");
    this.held = "";
    while (data !== null && data !== "") data = this.step(data);
    if (this.held !== "" || this.paste !== "" || this.swallowing) this.startTimer();
  }

  private step(data: string): string | null {
    if (this.swallowing) return this.swallowStep(data);
    return this.inPaste ? this.pasteStep(data) : this.keysStep(data);
  }

  close(): void {
    this.stopTimer();
    this.held = this.paste = "";
    this.inPaste = this.swallowing = false;
  }

  private startTimer(): void {
    const ms = /^\x1b{1,2}$/.test(this.held) && !this.expectReply() && !this.inPaste && !this.swallowing ? Math.min(ESC_DELAY_MS, this.idleMs) : this.idleMs;
    this.deferred = false;
    this.cancel = this.setTimer(() => this.idle(), ms);
  }

  private stopTimer(): void {
    this.cancel?.();
    this.cancel = null;
    this.deferred = false;
  }

  private yieldOnce(): boolean {
    if (this.deferred) return false;
    this.deferred = true;
    this.cancel = this.setTimer(() => this.idle(), 0);
    return true;
  }

  private keys(text: string): void {
    for (const k of parse(text, true)) this.emit(k);
  }

  private emitPaste(keepCr: boolean): void {
    let cut = keepCr ? completeUtf8End(this.paste) : this.paste.length;
    if (keepCr && this.paste[cut - 1] === "\r") cut--;
    if (cut > 0) this.emit({ name: "paste", text: cleanPaste(unwire(this.paste.slice(0, cut))) });
    this.paste = this.paste.slice(cut);
  }

  private endPaste(data: string, at: number, skip: number): string {
    this.paste += data.slice(0, at);
    this.emitPaste(false);
    this.inPaste = false;
    return data.slice(at + skip);
  }

  private pasteStep(data: string): string | null {
    const end = data.indexOf(PASTE_END);
    const ctrlC = data.indexOf("\x03");
    if (ctrlC !== -1 && (end === -1 || ctrlC < end)) return this.endPaste(data, ctrlC, 0);
    if (end !== -1) return this.endPaste(data, end, PASTE_END.length);
    const keep = partialSuffix(data, PASTE_END);
    this.paste += data.slice(0, data.length - keep);
    this.held = data.slice(data.length - keep);
    if (this.paste.length > MAX_PASTE) this.emitPaste(true);
    return null;
  }

  private keysStep(data: string): string | null {
    let i = 0;
    while (i < data.length) {
      if (data.startsWith(PASTE_START, i)) {
        this.inPaste = true;
        return data.slice(i + PASTE_START.length);
      }
      const step = keyAt(data, i, true, true, this.expectReply());
      if (step === null) { this.held = data.slice(i); return null; }
      const [key, next] = step;
      if (key !== null) this.emit(key);
      i = next;
    }
    return null;
  }

  private swallowStep(data: string): string | null {
    const end = REPLY_END.exec(data);
    if (end === null) {
      this.held = data.endsWith("\x1b") ? "\x1b" : "";
      return null;
    }
    this.swallowing = false;
    return data.slice(end.index + (end[0] === "\x03" ? 0 : end[0].length));
  }

  private idle(): void {
    this.cancel = null;
    if (this.yieldOnce()) return;
    if (this.swallowing) { this.swallowing = false; this.held = ""; return; }
    if (this.inPaste) return this.emitPaste(true);
    const tail = this.held;
    const text = tail.startsWith("\x1b") ? tail.slice(1) : tail;
    if (text !== "" && completeUtf8End(text) === 0) return;
    this.held = "";
    if (tail.startsWith("\x1b[<") || tail.startsWith("\x1b[M")) return;
    if (!UNTERMINATED_OSC.test(tail)) return this.keys(tail);
    this.swallowing = true;
    this.startTimer();
  }
}

type Step = [key: Key | null, next: number];

function pasteAt(input: string, i: number): Step {
  const end = input.indexOf(PASTE_END, i);
  if (end !== -1) return [{ name: "paste", text: cleanPaste(input.slice(i + PASTE_START.length, end)) }, end + PASTE_END.length];
  const stop = input.indexOf("\x03", i) === -1 ? input.length : input.indexOf("\x03", i);
  return [{ name: "paste", text: cleanPaste(input.slice(i + PASTE_START.length, stop)) }, stop];
}

const unwire = (s: string): string => Buffer.from(s, "latin1").toString("utf8");
const textOf = (s: string, bytes: boolean): string => bytes ? unwire(s) : s;
const utf8Size = (n: number): number => n >= 0xc2 && n <= 0xdf ? 2 : n >= 0xe0 && n <= 0xef ? 3 : n >= 0xf0 && n <= 0xf4 ? 4 : 1;
function byteCharSize(s: string, i: number): number {
  const size = utf8Size(s.charCodeAt(i));
  for (let j = i + 1; j < Math.min(s.length, i + size); j++) if ((s.charCodeAt(j) & 0xc0) !== 0x80) return 1;
  return size;
}
function completeUtf8End(s: string): number {
  let i = Math.max(0, s.length - 4);
  while (i < s.length) {
    const size = byteCharSize(s, i);
    if (i + size > s.length) return i;
    i += size;
  }
  return s.length;
}

function x10At(input: string, i: number, streaming: boolean): Step | null {
  const end = Math.min(input.length, i + 6);
  const interrupt = input.indexOf("\x03", i + 3);
  if (interrupt >= 0 && interrupt < end) return [null, interrupt];
  if (end < i + 6) return streaming ? null : [null, end];
  const button = input.charCodeAt(i + 3) - 32;
  const coords = [input.charCodeAt(i + 4), input.charCodeAt(i + 5)];
  return [coords.every(n => n > 32 && n <= 255) ? wheel(button) : null, end];
}

function csiAt(input: string, i: number, streaming = false): Step | null {
  if (input.startsWith("\x1b[M", i)) return x10At(input, i, streaming);
  let j = i + 2;
  while (j < input.length && /[\x20-\x3f]/.test(input[j] ?? "")) j++;
  if (j >= input.length) return streaming ? null : [{ name: "escape" }, input.length];
  const final = input[j] ?? "";
  if (!CSI_FINAL.test(final)) return [null, j];
  return [fromCsi(input.slice(i + 2, j), final), j + 1];
}

function oscAt(input: string, i: number, streaming: boolean, reply: boolean, bytes: boolean): Step | null {
  const tail = input.slice(i);
  const interrupt = tail.indexOf("\x03");
  if (interrupt >= 0 && !/[\x07\x1b]/.test(tail.slice(2, interrupt))) return [null, i + interrupt];
  if (streaming && reply && /^\x1b\][0-9]*(?:;[^\x07\x1b]*)?\x1b?$/.test(tail)) return null;
  const m = /^\x1b\](\d+;[^\x07\x1b]*)(?:\x07|\x1b\\)?/.exec(tail);
  return m !== null ? [{ name: "osc", text: textOf(m[1] ?? "", bytes) }, i + m[0].length] : altAt(input, i, streaming, bytes);
}

function altAt(input: string, i: number, streaming: boolean, bytes: boolean): Step | null {
  const size = bytes ? byteCharSize(input, i + 1) : String.fromCodePoint(input.codePointAt(i + 1) ?? 0).length;
  if (streaming && i + 1 + size > input.length) return null;
  const [inner] = parseKeys(textOf(input.slice(i + 1, i + 1 + size), bytes));
  return [inner !== undefined ? { ...inner, name: inner.name === "char" ? (inner.text ?? "").toLowerCase() : inner.name, text: undefined, alt: true } : null, Math.min(input.length, i + 1 + size)];
}

function escapeAt(input: string, i: number, streaming: boolean, bytes: boolean, reply: boolean): Step | null {
  const next = input[i + 1];
  if (next === undefined) return streaming ? null : [{ name: "escape" }, i + 1];
  if (next === "[") return input.startsWith(PASTE_START, i) ? pasteAt(input, i) : csiAt(input, i, streaming);
  if (next === "]") return oscAt(input, i, streaming, reply, bytes);
  if (next === "O") {
    if (streaming && i + 2 === input.length) return null;
    const name = LETTER_KEYS[input[i + 2] ?? ""];
    if (name !== undefined) return [{ name }, i + 3];
  }
  if (next === "\x1b") {
    if (streaming && i + 2 === input.length) return null;
    if (input[i + 2] === "[") {
      const step = csiAt(input, i + 1, streaming);
      if (step === null) return null;
      const [key, end] = step;
      if (key?.name === "left" || key?.name === "right") return [{ ...key, alt: true }, end];
    }
    return [{ name: "escape" }, i + 1];
  }
  return altAt(input, i, streaming, bytes);
}

const CONTROL: Record<number, string> = { 13: "enter", 10: "enter", 127: "backspace", 9: "tab" };

function plainAt(input: string, i: number, streaming: boolean, bytes: boolean): Step | null {
  const code = input.charCodeAt(i);
  const control = CONTROL[code];
  if (control !== undefined) return [{ name: control }, i + 1];
  if (code < 32) return [{ name: String.fromCharCode(code + 96), ctrl: true }, i + 1];
  let j = i;
  while (j < input.length && input.charCodeAt(j) >= 32 && input[j] !== "\x7f" && input[j] !== "\x1b") {
    const size = bytes ? byteCharSize(input, j) : 1;
    if (streaming && j + size > input.length) break;
    j += Math.min(size, input.length - j);
  }
  return j === i ? null : [{ name: "char", text: textOf(input.slice(i, j), bytes) }, j];
}

function keyAt(input: string, i: number, streaming: boolean, bytes: boolean, reply = false): Step | null {
  return input[i] === "\x1b" ? escapeAt(input, i, streaming, bytes, reply) : plainAt(input, i, streaming, bytes);
}

function parse(input: string, bytes: boolean): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < input.length) {
    const step = keyAt(input, i, false, bytes);
    if (step === null) break;
    const [key, next] = step;
    if (key !== null) keys.push(key.name === "paste" && bytes ? { ...key, text: unwire(key.text ?? "") } : key);
    i = next;
  }
  return keys;
}

export function parseKeys(input: string): Key[] { return parse(input, false); }
