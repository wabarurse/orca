// Turn raw terminal input into key events. Understands the legacy encodings
// (control bytes, ESC-prefixed Alt, CSI arrows), xterm's modifyOtherKeys
// (CSI 27;mod;code~) and the kitty keyboard protocol (CSI code;mod u), which
// term.ts switches on so chords like Ctrl+, and Ctrl+. are distinguishable.

export interface Key {
  /** "char" (see text), "enter", "backspace", "tab", "escape", "up", "down",
   *  "left", "right", "home", "end", "pageup", "pagedown", "delete", or a
   *  single character for modifier chords such as Ctrl+N ({ name: "n", ctrl }). */
  name: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  /** Printable text for name "char"; consecutive characters are batched. */
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

/** Parse everything in `input`. Unknown sequences are dropped. */
export function parseKeys(input: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  const push = (k: Key | null) => { if (k) keys.push(k); };
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === "\x1b") {
      const next = input[i + 1];
      if (next === "[") {
        let j = i + 2;
        while (j < input.length && !CSI_FINAL.test(input[j]!)) j++;
        if (j >= input.length) { push({ name: "escape" }); i = input.length; break; }
        push(fromCsi(input.slice(i + 2, j), input[j]!));
        i = j + 1;
        continue;
      }
      if (next === "O" && input[i + 2] && LETTER_KEYS[input[i + 2]!]) {
        push({ name: LETTER_KEYS[input[i + 2]!]! });
        i += 3;
        continue;
      }
      if (next !== undefined && next !== "\x1b") {
        // ESC-prefixed byte: Alt plus that key.
        const [inner] = parseKeys(next);
        if (inner) push({ ...inner, name: inner.name === "char" ? inner.text!.toLowerCase() : inner.name, text: undefined, alt: true });
        i += 2;
        continue;
      }
      push({ name: "escape" });
      i += 1;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code === 13 || code === 10) { push({ name: "enter" }); i++; continue; }
    if (code === 127 || code === 8) { push({ name: "backspace" }); i++; continue; }
    if (code === 9) { push({ name: "tab" }); i++; continue; }
    if (code < 32) { push({ name: String.fromCharCode(code + 96), ctrl: true }); i++; continue; }
    // Printable run, batched into one key so pastes stay cheap.
    let j = i;
    while (j < input.length && input.charCodeAt(j) >= 32 && input[j] !== "\x7f" && input[j] !== "\x1b") j++;
    push({ name: "char", text: input.slice(i, j) });
    i = j;
  }
  return keys;
}
