// Turn raw terminal input into key events. Understands the legacy encodings
// (control bytes, ESC-prefixed Alt, CSI arrows) and, for terminals that use
// them, xterm's modifyOtherKeys (CSI 27;mod;code~) and the kitty keyboard
// protocol (CSI code;mod u). Strings the terminal sends back (OSC replies,
// such as the answer to the background query) come out as "osc" keys, never
// as typed text; the terminal layer takes them.

export interface Key {
  /** "char" (see text), "enter", "backspace", "tab", "escape", "up", "down",
   *  "left", "right", "home", "end", "pageup", "pagedown", "delete", or a
   *  "paste" (bracketed paste, see text), an "osc" reply from the terminal
   *  (text is its body, e.g. "11;rgb:0000/0000/0000"), or a single character for modifier
   *  chords such as Ctrl+N ({ name: "n", ctrl }). */
  name: string;
  /** One-based terminal cell coordinates for left-button selection events. */
  x?: number;
  y?: number;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  /** Printable text for name "char" (consecutive characters are batched) and "paste"; the body for "osc". */
  text?: string;
}

const CSI_FINAL = /[\x40-\x7e]/;
const NAMED_CODES: Record<number, string> = { 9: "tab", 13: "enter", 27: "escape", 127: "backspace", 8: "backspace" };
const TILDE_KEYS: Record<string, string> = { "1": "home", "7": "home", "4": "end", "8": "end", "2": "insert", "3": "delete", "5": "pageup", "6": "pagedown" };
const LETTER_KEYS: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };

function withMods(key: Key, mod: number): Key {
  const bits = Math.max(0, mod - 1);
  if (bits & 1) key.shift = true;
  if (bits & 2) key.alt = true;
  if (bits & 4) key.ctrl = true;
  return key;
}

/** A key from a unicode code point plus a kitty/xterm modifier value. */
function fromCode(code: number, mod: number): Key | null {
  if (NAMED_CODES[code]) return withMods({ name: NAMED_CODES[code]! }, mod);
  if (code < 32 || code >= 0xe000) return null; // functional keys we do not use
  const ch = String.fromCodePoint(code);
  const key: Key = mod > 1 ? { name: ch.toLowerCase() } : { name: "char", text: ch };
  return withMods(key, mod);
}

/** Kitty's CSI code;mod u. */
const fromKitty = (nums: number[]): Key | null => (Number.isFinite(nums[0]) ? fromCode(nums[0]!, nums[1] || 1) : null);

/** CSI n;mod ~: xterm's modifyOtherKeys (27;mod;code) or a named key. */
function fromTilde(nums: number[]): Key | null {
  if (nums[0] === 27 && Number.isFinite(nums[2])) return fromCode(nums[2]!, nums[1] || 1);
  const name = TILDE_KEYS[String(nums[0])];
  return name ? withMods({ name }, nums[1] || 1) : null;
}

/** Only vertical wheel presses, with optional Shift/Alt/Ctrl bits. Not motion,
 * horizontal wheels, releases or extended buttons that happen to contain 64. */
function wheel(button: number): Key | null {
  const base = button & ~28;
  if (!Number.isSafeInteger(button) || button < 0 || button > 255 || (base !== 64 && base !== 65)) return null;
  return { name: base === 64 ? "wheelup" : "wheeldown" };
}

function fromMouse(params: string, final: string): Key | null {
  const m = /^<(\d+);(\d+);(\d+)$/.exec(params);
  if (!["M", "m"].includes(final) || !m || !m.slice(2).every(n => Number.isSafeInteger(Number(n)) && Number(n) > 0)) return null;
  const button = Number(m[1]);
  const scroll = final === "M" ? wheel(button) : null;
  if (scroll) return scroll;
  // Modified/unknown clicks are not left-button selection gestures.
  if (button !== 0 && button !== 32) return null;
  return { name: final === "m" ? "mouseup" : button === 32 ? "mousemove" : "mousedown", x: Number(m[2]), y: Number(m[3]) };
}

