import { describe, expect, test } from "bun:test";
import { KeyEvent, parseKeypress } from "@opentui/core";
import type { Entry } from "../core/types";
import * as editor from "./components/editor";
import type { Key } from "./components/keys";
import { selectionMarks } from "./components/style";
import { TextInput } from "./components/text-input";
import { browsing, newer, older, onRecalled, sinceClear } from "./history";
import { keyFrom } from "./otui/keys";

describe("the input box", () => {
  const typing = async (input: TextInput, text: string): Promise<void> => { for (const ch of text) await input.key({ name: "char", text: ch }); };
  const press = async (input: TextInput, ...keys: Key[]): Promise<void> => { for (const key of keys) await input.key(key); };

  test("undo steps are word-sized while typing, Cmd+Shift+Z and Ctrl+Y redo, a new edit clears redo", async () => {
    const input = new TextInput();
    await typing(input, "hello big world");
    await press(input, { name: "z", cmd: true });
    expect(input.value).toBe("hello big ");
    await press(input, { name: "z", ctrl: true });
    expect(input.value).toBe("hello ");
    await press(input, { name: "z", cmd: true, shift: true });
    expect(input.value).toBe("hello big ");
    await press(input, { name: "z", cmd: true }, { name: "y", ctrl: true });
    expect(input.value).toBe("hello big ");
    await typing(input, "x");
    await press(input, { name: "y", ctrl: true });
    expect(input.value).toBe("hello big x");
  });

  test("a cursor move or a different kind of edit starts a new undo step", async () => {
    const input = new TextInput();
    await typing(input, "abc");
    await press(input, { name: "left" });
    await typing(input, "X");
    await press(input, { name: "backspace" }, { name: "backspace" });
    expect(input.value).toBe("ac");
    await press(input, { name: "z", cmd: true });
    expect(input.value).toBe("abXc");
    await press(input, { name: "z", cmd: true });
    expect(input.value).toBe("abc");
    await press(input, { name: "z", cmd: true });
    expect(input.value).toBe("");
  });

  test("an unfocused input takes no keys and renders no cursor or selection; focus brings both back", async () => {
    const input = new TextInput({}, "text");
    await press(input, { name: "a", cmd: true });
    expect(input.render(20, 3).rows[0]).toContain(selectionMarks().on);
    input.blur();
    expect(await input.key({ name: "char", text: "x" })).toBe(false);
    const blurred = input.render(20, 3);
    expect(blurred.cursor).toBe(false);
    expect(blurred.rows[0]).toBe("text");
    input.focus();
    expect(input.render(20, 3).cursor).toBe(true);
  });

  test("Cmd+C copies and Cmd+X cuts the selection, Cmd+V pastes cleaned clipboard text over it", async () => {
    const copied: string[] = [];
    const input = new TextInput({ clipboard: { copy: async text => { copied.push(text); return { ok: true, data: null }; }, paste: async () => ({ ok: true, data: "one\r\ntwo\x07" }) } }, "keep cut");
    expect(await input.key({ name: "c", cmd: true })).toBe(false);
    await press(input, { name: "left", alt: true, shift: true }, { name: "c", cmd: true });
    expect(copied).toEqual(["cut"]);
    await press(input, { name: "x", cmd: true });
    expect(input.value).toBe("keep ");
    expect(copied).toEqual(["cut", "cut"]);
    await press(input, { name: "a", cmd: true }, { name: "v", cmd: true });
    expect(input.value).toBe("one\ntwo");
    await press(input, { name: "z", cmd: true });
    expect(input.value).toBe("keep ");
  });

  test("Enter submits, Shift+Enter adds a line; a single-line input never holds a newline", async () => {
    const sent: string[] = [];
    const input = new TextInput({ onSubmit: text => { sent.push(text); } });
    await typing(input, "a");
    await press(input, { name: "enter", shift: true });
    await typing(input, "b");
    await press(input, { name: "enter" });
    expect(sent).toEqual(["a\nb"]);
    const line = new TextInput({ multiline: false });
    await press(line, { name: "paste", text: "x\ny" }, { name: "j", ctrl: true });
    expect(line.value).toBe("x y ");
    expect(await line.key({ name: "enter", shift: true })).toBe(false);
  });

  test("Up/Down move between rows and call onVertical at the first/last row, so the composer can recall history", async () => {
    const calls: [number, boolean][] = [];
    const input = new TextInput({ onVertical: (dir, atEdge) => { calls.push([dir, atEdge]); return atEdge; } }, "one\ntwo");
    input.render(20, 5);
    await press(input, { name: "up" });
    expect(input.state.cursor).toBe(3);
    await press(input, { name: "up" });
    expect(calls).toEqual([[-1, false], [-1, true]]);
    await press(input, { name: "down", shift: true });
    expect(input.selected).toBe("\ntwo");
  });

  test("click places the cursor, drag selects, double-click a word, triple-click the line", () => {
    const input = new TextInput({}, "say hello world\nnext");
    input.blur();
    input.render(40, 5);
    input.mouse("down", 0, 5, 1000);
    expect(input.isFocused).toBe(true);
    expect(input.state.cursor).toBe(5);
    input.mouse("drag", 0, 12, 1010);
    input.mouse("up", 0, 12, 1020);
    expect(input.selected).toBe("llo wor");
    input.mouse("down", 0, 6, 5000);
    input.mouse("up", 0, 6, 5010);
    input.mouse("down", 0, 6, 5100);
    expect(input.selected).toBe("hello");
    input.mouse("up", 0, 6, 5110);
    input.mouse("down", 0, 6, 5200);
    expect(input.selected).toBe("say hello world");
  });

  test("rendering shows a placeholder when empty and scrolls inside a fixed height", async () => {
    const input = new TextInput({ placeholder: "ask" });
    expect(input.render(20, 3).rows[0]).toContain("ask");
    await press(input, { name: "paste", text: "1\n2\n3\n4\n5" });
    const shown = input.render(20, 3);
    expect(shown.rows).toEqual(["3", "4", "5"]);
    expect(shown.row).toBe(2);
  });

  test("Up on the first row or Down on the last moves to the start or end when onVertical leaves the key alone", async () => {
    const input = new TextInput({ onVertical: () => false }, "one\ntwo", true);
    input.render(20, 5);
    await press(input, { name: "down" });
    expect(input.state.cursor).toBe(7);
    await press(input, { name: "up" }, { name: "up" });
    expect(input.state.cursor).toBe(0);
    expect(input.value).toBe("one\ntwo");
  });

  test("the wheel scrolls hidden rows without moving the cursor; the next edit follows the cursor again", async () => {
    const input = new TextInput();
    await press(input, { name: "paste", text: "1\n2\n3\n4\n5" });
    expect(input.render(20, 3)).toMatchObject({ rows: ["3", "4", "5"], above: true, below: false });
    expect(input.scroll(1)).toBe(false);
    expect(input.scroll(-1) && input.scroll(-1)).toBe(true);
    expect(input.scroll(-1)).toBe(false);
    expect(input.render(20, 3)).toMatchObject({ rows: ["1", "2", "3"], above: false, below: true, cursor: false });
    expect(input.state.cursor).toBe(9);
    await typing(input, "6");
    expect(input.render(20, 3)).toMatchObject({ rows: ["3", "4", "56"], cursor: true });
  });
});

