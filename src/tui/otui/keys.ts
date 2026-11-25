import type { KeyEvent, MouseEvent } from "@opentui/core";
import { cleanPaste, type Key } from "../components";

const NAMED: Record<string, string> = {
  return: "enter", enter: "enter", backspace: "backspace", tab: "tab", escape: "escape",
  up: "up", down: "down", left: "left", right: "right", home: "home", end: "end",
  pageup: "pageup", pagedown: "pagedown", delete: "delete", insert: "insert",
};

const mods = (event: KeyEvent): { ctrl?: true; alt?: true; shift?: true; cmd?: true } => ({
  ...(event.ctrl ? { ctrl: true } : {}),
  ...(event.super === true ? { cmd: true } : {}),
  ...(event.meta || event.option ? { alt: true } : {}),
  ...(event.shift ? { shift: true } : {}),
});

const printable = (text: string): boolean => text.length > 0 && !/[\x00-\x1f\x7f]/.test(text);

export function keyFrom(event: KeyEvent): Key | null {
  if (event.eventType === "release") return null;
  if (event.name === "linefeed") return { name: "j", ctrl: true };
  const named = NAMED[event.name];
  if (named !== undefined) return { name: named, ...mods(event) };
  const text = event.name === "space" ? " " : event.sequence;
  const single = event.name === "space" ? " " : event.name;
  if (event.ctrl || event.meta || event.option || event.super === true) return [...single].length === 1 ? { name: single.toLowerCase(), ...mods(event) } : null;
  return printable(text) ? { name: "char", text } : null;
}

export function mouseFrom(event: MouseEvent): Key | null {
  const x = event.x + 1, y = event.y + 1;
  if (event.type === "scroll") {
    const direction = event.scroll?.direction;
    return direction === "up" ? { name: "wheelup" } : direction === "down" ? { name: "wheeldown" } : null;
  }
  if (event.button !== 0) return null;
  if (event.type === "down") return { name: "mousedown", x, y };
  if (event.type === "up" || event.type === "drag-end") return { name: "mouseup", x, y };
  if (event.type === "drag") return { name: "mousemove", x, y };
  return null;
}

const decoder = new TextDecoder();

export function pasteFrom(bytes: Uint8Array): Key | null {
  const text = cleanPaste(decoder.decode(bytes));
  return text.length > 0 ? { name: "paste", text } : null;
}