function fromCsi(params: string, final: string): Key | null {
  if (params.startsWith("<")) return fromMouse(params, final);
  const nums = params.split(";").map((p) => (p === "" ? NaN : Number(p)));
  if (final === "u") return fromKitty(nums);
  if (final === "~") return fromTilde(nums);
  if (final === "Z") return { name: "tab", shift: true };
  const name = LETTER_KEYS[final];
  return name ? withMods({ name }, nums[1] || 1) : null;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/** An unfinished paste is handed on in pieces of at most this size. */
const MAX_PASTE = 1 << 20;
/** Bound lone-Escape latency without treating read boundaries as key boundaries. */
export const ESC_DELAY_MS = 25;
/** An OSC reply cut off before its BEL or ST. */
const UNTERMINATED_OSC = /^\x1b\]\d+;[^\x07\x1b]*\x1b?$/;
/** What ends a reply being swallowed: BEL, ST, or a Ctrl+C (kept, so it still quits). */
const REPLY_END = /\x07|\x1b\\|\x03/;

/** Pasted text with line endings as \n and other control characters dropped (tabs become spaces). */
function cleanPaste(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
}

/** How much of `s`'s tail could be the start of `marker`. */
function partialSuffix(s: string, marker: string): number {
  for (let n = Math.min(s.length, marker.length - 1); n > 0; n--) if (marker.startsWith(s.slice(-n))) return n;
  return 0;
}

/** Schedule `fn` after `ms`; returns a cancel. */
export type SetTimer = (fn: () => void, ms: number) => () => void;
const realTimer: SetTimer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.(); // a pending flush never keeps the process alive
  return () => clearTimeout(t);
};

export interface KeyReader {
  /** Feed one raw read. */
  feed(chunk: string | Uint8Array): void;
  /** Stop the idle timer and drop anything held. */
  close(): void;
}

/**
 * Turn raw reads into keys. A read may stop inside an escape sequence; that tail
 * waits for the next read, or `idleMs` without input (incomplete mouse reports
 * are dropped). Partial UTF-8 characters wait for completion, like stdin's decoder.
 * Between the paste markers everything is paste text, however the reads are cut
 * and however long the gaps: what has arrived is handed on as a paste key after
 * the idle timeout and the rest follows as more paste keys. Ctrl+C still ends a
 * paste, so a terminal that never sends the end marker cannot trap the user.
 *
 * While `expectReply()` holds (the terminal was asked something), a read that
 * stops right after an ESC or inside an OSC reply is held too, so a reply cut
 * anywhere is still one "osc" key; one still unterminated at the idle timeout
 * is dropped, and what follows is swallowed up to its BEL or ST for one more
 * idle period. Outside that window a lone ESC waits at most ESC_DELAY_MS
 * (plus one turn of the loop for reads that arrived while it was busy, see
 * yieldOnce); ESC ] remains Alt+] at once. Bytes are framed before UTF-8 decoding, because
 * legacy X10 mouse payloads are three raw bytes, not UTF-8 text.
 */
export function keyReader(emit: (k: Key) => void, idleMs = 300, setTimer: SetTimer = realTimer, expectReply: () => boolean = () => false): KeyReader {
  const r = new Reader(emit, idleMs, setTimer, expectReply);
  return { feed: (chunk) => r.feed(chunk), close: () => r.close() };
}

class Reader {
  private held = ""; // an unfinished escape sequence, or (in a paste) a partial end marker
  private inPaste = false;
  private paste = "";
  private cancel: (() => void) | null = null;
  /** Dropping the rest of a reply that was cut off, up to its BEL or ST. */
  private swallowing = false;
  /** The idle timer already yielded once to pending reads (yieldOnce). */
  private deferred = false;

  constructor(private readonly emit: (k: Key) => void, private readonly idleMs: number, private readonly setTimer: SetTimer, private readonly expectReply: () => boolean) {}