describe("the external editor", () => {
  const run = (s: editor.EditState, ...keys: Key[]): editor.EditState => keys.reduce((state, key) => editor.apply(state, key)?.state ?? state, s);
  const shown = (s: editor.EditState): string => {
    const sel = editor.selection(s);
    if (sel === null) return `${s.text.slice(0, s.cursor)}|${s.text.slice(s.cursor)}`;
    return `${s.text.slice(0, sel.from)}[${s.text.slice(sel.from, sel.to)}]${s.text.slice(sel.to)}`;
  };

  test("Option and Ctrl arrows move by word; ESC b / ESC f do the same", () => {
    const s = editor.at("hello big world");
    expect(shown(run(s, { name: "left", alt: true }))).toBe("hello big |world");
    expect(shown(run(s, { name: "left", ctrl: true }, { name: "left", ctrl: true }))).toBe("hello |big world");
    expect(shown(run(s, { name: "b", alt: true }, { name: "b", alt: true }, { name: "f", alt: true }))).toBe("hello big| world");
    expect(shown(run(editor.at("ab cd", 0), { name: "right", ctrl: true }))).toBe("ab| cd");
  });

  test("Cmd arrows go to line start/end, Cmd Up/Down to the start/end of the message; Ctrl+A/Ctrl+E stay line start/end", () => {
    const s = editor.at("one\ntwo three", 8);
    expect(shown(run(s, { name: "left", cmd: true }))).toBe("one\n|two three");
    expect(shown(run(s, { name: "right", cmd: true }))).toBe("one\ntwo three|");
    expect(shown(run(s, { name: "up", cmd: true }))).toBe("|one\ntwo three");
    expect(shown(run(editor.at("one\ntwo", 1), { name: "down", cmd: true }))).toBe("one\ntwo|");
    expect(shown(run(s, { name: "a", ctrl: true }))).toBe("one\n|two three");
    expect(shown(run(editor.at("one\ntwo", 4), { name: "e", ctrl: true }))).toBe("one\ntwo|");
  });

  test("word and line deletion: Option+Backspace, Option+Delete, Cmd+Backspace, Fn+Delete, Ctrl+K/U/W", () => {
    const s = editor.at("say hello world", 9);
    expect(shown(run(s, { name: "backspace", alt: true }))).toBe("say | world");
    expect(shown(run(s, { name: "delete", alt: true }))).toBe("say hello|");
    expect(shown(run(s, { name: "d", alt: true }))).toBe("say hello|");
    expect(shown(run(s, { name: "backspace", cmd: true }))).toBe("| world");
    expect(shown(run(s, { name: "delete" }))).toBe("say hello|world");
    expect(shown(run(s, { name: "k", ctrl: true }))).toBe("say hello|");
    expect(shown(run(s, { name: "u", ctrl: true }))).toBe("| world");
    expect(shown(run(s, { name: "w", ctrl: true }))).toBe("say | world");
  });

  test("Cmd+A selects only the input; typing replaces the selection, Backspace removes it, an arrow collapses it", () => {
    const all = run(editor.at("draft text", 3), { name: "a", cmd: true });
    expect(shown(all)).toBe("[draft text]");
    expect(shown(run(all, { name: "char", text: "x" }))).toBe("x|");
    expect(shown(run(all, { name: "backspace" }))).toBe("|");
    expect(shown(run(all, { name: "delete" }))).toBe("|");
    expect(shown(run(all, { name: "left" }))).toBe("|draft text");
    expect(shown(run(all, { name: "right" }))).toBe("draft text|");
    expect(shown(run(all, { name: "paste", text: "new" }))).toBe("new|");
    expect(editor.selection(run(editor.at(""), { name: "a", cmd: true }))).toBeNull();
  });

  test("Shift extends by character, Shift+Option by word, Shift+Cmd to the line edge; reversing shrinks it", () => {
    const s = editor.at("alpha beta gamma", 6);
    expect(shown(run(s, { name: "right", shift: true }, { name: "right", shift: true }))).toBe("alpha [be]ta gamma");
    expect(shown(run(s, { name: "right", shift: true, alt: true }))).toBe("alpha [beta] gamma");
    expect(shown(run(s, { name: "right", shift: true, cmd: true }))).toBe("alpha [beta gamma]");
    expect(shown(run(s, { name: "left", shift: true, cmd: true }))).toBe("[alpha ]beta gamma");
    expect(shown(run(s, { name: "right", shift: true }, { name: "left", shift: true }))).toBe("alpha |beta gamma");
    expect(shown(run(s, { name: "right", shift: true, alt: true }, { name: "left", alt: true }))).toBe("|alpha beta gamma");
  });

  test("wide and emoji graphemes move, delete and wrap as one cell group", () => {
    const s = editor.at("a👩‍👩‍👧b日本");
    expect(shown(run(s, { name: "left" }, { name: "left" }, { name: "left" }))).toBe("a👩‍👩‍👧|b日本");
    expect(shown(run(editor.at("a👩‍👩‍👧b", 9), { name: "backspace" }))).toBe("a|b");
    expect(editor.layout(editor.at("日本語"), 4).rows.map(r => r.text)).toEqual(["日本", "語"]);
  });

  test("vertical keeps the goal column, Shift+Up/Down extend to the start or end at the edge", () => {
    const s = editor.at("long line\nab\nlong line", 7);
    const down = editor.vertical(s, 40, 1, null);
    expect(down?.cursor).toBe(12);
    const again = down === null ? null : editor.vertical(down, 40, 1, 7);
    expect(again?.cursor).toBe(20);
    expect(editor.vertical(s, 40, -1)).toBeNull();
    expect(shown(editor.extendVertical(s, 40, -1))).toBe("[long li]ne\nab\nlong line");
  });

  test("a click maps to an offset; a double-click word and a triple-click line", () => {
    const s = editor.at("first line\nsecond");
    expect(editor.hit(s, 40, 1, 3)).toBe(14);
    expect(editor.hit(s, 40, 0, 99)).toBe(10);
    expect(editor.hit(s, 40, -1, 0)).toBe(0);
    expect(editor.hit(s, 40, 5, 0)).toBe(s.text.length);
    expect(editor.wordAt("say hello world", 6)).toEqual({ from: 4, to: 9 });
    expect(editor.lineAt("first line\nsecond", 13)).toEqual({ from: 11, to: 17 });
  });

  test("keys that are not editing keys are left to the caller", () => {
    const s = editor.at("x");
    expect(editor.apply(s, { name: "tab" })).toBeNull();
    expect(editor.apply(s, { name: "enter" })).toBeNull();
    expect(editor.apply(s, { name: "up" })).toBeNull();
    expect(editor.apply(s, { name: "n", ctrl: true })).toBeNull();
  });

  test("Ctrl+Shift+A and Option+A select all too, for terminals that keep Cmd+A for themselves", () => {
    const s = editor.at("draft text", 2);
    expect(shown(run(s, { name: "a", ctrl: true, shift: true }))).toBe("[draft text]");
    expect(shown(run(s, { name: "a", alt: true }))).toBe("[draft text]");
  });
});

