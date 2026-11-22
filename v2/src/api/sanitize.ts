
const ESCAPES = /\x1b\[[0-?]*[ -\/]*[@-~]?|\x9b[0-?]*[ -\/]*[@-~]?|\x1b\][^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|\x9d[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|\x1b[PX^_][^\x1b\x9c]*(?:\x1b\\|\x9c)?|[\x90\x98\x9e\x9f][^\x1b\x9c]*(?:\x1b\\|\x9c)?|\x1b[ -\/]*[0-~]?/g;
const CONTROLS = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g;

export function textLines(s: string): string {
  return s.replace(ESCAPES, "").replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(CONTROLS, "");
}

export const plain = (s: string): string => textLines(s).replace(/\n/g, " ");
