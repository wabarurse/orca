import { expect, test } from "bun:test";
import { bodyCols, chatItems, chatScreen, headerRows } from "./chat";
import { collapseCalls } from "../conversation/tools";
import { userLines } from "../conversation/restore";
import { lineRows, type CallLine, type Line, type Shown } from "../conversation/lines";
import { liveRows, type Frame } from "../footer/render";
import { whaleRows } from "../header/whale";
import { userFill, type screens } from "../components";

const tool = (name: string, failed = false): CallLine => ({ tool: `${name}(x)`, summary: failed ? "exit 1" : "ok", failed, kind: "tool", items: [] });
const ask: CallLine = { tool: "ask(Which?)", summary: "asked", failed: false, kind: "question", items: ["Which?", "Why?"] };
const plain = (rows: string[]) => rows.map(row => Bun.stripANSI(row));
const gaps = (items: screens.ScreenItem[]) => items.map(i => i.gap);
const frame = (over: Partial<Frame> = {}): Frame => ({ cols: 60, rows: 20, input: { prompt: "> ", text: "draft", cursor: 5 }, menu: null, status: "0 agents │ 0 tasks", ...over });
const header: screens.ScreenHeader = { tabs: [{ label: "probe", active: true, busy: false }], account: "anthropic:work", details: ["model · default"], fin: null };

test("a user message's lines become one block without the \"> \" (keyed by its first line); the next message starts another", () => {
  const items = chatItems([...userLines("hello\nsecond line"), ...userLines("again")], 40);
  expect(items).toEqual([
    { kind: "user", key: "user:0", gap: false, rows: ["hello", "second line"], fill: userFill() },
    { kind: "user", key: "user:2", gap: false, rows: ["again"], fill: userFill() },
  ]);
});

test("blocks get a blank above them; wrapped strings, continuations and whatever follows a user block do not", () => {
  const lines: Line[] = [{ md: "first", block: true }, "wrapped row", { md: "second", block: true }, { md: "more of it", block: true, continuation: true }, tool("bash"), ...userLines("go"), { md: "reply", block: true }];
  const items = chatItems(lines, 40);
  expect(items.map(i => i.kind)).toEqual(["rows", "rows", "rows", "rows", "rows", "user", "rows"]);
  expect(gaps(items)).toEqual([false, false, true, false, true, false, false]);
  expect(items[0]).toEqual({ kind: "rows", key: "0", gap: false, rows: lineRows({ md: "first", block: true }, 40) });
  expect(plain(items[4]?.kind === "rows" ? items[4].rows : [])).toEqual(["⏺ bash(x)", "  ⎿  ok"]);
});

test("a turn's folds stack without blanks: the calls fold, then its groups; agent messages in a row stack too", () => {
  const shown: Shown[] = collapseCalls([{ md: "text", block: true }, tool("bash"), tool("read", true), ask, { image: "shot.png" }, { from: "worker-a", text: "done" }, { from: "worker-b", text: "also" }]);
  const items = chatItems(shown, 40);
  expect(items.map(i => i.key)).toEqual(["0", "calls:1", "questions:1", "images:1", "from:5", "from:6"]);
  expect(gaps(items)).toEqual([false, true, false, false, false, false]);
  expect(items[1]).toEqual({ kind: "fold", key: "calls:1", gap: true, title: "2 tool calls · bash ×1, read ×1", failed: " · 1 failed", open: false, rows: [], opens: null });
  expect(chatItems([{ md: "a", block: true }, { from: "worker-a", text: "x" }], 40).map(i => i.gap)).toEqual([false, true]);
});

