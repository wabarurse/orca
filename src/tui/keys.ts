// Turn raw terminal input into key events. Understands the legacy encodings
// (control bytes, ESC-prefixed Alt, CSI arrows) and, for terminals that use
// them, xterm's modifyOtherKeys (CSI 27;mod;code~) and the kitty keyboard
// protocol (CSI code;mod u).

export interface Key {
  /** "char" (see text), "enter", "backspace", "tab", "escape", "up", "down",
   *  "left", "right", "home", "end", "pageup", "pagedown", "delete", or a
   *  "paste" (bracketed paste, see text), or a single character for modifier
   *  chords such as Ctrl+N ({ name: "n", ctrl }). */
  name: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  /** Printable text for name "char" (consecutive characters are batched) and "paste". */
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
/** An unfinished paste is parsed anyway past this size. */
const MAX_PENDING = 1 << 20;
/** A read that stops inside an escape sequence: CSI parameters with no final byte yet (covers a split PASTE_START). */
const PARTIAL_CSI = /\x1b?\x1b\[[0-9;:?<>]*$/;

/** Pasted text with line endings as \n and other control characters dropped (tabs become spaces). */
function cleanPaste(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
}

/** Where to cut a chunk so the tail can wait for the next read: an unfinished paste (unless Ctrl+C is in it) or escape sequence. */
function holdFrom(input: string): number {
  const at = input.lastIndexOf(PASTE_START);
  if (at !== -1 && input.indexOf(PASTE_END, at) === -1) return input.indexOf("\x03", at) === -1 ? at : -1;
  return input.search(PARTIAL_CSI);
}

/** Split input at an unfinished bracketed paste or escape sequence: parse `keys` now, keep `rest` for the next read. */
export function takeKeys(input: string): { keys: Key[]; rest: string } {
  const at = holdFrom(input);
  if (at === -1 || input.length - at > MAX_PENDING) return { keys: parseKeys(input), rest: "" };
  return { keys: parseKeys(input.slice(0, at)), rest: input.slice(at) };
}

/** Feed raw reads in, get keys out. A held tail is flushed as-is (a paste stays a paste) after `idleMs` without input. */
export function keyReader(emit: (k: Key) => void, idleMs = 300): (chunk: string) => void {
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => { const p = pending; pending = ""; for (const k of parseKeys(p)) emit(k); };
  return (chunk) => {
    clearTimeout(timer);
    const { keys, rest } = takeKeys(pending + chunk);
    pending = rest;
    for (const k of keys) emit(k);
    if (pending) timer = setTimeout(flush, idleMs);
  };
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

/** Everything starting with ESC. */
function escapeAt(input: string, i: number): Step {
  if (input.startsWith(PASTE_START, i)) return pasteAt(input, i);
  const next = input[i + 1];
  if (next === "\x1b" && input[i + 2] === "[") {
    const alt = altCsiAt(input, i);
    if (alt) return alt;
  }
  if (next === "[") return csiAt(input, i);
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