describe("input history in the composer", () => {
  const at = (text: string) => ({ text, cursor: text.length, anchor: null });

  test("from an empty input Up recalls older entries, Down newer ones, and Down past the newest empties the input", () => {
    let b = browsing(["first", "/model", "third"]);
    const one = older(b, at(""));
    expect(one?.state).toEqual(at("third"));
    b = one?.browse ?? b;
    const two = older(b, at("third"));
    expect(two?.state).toEqual(at("/model"));
    b = two?.browse ?? b;
    const three = older(b, at("/model"));
    expect(three?.state).toEqual(at("first"));
    b = three?.browse ?? b;
    expect(older(b, at("first"))).toBeNull();
    b = newer(b)?.browse ?? b;
    b = newer(b)?.browse ?? b;
    const back = newer(b);
    expect(back?.state).toEqual(at(""));
    expect(back?.browse.at).toBeNull();
    expect(newer(back?.browse ?? b)).toBeNull();
  });

  test("typed text is never replaced: Up recalls nothing over a draft or over an edited recalled entry", () => {
    expect(older(browsing(["a"]), at("half typed"))).toBeNull();
    const step = older(browsing(["a", "b"]), at(""));
    expect(step).not.toBeNull();
    if (step === null) return;
    expect(older(step.browse, at("b edited"))).toBeNull();
  });

  test("with no history or not browsing, the arrows do nothing; a recalled entry is recognised until it is edited", () => {
    expect(older(browsing([]), at(""))).toBeNull();
    expect(newer(browsing(["a"]))).toBeNull();
    const step = older(browsing(["a\nb"]), at(""));
    expect(step).not.toBeNull();
    if (step === null) return;
    expect(onRecalled(step.browse, step.state)).toBe(true);
    expect(onRecalled(step.browse, at("a\nbc"))).toBe(false);
  });

  test("a cleared view shows only the entries after the one that was last at the clear", () => {
    const entry = (uuid: string): Entry => ({ type: "replies", uuid, parent: null, ts: "", messages: [] });
    const all = [entry("a"), entry("b"), entry("c")];
    expect(sinceClear(all, null)).toEqual(all);
    expect(sinceClear(all, "b").map(e => e.uuid)).toEqual(["c"]);
    expect(sinceClear(all, "c")).toEqual([]);
    expect(sinceClear(all, "gone")).toEqual(all);
  });
});

