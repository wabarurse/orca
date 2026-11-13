// Escape and control stripping at the source: everything a tool result or a
// native search result contributes is plain text before anyone shows it.

/**
 * Every escape sequence: CSI (7- and 8-bit), OSC (7- and 8-bit, to BEL or ST,
 * or to the end when cut off), DCS/SOS/PM/APC strings, any other ESC sequence,
 * and a bare ESC.
 */
const ESCAPES = /\x1b\[[0-?]*[ -\/]*[@-~]?|\x9b[0-?]*[ -\/]*[@-~]?|\x1b\][^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|\x9d[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|\x1b[PX^_][^\x1b\x9c]*(?:\x1b\\|\x9c)?|[\x90\x98\x9e\x9f][^\x1b\x9c]*(?:\x1b\\|\x9c)?|\x1b[ -\/]*[0-~]?/g;
/** Every C0 and C1 control but the newline (tabs and CRs are handled first). */
const CONTROLS = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g;

/** Text with no escape sequences and no controls but newlines: CRLF and lone CR as \n, tabs as a space. */
export function textLines(s: string): string {
  return s.replace(ESCAPES, "").replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(CONTROLS, "");
}

/** A printable single line: no escapes and no C0/C1 controls, including newlines. */
export const plain = (s: string): string => textLines(s).replace(/\n/g, " ");