test("fold items: an open calls fold lists its calls; groups name the tab their rows open; an agent's message wraps under ⎿", () => {
  const shown = collapseCalls([tool("bash"), tool("read", true), ask, { image: "shot.png" }, { from: "worker-a", text: "abcdefghijklmnopqrstuvwxyz" }], new Set(["calls:0", "questions:0", "from:4"]));
  const items = chatItems(shown, 24);
  const fold = (key: string) => {
    const found = items.find(i => i.key === key);
    if (found?.kind !== "fold") throw new Error(`no fold ${key}`);
    return found;
  };
  expect(plain(fold("calls:0").rows)).toEqual(["⏺ bash(x)", "  ⎿  ok", "⏺ read(x)", "  ⎿  exit 1"]);
  expect(fold("questions:0")).toMatchObject({ title: "+ 2 questions", open: true, opens: "questions", failed: "" });
  expect(plain(fold("questions:0").rows)).toEqual(["● Which?  open", "● Why?  open"]);
  expect(fold("images:0")).toMatchObject({ title: "+ 1 image", open: false, opens: "images" });
  expect(plain(fold("images:0").rows)).toEqual(["● shot.png  open"]); // rows are there for when it opens
  expect(fold("from:4")).toMatchObject({ title: "from worker-a", open: true, opens: null });
  expect(plain(fold("from:4").rows)).toEqual(["⎿  abcdefghijklmnopq", "   rstuvwxyz"]);
  for (const row of items.flatMap(i => i.rows)) expect(Bun.stringWidth(Bun.stripANSI(row))).toBeLessThanOrEqual(bodyCols(24));
});

test("headerRows: tabs, the account row when known, each details row and the bottom line", () => {
  expect(headerRows(header, 60)).toBe(4);
  expect(headerRows({ ...header, account: null, details: ["orc: a", "worker: b", "reviewer: c", "ctx"] }, 60)).toBe(6);
  expect(headerRows({ ...header, fin: { time: 0, active: false } }, 80)).toBe(6); // the fin is five rows beside the text
  expect(headerRows({ ...header, fin: { time: 0, active: false } }, 60)).toBe(4); // no fin under 72 columns
  expect(headerRows(null, 60)).toBe(0);
});

test("chatScreen: the footer is liveRows' layout of the rows left under the header, without the live tail", () => {
  const f = frame({ partial: "streaming text\nsecond", running: ["⏺ bash(sleep)"], activity: "thinking…", queued: { project: "probe", texts: ["queued one"] } });
  const items = chatItems([{ md: "reply", block: true }], 60);
  const screen = chatScreen(f, items, header);
  const bottom = liveRows({ ...f, rows: f.rows - headerRows(header, 60) - 1, partial: "", running: [], activity: undefined });
  expect(screen.footer).toEqual(bottom.rows);
  expect(screen.cursor).toEqual({ row: bottom.cursor, col: bottom.col });
  expect(screen.tail).toEqual(["streaming text", "second", "⏺ bash(sleep)", "thinking…"]);
  expect(screen).toMatchObject({ kind: "chat", header, items, welcome: [] });
  expect(chatScreen(frame(), [], null)).toMatchObject({ header: null, tail: [] });
  expect(chatScreen(frame({ partial: "x".repeat(130) }), [], null).tail.map(row => Bun.stripANSI(row))).toEqual(["x".repeat(60), "x".repeat(60), "x".repeat(10)]); // wrapped to the width
});

test("the welcome orca shows only in an empty new chat", () => {
  const f = frame({ cols: 100, rows: 40, welcome: true });
  const empty = chatScreen(f, [], header);
  expect(empty.welcome.length).toBeGreaterThan(0);
  expect(empty.welcome).toEqual(whaleRows(100, 40 - headerRows(header, 60) - empty.footer.length));
  expect(chatScreen(f, chatItems(["x"], 100), header).welcome).toEqual([]);
  expect(chatScreen({ ...f, activity: "thinking…" }, [], header).welcome).toEqual([]);
  expect(chatScreen({ ...f, welcome: false }, [], header).welcome).toEqual([]);
});

test("an agent's report keeps its line breaks when opened", () => {
  const [item] = chatItems(collapseCalls([{ from: "worker-a", text: "line one\nline two" }], new Set(["from:0"])), 40);
  expect(item?.kind === "fold" ? plain(item.rows) : []).toEqual(["⎿  line one", "   line two"]);
});