describe("key decoding", () => {
  test("byte 8 is Ctrl+H and Ctrl+L stays Ctrl+L; Backspace (127) is still backspace", () => {
    const key = (raw: string) => { const event = parseKeypress(raw); return event === null ? null : keyFrom(new KeyEvent(event)); };
    expect(key("\x08")).toEqual({ name: "h", ctrl: true });
    expect(key("\x0c")).toEqual({ name: "l", ctrl: true });
    expect(key("\x7f")).toEqual({ name: "backspace" });
  });

  test("Option, Ctrl and Cmd (kitty super) arrows, Option+Backspace and Cmd+A decode with their modifiers", () => {
    const key = (raw: string) => { const event = parseKeypress(raw, { useKittyKeyboard: true }); return event === null ? null : keyFrom(new KeyEvent(event)); };
    expect(key("\x1bb")).toEqual({ name: "b", alt: true });
    expect(key("\x1bf")).toEqual({ name: "f", alt: true });
    expect(key("\x1b[1;3D")).toEqual({ name: "left", alt: true });
    expect(key("\x1b[1;5C")).toEqual({ name: "right", ctrl: true });
    expect(key("\x1b[1;4D")).toEqual({ name: "left", alt: true, shift: true });
    expect(key("\x1b[1;9D")).toEqual({ name: "left", cmd: true });
    expect(key("\x1b[1;10C")).toEqual({ name: "right", shift: true, cmd: true });
    expect(key("\x1b\x7f")).toEqual({ name: "backspace", alt: true });
    expect(key("\x1b[3;3~")).toEqual({ name: "delete", alt: true });
    expect(key("\x1b[127;9u")).toEqual({ name: "backspace", cmd: true });
    expect(key("\x1b[97;9u")).toEqual({ name: "a", cmd: true });
    expect(key("\x1b[122;10u")).toEqual({ name: "z", shift: true, cmd: true });
    expect(key("\x05")).toEqual({ name: "e", ctrl: true });
  });
});
