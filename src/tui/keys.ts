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

function fromCsi(params: string, final: string): Key | null {
  const nums = params.split(";").map((p) => (p === "" ? NaN : Number(p)));
  if (final === "u") {
    const code = nums[0];
    if (!Number.isFinite(code)) return null;
    return fromCode(code!, nums[1] || 1);
  }
  if (final === "~") {
    if (nums[0] === 27 && Number.isFinite(nums[2])) return fromCode(nums[2]!, nums[1] || 1);
    const name = TILDE_KEYS[String(nums[0])];
    return name ? withMods({ name }, nums[1] || 1) : null;
  }
  if (final === "Z") return { name: "tab", shift: true };
  const name = LETTER_KEYS[final];
  return name ? withMods({ name }, nums[1] || 1) : null;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/** An unfinished paste is handed on in pieces of at most this size. */
const MAX_PASTE = 1 << 20;
/** A read that stops inside an escape sequence: CSI parameters with no final byte yet (covers a split PASTE_START), SS3 with no key, or an OSC reply with no BEL or ST yet. */
const PARTIAL_ESC = /(?:\x1b?\x1b\[[0-9;:?<>]*|\x1bO|\x1b\][0-9]*(?:;[^\x07\x1b]*)?\x1b?)$/;

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
  feed(chunk: string): void;
  /** Stop the idle timer and drop anything held. */
  close(): void;
}

/**
 * Turn raw reads into keys. A read may stop inside an escape sequence; that tail
 * waits for the next read, or `idleMs` without input, then is parsed as it is.
 * Between the paste markers everything is paste text, however the reads are cut
 * and however long the gaps: what has arrived is handed on as a paste key after
 * the idle timeout and the rest follows as more paste keys. Ctrl+C still ends a
 * paste, so a terminal that never sends the end marker cannot trap the user.
 */
export function keyReader(emit: (k: Key) => void, idleMs = 300, setTimer: SetTimer = realTimer): KeyReader {
  const r = new Reader(emit, idleMs, setTimer);
  return { feed: (chunk) => r.feed(chunk), close: () => r.close() };
}

class Reader {
  private held = ""; // an unfinished escape sequence, or (in a paste) a partial end marker
  private inPaste = false;
  private paste = "";
  private cancel: (() => void) | null = null;

  constructor(private readonly emit: (k: Key) => void, private readonly idleMs: number, private readonly setTimer: SetTimer) {}

  feed(chunk: string): void {
    this.stopTimer();
    let data: string | null = this.held + chunk;
    this.held = "";
    while (data) data = this.inPaste ? this.pasteStep(data) : this.keysStep(data);
    if (this.held || this.paste) this.cancel = this.setTimer(() => this.idle(), this.idleMs);
  }

  close(): void {
    this.stopTimer();
    this.held = this.paste = "";
    this.inPaste = false;
  }

  private stopTimer(): void {
    this.cancel?.();
    this.cancel = null;
  }

  private keys(text: string): void {
    for (const k of parseKeys(text)) this.emit(k);
  }

  /** Hand on the paste text so far; a trailing \r may be half of \r\n, so `keepCr` keeps it for the next piece. */
  private emitPaste(keepCr: boolean): void {
    const cut = keepCr && this.paste.endsWith("\r") ? this.paste.length - 1 : this.paste.length;
    if (cut > 0) this.emit({ name: "paste", text: cleanPaste(this.paste.slice(0, cut)) });
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

  /** Outside a paste: keys up to a paste start (returns what follows it) or an unfinished escape (held; returns null). */
  private keysStep(data: string): string | null {
    const start = data.indexOf(PASTE_START);
    if (start !== -1) {
      this.keys(data.slice(0, start));
      this.inPaste = true;
      return data.slice(start + PASTE_START.length);
    }
    const cut = data.search(PARTIAL_ESC);
    const at = cut === -1 ? data.length : cut;
    this.keys(data.slice(0, at));
    this.held = data.slice(at);
    return null;
  }

  private idle(): void {
    this.cancel = null;
    if (this.inPaste) return this.emitPaste(true);
    const tail = this.held;
    this.held = "";
    this.keys(tail);
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

/** ESC ESC [ …: Alt+Left / Alt+Right in terminals that send Alt as an ESC prefix; null for anything else (Esc, then the key). */
function altCsiAt(input: string, i: number): Step | null {
  let j = i + 3;
  while (j < input.length && !CSI_FINAL.test(input[j]!)) j++;
  if (j >= input.length) return null;
  const key = fromCsi(input.slice(i + 3, j), input[j]!);
  return key && (key.name === "left" || key.name === "right") ? [{ ...key, alt: true }, j + 1] : null;
}

/** ESC [ params final. Cut off before the final byte, it reads as Esc. */
function csiAt(input: string, i: number): Step {
  let j = i + 2;
  while (j < input.length && !CSI_FINAL.test(input[j]!)) j++;
  if (j >= input.length) return [{ name: "escape" }, input.length];
  return [fromCsi(input.slice(i + 2, j), input[j]!), j + 1];
}

/** ESC ] digits ; body, ended by BEL or ST (or by the input when cut off): an OSC reply from the terminal; null for anything else (Alt+]). */
function oscAt(input: string, i: number): Step | null {
  const m = /^\x1b\](\d+;[^\x07\x1b]*)(?:\x07|\x1b\\)?/.exec(input.slice(i));
  return m ? [{ name: "osc", text: m[1]! }, i + m[0].length] : null;
}

/** Everything starting with ESC. */
function escapeAt(input: string, i: number): Step {
  if (input.startsWith(PASTE_START, i)) return pasteAt(input, i);
  const next = input[i + 1];
  if (next === "\x1b" && input[i + 2] === "[") {
    const alt = altCsiAt(input, i);
    if (alt) return alt;
  }
  if (next === "[") return csiAt(input, i);
  const osc = next === "]" ? oscAt(input, i) : null;
  if (osc) return osc;
  if (next === "O" && input[i + 2] && LETTER_KEYS[input[i + 2]!]) return [{ name: LETTER_KEYS[input[i + 2]!]! }, i + 3];
  if (next === undefined || next === "\x1b") return [{ name: "escape" }, i + 1];
  // ESC-prefixed byte: Alt plus that key. This is how macOS sends Option+Backspace
  // (ESC DEL) and Alt+Enter (ESC CR), so Esc then Backspace / Enter arriving in one
  // read reads as the Alt chord too; separate reads stay Esc and the key.
  const [inner] = parseKeys(next);
  return [inner ? { ...inner, name: inner.name === "char" ? inner.text!.toLowerCase() : inner.name, text: undefined, alt: true } : null, i + 2];
}

const CONTROL: Record<number, string> = { 13: "enter", 10: "enter", 127: "backspace", 8: "backspace", 9: "tab" };

/** A control byte, or a run of printable text batched into one key so pastes stay cheap. */
function plainAt(input: string, i: number): Step {
  const code = input.charCodeAt(i);
  if (CONTROL[code]) return [{ name: CONTROL[code]! }, i + 1];
  if (code < 32) return [{ name: String.fromCharCode(code + 96), ctrl: true }, i + 1];
  let j = i;
  while (j < input.length && input.charCodeAt(j) >= 32 && input[j] !== "\x7f" && input[j] !== "\x1b") j++;
  return [{ name: "char", text: input.slice(i, j) }, j];
}

/** Parse everything in `input`. Unknown sequences are dropped. */
export function parseKeys(input: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < input.length) {
    const [key, next] = input[i] === "\x1b" ? escapeAt(input, i) : plainAt(input, i);
    if (key) keys.push(key);
    i = next;
  }
  return keys;
}