  feed(chunk: string | Uint8Array): void {
    this.stopTimer();
    // A byte-preserving string makes ASCII control framing cheap. Decode text
    // only after framing; decoding all stdin as UTF-8 would corrupt X10 bytes.
    let data: string | null = this.held + Buffer.from(chunk).toString("latin1");
    this.held = "";
    while (data) data = this.step(data);
    if (this.held || this.paste || this.swallowing) this.startTimer();
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

  /**
   * A timer that fires late (the loop was busy) runs before reads that
   * arrived meanwhile: a terminal's ESC and the DEL (or mouse report) it
   * sends in a separate write would be split into Escape plus garbage. So
   * the first firing only yields to pending reads; a read cancels it
   * (stopTimer), and only a second firing with nothing new decides.
   */
  private yieldOnce(): boolean {
    if (this.deferred) return false;
    this.deferred = true;
    this.cancel = this.setTimer(() => this.idle(), 0);
    return true;
  }

  private keys(text: string): void {
    for (const k of parse(text, true)) this.emit(k);
  }

  /** Keep a trailing CR or incomplete UTF-8 character for the next paste piece. */
  private emitPaste(keepCr: boolean): void {
    let cut = keepCr ? completeUtf8End(this.paste) : this.paste.length;
    if (keepCr && this.paste[cut - 1] === "\r") cut--;
    if (cut > 0) this.emit({ name: "paste", text: cleanPaste(unwire(this.paste.slice(0, cut))) });
    this.paste = this.paste.slice(cut);
  }

  /** End the paste after `data[0, at)`; returns what follows it. */
  private endPaste(data: string, at: number, skip: number): string {
    this.paste += data.slice(0, at);
    this.emitPaste(false);
    this.inPaste = false;
    return data.slice(at + skip);
  }

  /** Inside a paste: text up to the end marker or a Ctrl+C (left to be parsed); null when all of `data` was paste text. */
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

  /** Frame one token at a time: an OSC or X10 payload must never be scanned
   * as another key/paste marker, even when several reports share a read. */
  private keysStep(data: string): string | null {
    let i = 0;
    while (i < data.length) {
      if (data.startsWith(PASTE_START, i)) {
        this.inPaste = true;
        return data.slice(i + PASTE_START.length);
      }
      const step = keyAt(data, i, true, true, this.expectReply());
      if (!step) { this.held = data.slice(i); return null; }
      const [key, next] = step;
      if (key) this.emit(key);
      i = next;
    }
    return null;
  }

  /** The rest of a cut-off reply: dropped up to its end, then parsing goes on; a trailing ESC may be half of ST. */
  private swallowStep(data: string): string | null {
    const end = REPLY_END.exec(data);
    if (!end) {
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
    // Like a streaming UTF-8 decoder, never time out halfway through a character,
    // including a fragmented Alt+Unicode chord. Ctrl+C can still interrupt it.
    const text = tail.startsWith("\x1b") ? tail.slice(1) : tail;
    if (text && completeUtf8End(text) === 0) return;
    this.held = "";
    // Incomplete mouse reports are not Escape (which can clear a draft).
    if (tail.startsWith("\x1b[<") || tail.startsWith("\x1b[M")) return;
    if (!UNTERMINATED_OSC.test(tail)) return this.keys(tail);
    this.swallowing = true; // the reply was cut off: drop the rest when it comes, for one more idle period
    this.startTimer();
  }
}

type Step = [key: Key | null, next: number];

/** A bracketed paste at `i`. Unterminated, it runs to the end, or up to a Ctrl+C so that still quits. */
function pasteAt(input: string, i: number): Step {
  const end = input.indexOf(PASTE_END, i);
  if (end !== -1) return [{ name: "paste", text: cleanPaste(input.slice(i + PASTE_START.length, end)) }, end + PASTE_END.length];
  const stop = input.indexOf("\x03", i) === -1 ? input.length : input.indexOf("\x03", i);
  return [{ name: "paste", text: cleanPaste(input.slice(i + PASTE_START.length, stop)) }, stop];
}

/** Byte string -> Unicode, only after controls and binary mouse payloads are framed. */
const unwire = (s: string): string => Buffer.from(s, "latin1").toString("utf8");
const textOf = (s: string, bytes: boolean): string => bytes ? unwire(s) : s;
const utf8Size = (n: number): number => n >= 0xc2 && n <= 0xdf ? 2 : n >= 0xe0 && n <= 0xef ? 3 : n >= 0xf0 && n <= 0xf4 ? 4 : 1;
/** Invalid UTF-8 must not hide an ASCII control (notably Ctrl+C). */
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

/** Classic X10: ESC [ M followed by exactly three bytes (button+32,x+32,y+32).
 * We request SGR, but consume this fallback too; never decode its payload as text. */
function x10At(input: string, i: number, streaming: boolean): Step | null {
  const end = Math.min(input.length, i + 6);
  const interrupt = input.indexOf("\x03", i + 3);
  if (interrupt >= 0 && interrupt < end) return [null, interrupt];
  if (end < i + 6) return streaming ? null : [null, end];
  const button = input.charCodeAt(i + 3) - 32;
  const coords = [input.charCodeAt(i + 4), input.charCodeAt(i + 5)];
  return [coords.every(n => n > 32 && n <= 255) ? wheel(button) : null, end];
}

/** CSI parameters/intermediates then a final. A control byte interrupts a bad
 * sequence instead of being swallowed (especially Ctrl+C and another ESC). */
function csiAt(input: string, i: number, streaming = false): Step | null {
  if (input.startsWith("\x1b[M", i)) return x10At(input, i, streaming);
  let j = i + 2;
  while (j < input.length && /[\x20-\x3f]/.test(input[j]!)) j++;
  if (j >= input.length) return streaming ? null : [{ name: "escape" }, input.length];
  if (!CSI_FINAL.test(input[j]!)) return [null, j];
  return [fromCsi(input.slice(i + 2, j), input[j]!), j + 1];
}

/** OSC replies are buffered during the query window; outside it Alt+] is still
 * immediate, and a recognizable late OSC is consumed rather than typed. */
function oscAt(input: string, i: number, streaming: boolean, reply: boolean, bytes: boolean): Step | null {
  const tail = input.slice(i);
  const interrupt = tail.indexOf("\x03");
  if (interrupt >= 0 && !/[\x07\x1b]/.test(tail.slice(2, interrupt))) return [null, i + interrupt];
  if (streaming && reply && /^\x1b\][0-9]*(?:;[^\x07\x1b]*)?\x1b?$/.test(tail)) return null;
  const m = /^\x1b\](\d+;[^\x07\x1b]*)(?:\x07|\x1b\\)?/.exec(tail);
  return m ? [{ name: "osc", text: textOf(m[1]!, bytes) }, i + m[0].length] : altAt(input, i, streaming, bytes);
}

