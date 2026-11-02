import { expect, test } from "bun:test";
import type { Task } from "../../protocol/task";
import { taskNumberKey } from "./task-jump";
import { renderTaskTree, selectTaskNumber } from "../components/task-tree";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const task = (n: number, parents: number[] = []): Task => ({ id: id(n), number: n, name: `Task ${n}`, summary: "", branch: "feat/jump", status: "queued", createdAt: "today", updatedAt: "today", revision: 1, dependsOn: parents.map(id), runs: [], history: [] });
const view = () => ({ tasks: [task(1), task(13, [1]), task(15, [13]), task(20)], collapsed: new Set([id(1), id(13), id(20)]), selectedId: id(1), detailY: 5,
  detailsFocused: true, jumpInput: undefined as string | undefined, notice: undefined as string | undefined, revealSelected: false });
test("multi-digit jump selects by durable number, reveals ancestors and preserves unrelated folds", () => {
  const v = view(); taskNumberKey(v, { name: "char", text: "1" });
  expect(v.selectedId).toBe(id(1)); taskNumberKey(v, { name: "char", text: "5" });
  expect(v.jumpInput).toBe("15"); expect(v.notice).toContain("#15");
  taskNumberKey(v, { name: "enter" });
  expect(v.selectedId).toBe(id(15)); expect(v.collapsed).toEqual(new Set([id(20)]));
  expect(v.detailsFocused).toBe(false); expect(v.detailY).toBe(0); expect(v.revealSelected).toBe(true);
  const rendered = renderTaskTree(v.tasks, { ...v, cols: 80, rows: 12 });
  expect(rendered.selectedId).toBe(id(15)); expect(rendered.hits.some(h => h.number === 15)).toBe(true);
});
test("jump numbers are not array positions; missing and removed numbers never change selection", () => {
  const v = view();
  expect(selectTaskNumber(v.tasks, 2, v.collapsed)).toBeUndefined();
  v.tasks[1]!.removedAt = "today";
  taskNumberKey(v, { name: "char", text: "13" }); taskNumberKey(v, { name: "enter" });
  expect(v.selectedId).toBe(id(1)); expect(v.notice).toContain("No listed task #13");
});
test("backspace edits, Esc cancels only the jump, and modifiers never start a jump", () => {
  const v = view(); expect(taskNumberKey(v, { name: "char", text: "1", ctrl: true })).toBe(false);
  taskNumberKey(v, { name: "char", text: "15" }); taskNumberKey(v, { name: "backspace" });
  expect(v.jumpInput).toBe("1"); expect(taskNumberKey(v, { name: "escape" })).toBe(true);
  expect(v.jumpInput).toBeUndefined(); expect(v.selectedId).toBe(id(1));
  expect(taskNumberKey(v, { name: "escape" })).toBe(false);
});
test("invalid and excessive numbers are harmless, and navigation resets an incomplete jump", () => {
  const v = view(); taskNumberKey(v, { name: "char", text: "999999999999999999999" });
  expect(v.jumpInput!.length).toBe(16); taskNumberKey(v, { name: "enter" }); expect(v.selectedId).toBe(id(1));
  taskNumberKey(v, { name: "char", text: "1" }); expect(taskNumberKey(v, { name: "down" })).toBe(false);
  expect(v.jumpInput).toBeUndefined();
});
test("legacy rows without numbers match the renderer's numbering", () => {
  const v = view(); v.tasks.forEach(t => { delete t.number; });
  const selected = selectTaskNumber(v.tasks, 3, v.collapsed);
  const rendered = renderTaskTree(v.tasks, { cols: 80, rows: 24, selectedId: selected, collapsed: v.collapsed });
  expect(rendered.hits.find(hit => hit.id === selected)?.number).toBe(3);
});
