import { afterEach, expect, test } from "bun:test";
import { append, commit, live, liveRows, queuedRows, type Frame } from "../footer/render";
import { stickyRows, stickyUpdate } from "./sticky";
import { chapterRows } from "../header/chrome";
import { historyRows, type Line } from "../conversation/lines";
import { userLines } from "../conversation/restore";
import { MarkdownStream } from "../conversation/mdstream";
import { FakeScreen } from "../components/testing";
import { pickFill, setUserFill } from "../components/style";

const bg = "\x1b[48;5;236m";
afterEach(() => setUserFill(null));
const frame = (cols = 40, rows = 12): Frame => ({ cols, rows, status: "2 agents running │ 0 tasks │ 1 question", input: { prompt: "> ", text: "hello\n你好", cursor: 8 }, menu: { title: "models", items: ["one", "two"], index: 0 } });

test("bottom bar input precedes counts and modal; cursor and backgrounds survive append and resize", () => {
  setUserFill(bg);
  const f = frame();
  const r = liveRows(f);
  expect(r.rows.map(Bun.stripANSI).map((s) => s.trimEnd())).toEqual(["┌──────────────────────────────────────┐", "│> hello                               │", "│  你好                                │", "└──────────────────────────────────────┘", "2 agents running │ 0 tasks │ 1 question", "models", "❯ one", "  two"]);
  expect([r.cursor, r.col]).toEqual([2, 7]);
  const screen = new FakeScreen(f.cols, f.rows);
  const first = live(f);
  screen.write(first.text);
  expect([screen.row, screen.col]).toEqual([2, 7]);
  expect(screen.backgrounds().slice(0, 6).every((row) => row.length === 40 && row.every((b) => b === "48;5;236"))).toBe(true);
  const next = append(["reply"], f, first.shown);
  screen.write(next.text);
  expect(screen.text().startsWith("reply\n┌")).toBe(true);
  expect([screen.row, screen.col]).toEqual([3, 7]);
  screen.resize(12, 4);
  screen.write("\x1b[2J\x1b[H" + live(frame(12, 4)).text);
  expect(screen.row).toBeLessThan(4);
  expect(screen.col).toBeLessThan(12);
});

test("short and narrow composers never spill or lose cursor; NO_COLOR gives no bands", () => {
  for (const cols of [2, 4, 8]) for (const rows of [1, 2, 3]) {
    setUserFill(bg);
    const f = frame(cols, rows);
    const drawn = liveRows(f);
    expect(drawn.rows.length).toBeLessThanOrEqual(rows);
    expect(drawn.rows.every((r) => Bun.stringWidth(r) <= cols)).toBe(true);
    const s = new FakeScreen(cols, rows);
    s.write(live(f).text);
    expect(s.col).toBe(drawn.col);
  }
  setUserFill(pickFill({ NO_COLOR: "1" }));
  expect(liveRows(frame()).rows.join("")).not.toContain("48;");
});

test("chapter header stays pinned and unshaded while the conversation scrolls", () => {
  const f = frame(80, 24);
  const s = new FakeScreen(f.cols, f.rows);
  const header = chapterRows({ tabs: [{ name: "project" }], active: 0, model: "model", directory: "/directory", remote: "host/remote" }, f.cols);
  const first = stickyRows(f, [], header);
  s.write(stickyUpdate(first));
  const next = stickyRows(f, Array.from({ length: 80 }, (_, i) => `response ${i}`), header);
  const update = stickyUpdate(next, first);
  s.write(update);
  expect(update).not.toContain(">[project]");
  expect(s.screen()[0]).toContain(">[project]");
  expect(s.text()).toContain("response 79");
  expect(s.backgrounds()[0]!.some(Boolean)).toBe(false);
  expect(s.top).toBe(0);
});

test("logical block separators are neutral, tools stay paired, lists and wrapped rows stay together", () => {
  setUserFill(bg);
  const lines: Line[] = [...userLines("hello long message\ncontinuation"), { md: "reply", block: true }, { md: "", block: true }, { md: "- a", block: true }, { md: "- b", block: true, continuation: true }, { tool: "bash(ls)", summary: "2 lines", failed: false }, { tool: "bash(sleep)", summary: "interrupted", failed: true }];
  const full = historyRows(lines, 12);
  const split = [...historyRows(lines.slice(0, 4), 12), ...historyRows(lines.slice(4), 12, lines[3])];
  expect(split).toEqual(full);
  const s = new FakeScreen(12, 30);
  s.write(commit(full, 12));
  expect(s.text()).toContain("reply\n\n- a\n- b\n\n⏺ bash(ls)\n  ⎿  2 lines\n\n⏺ bash(slee…\n  ⎿  interr…");
  for (const [i, row] of s.buf.entries()) if (!row.join("").trim()) expect(s.backgrounds()[i]!.some(Boolean)).toBe(false);
});

