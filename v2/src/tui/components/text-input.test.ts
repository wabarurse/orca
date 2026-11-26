import { expect, test } from "bun:test";
import type { Key } from "./keys";
import { selectionMarks } from "./style";
import { TextInput } from "./text-input";

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
