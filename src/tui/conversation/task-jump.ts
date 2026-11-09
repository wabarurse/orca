import type { Task } from "../../protocol/task";
import { selectTaskNumber, type Key } from "../components";
interface JumpView {
  tasks: Task[]; collapsed: Set<string>; jumpInput?: string; notice?: string;
  selectedId?: string; revealSelected?: boolean; detailY: number; detailsFocused?: boolean;
  history?: boolean;
}
/** Digits + Enter, with no timer, command execution or interaction with chat drafts. */
export function taskNumberKey(view: JumpView, key: Key): boolean {
  if (key.ctrl || key.alt) return false;
  if (key.name === "char" && /^\d+$/.test(key.text ?? "")) {
    view.jumpInput = ((view.jumpInput ?? "") + key.text).slice(0, 16);
    view.notice = `Jump to #${view.jumpInput} · Enter jump · Backspace edit · Esc cancel`; return true;
  }
  if (!view.jumpInput) return false;
  if (key.name === "escape") { view.jumpInput = undefined; view.notice = undefined; return true; }
  if (key.name === "backspace") {
    view.jumpInput = view.jumpInput.slice(0, -1);
    view.notice = view.jumpInput ? `Jump to #${view.jumpInput} · Enter jump · Esc cancel` : undefined; return true;
  }
  if (key.name === "enter") {
    const number = view.jumpInput; view.jumpInput = undefined;
    try {
      const id = selectTaskNumber(view.tasks, Number(number), view.collapsed, true);
      if (!id) { view.notice = `No listed task #${number}`; return true; }
      view.selectedId = id; view.revealSelected = true; view.detailY = 0; view.detailsFocused = false;
      if (view.tasks.find(t => t.id === id)?.removedAt) view.history = true;
      view.notice = `Task #${number} selected`;
    } catch { view.notice = "Cannot jump: task tree is invalid; refresh to retry"; }
    return true;
  }
  view.jumpInput = undefined; view.notice = undefined; return false;
}