test("stream chunk boundaries do not change spacing", () => {
  const text = "First paragraph.\n\n- one\n- two\n\nLast.\n";
  function rows(chunks: string[]) {
    const md = new MarkdownStream();
    const lines: Line[] = [];
    for (const chunk of chunks) lines.push(...md.feedLines(chunk));
    lines.push(...md.flushLines());
    return historyRows(lines, 10);
  }
  expect(rows([...text])).toEqual(rows([text]));
});

test("queued previews sit immediately above the composer, with ordered Unicode/multiline clipping and hidden counts", () => {
  const f: Frame = { ...frame(64, 18), menu: null, queued: { project: "display name", texts: ["first\nsecond 界é👩‍💻", "long " + "界é👩‍💻".repeat(100), "third", "fourth", "fifth", "sixth"] } };
  const drawn = liveRows(f), rows = drawn.rows.map(Bun.stripANSI);
  expect(rows[0]).toBe("queued 5/6 · orchestrator · 1 hidden · display name");
  expect(rows[1]).toBe("  1. first ↵ second 界é👩‍💻");
  expect(rows[2]).toEndWith("…");
  expect(rows[5]).toBe("  5. fifth");
  expect(rows[6]).toStartWith("┌");
  expect(rows[drawn.cursor]).toContain("你好");
  expect(f.queued!.texts[0]).toBe("first\nsecond 界é👩‍💻"); // preview never mutates delivery text
});

test("queued layout is bounded at every small size without changing composer geometry or escaping its footer", () => {
  for (const cols of [1, 2, 4, 8, 12, 23, 40, 80]) for (const rows of [1, 2, 3, 4, 6, 8, 12, 16, 24, 50]) {
    const f: Frame = { ...frame(cols, rows), menu: null, queued: { project: "queue", texts: Array.from({ length: 40 }, (_, i) => `${i}: 界é👩‍💻\n\tline\x1b[2J\x1b[H\x1b]0;bad title\x07\x1b[31mred\x1b[0m\b\x07`) } };
    const plain = stickyRows({ ...f, queued: undefined }, ["conversation"], []);
    const drawn = stickyRows(f, ["conversation"], []);
    expect(drawn.rows).toHaveLength(rows);
    expect(drawn.rows.every(row => Bun.stringWidth(row) <= cols)).toBe(true);
    expect(drawn.cursor).toBe(plain.cursor); // no editor space stolen by pending input
    expect(drawn.col).toBe(plain.col);
    expect(drawn.rows[drawn.cursor]).toBe(plain.rows[plain.cursor]);
    // The three-row reserve includes the new separator except on tiny screens.
    expect(drawn.bodyHeight).toBeGreaterThanOrEqual(Math.min(rows < 8 ? 3 : 2, plain.bodyHeight));
    const bottom = liveRows({ ...f, rows: Math.max(1, rows - 1) });
    const footerAt = rows - bottom.rows.length;
    expect(drawn.rows.slice(footerAt)).toEqual(bottom.rows);
    if (rows >= 8 && footerAt >= 2) expect(drawn.rows[footerAt - 1]).toBe("");
    expect(plain.bodyHeight - drawn.bodyHeight).toBeLessThanOrEqual(6);
    const screen = new FakeScreen(cols, rows);
    screen.write(stickyUpdate(drawn));
    expect([screen.row, screen.col]).toEqual([drawn.cursor, drawn.col]);
    expect(screen.top).toBe(0);
    expect(screen.screen().join("\n")).not.toContain("bad title");
  }
});

test("pending previews reserve the same help viewport used by its scroll keys", async () => {
  const { helpPanel } = await import("../footer/render");
  const f: Frame = { ...frame(60, 20), menu: null, queued: { project: "demo", texts: ["one", "two"] }, help: { lines: Array.from({ length: 60 }, (_, i) => `help ${i}`), top: 50 } };
  const help = helpPanel(f), drawn = liveRows(f);
  expect(drawn.rows.length).toBeLessThanOrEqual(18); // help retains two conversation rows too
  expect(drawn.rows.slice(-help.rows.length).map(Bun.stripANSI)).toEqual(help.rows.map(Bun.stripANSI));
  expect(help.rows.at(-1)).toContain("esc close");
  expect(drawn.rows.map(Bun.stripANSI)[0]).toStartWith("queued 2/2");
});


test("one-row queue budgets still preview the oldest prompt; compact headings prioritize the orchestrator owner", () => {
  const queued = { project: "project", texts: ["oldest", "later", "last"] };
  expect(queuedRows(queued, 40, 1).map(Bun.stripANSI)).toEqual(["queued 1/3 · orch: oldest"]);
  expect(queuedRows(queued, 24, 2).map(Bun.stripANSI)[0]).toStartWith("queued 1/3 · orch");
  expect(queuedRows(queued, 40, 0)).toEqual([]);
  expect(queuedRows({ ...queued, texts: [] }, 40, 4)).toEqual([]);
});