/** ESC-prefixed key: an Alt chord if its rest arrives within the Escape window. */
function altAt(input: string, i: number, streaming: boolean, bytes: boolean): Step | null {
  const size = bytes ? byteCharSize(input, i + 1) : String.fromCodePoint(input.codePointAt(i + 1)!).length;
  if (streaming && i + 1 + size > input.length) return null;
  const [inner] = parseKeys(textOf(input.slice(i + 1, i + 1 + size), bytes));
  return [inner ? { ...inner, name: inner.name === "char" ? inner.text!.toLowerCase() : inner.name, text: undefined, alt: true } : null, Math.min(input.length, i + 1 + size)];
}

/** Everything starting with ESC; null means a fragmented token needs more input. */
function escapeAt(input: string, i: number, streaming: boolean, bytes: boolean, reply: boolean): Step | null {
  const next = input[i + 1];
  if (next === undefined) return streaming ? null : [{ name: "escape" }, i + 1];
  if (next === "[") return input.startsWith(PASTE_START, i) ? pasteAt(input, i) : csiAt(input, i, streaming);
  if (next === "]") return oscAt(input, i, streaming, reply, bytes);
  if (next === "O") {
    if (streaming && i + 2 === input.length) return null;
    const name = LETTER_KEYS[input[i + 2] ?? ""];
    if (name) return [{ name }, i + 3];
  }
  if (next === "\x1b") {
    if (streaming && i + 2 === input.length) return null;
    if (input[i + 2] === "[") {
      const step = csiAt(input, i + 1, streaming);
      if (!step) return null;
      const [key, end] = step;
      if (key?.name === "left" || key?.name === "right") return [{ ...key, alt: true }, end];
    }
    return [{ name: "escape" }, i + 1];
  }
  return altAt(input, i, streaming, bytes);
}

const CONTROL: Record<number, string> = { 13: "enter", 10: "enter", 127: "backspace", 8: "backspace", 9: "tab" };

/** A control byte, or a run of printable text batched into one key so pastes stay cheap. */
function plainAt(input: string, i: number, streaming: boolean, bytes: boolean): Step | null {
  const code = input.charCodeAt(i);
  if (CONTROL[code]) return [{ name: CONTROL[code]! }, i + 1];
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
    const [key, next] = keyAt(input, i, false, bytes)!;
    if (key) keys.push(key.name === "paste" && bytes ? { ...key, text: unwire(key.text!) } : key);
    i = next;
  }
  return keys;
}

/** Parse one complete, decoded input string. Use keyReader for fragmented/raw stdin. */
export function parseKeys(input: string): Key[] { return parse(input, false); }
