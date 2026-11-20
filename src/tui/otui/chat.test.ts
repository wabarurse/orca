import { afterEach, describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import type { screens } from "../components";
import { ChatView, COLOURS, fillColour, finRows } from "./chat";
import { Display } from "./display";

type Harness = { setup: TestRendererSetup; actions: screens.ScreenAction[]; view: ChatView };

let made: TestRendererSetup[] = [];

afterEach(() => {
  for (const setup of made) setup.renderer.destroy();
  made = [];
});

const header: screens.ScreenHeader = { tabs: [{ label: "probe", active: true, busy: false }, { label: "other", active: false, busy: true }], account: "anthropic:work", details: ["model · default · ctx 1k/200k"], fin: null };

const chat = (over: Partial<screens.ChatScreen> = {}): screens.ChatScreen => ({ kind: "chat", header: null, items: [], tail: [], welcome: [], footer: ["> "], cursor: { row: 0, col: 2 }, ...over });

async function harness(width = 80, height = 16): Promise<Harness> {
  const setup = await createTestRenderer({ width, height });
  made.push(setup);
  const actions: screens.ScreenAction[] = [];
  const view = new ChatView(setup.renderer, { action: action => { actions.push(action); } });
  setup.renderer.root.add(view.root);
  return { setup, actions, view };
}

async function frame(h: Harness, screen: screens.ChatScreen): Promise<string[]> {
  h.view.show(screen, h.setup.renderer.width);
  await h.setup.renderOnce();
  return h.setup.captureCharFrame().split("\n").map(row => row.trimEnd());
}

const rowOf = (rows: string[], text: string): number => rows.findIndex(row => row.includes(text));

describe("chat view", () => {
  test("header: the active tab as a pill, the other tabs muted, the account row, the details, then the box's bottom line", async () => {
    const h = await harness();
    const rows = await frame(h, chat({ header }));
    expect(rows[0]).toMatch(/^│ {2}probe {4}other •/);
    expect(rows[1]).toMatch(/^│ account anthropic:work +│$/);
    expect(rows[2]).toMatch(/^│ model · default · ctx 1k\/200k +│$/);
    expect(rows[3]).toMatch(/^└─+┘$/);
    const pill = h.setup.captureSpans().lines[0]?.spans.find(span => span.text.includes("probe"));
    expect(pill?.text).toBe(" probe ");
    expect(pill?.bg).toEqual(RGBA.fromHex(COLOURS.light));
    const without = await frame(h, chat({ header: { ...header, account: null } }));
    expect(without[1]).toMatch(/^│ model · default/);
    expect(without[2]).toMatch(/^└─+┘$/);
  });

  test("the fin swims beside the details only when the header has one and the screen is at least 72 columns wide", async () => {
    const fin = finRows(32, 0, false);
    const wide = await harness(80);
    const shown = await frame(wide, chat({ header: { ...header, fin: { time: 0, active: false } } }));
    expect(shown.join("\n")).toContain("#####");
    expect(shown.some(row => row.includes(fin[3] ?? "missing"))).toBe(true);
    expect((await frame(wide, chat({ header }))).join("\n")).not.toContain("#####");
    const narrow = await harness(60);
    expect((await frame(narrow, chat({ header: { ...header, fin: { time: 0, active: false } } }))).join("\n")).not.toContain("#####");
  });

  test("a user message is a shaded block on the right", async () => {
    const h = await harness(80);
    const rows = await frame(h, chat({ items: [{ kind: "user", key: "user:1", gap: false, rows: ["hello there"], fill: "\x1b[48;5;236m" }] }));
    const at = rowOf(rows, "hello there");
    expect(at).toBeGreaterThan(0);
    const col = (rows[at] ?? "").indexOf("hello there");
    expect(col).toBeGreaterThanOrEqual(Math.floor(80 * 0.22));
    const span = h.setup.captureSpans().lines[at]?.spans.find(s => s.text.includes("hello there"));
    const shade = fillColour("\x1b[48;5;236m");
    expect(shade).not.toBeNull();
    expect(span?.bg).toEqual(shade ?? undefined);
    const right = h.setup.captureSpans().lines[at]?.spans.at(-1);
    expect(right?.bg).toEqual(shade ?? undefined);
  });

  test("the footer rows sit at the bottom, under the conversation and its tail", async () => {
    const h = await harness(40, 12);
    const rows = await frame(h, chat({ items: [{ kind: "rows", key: "0", gap: false, rows: ["reply"] }], tail: ["streaming"], footer: ["┌──┐", "│ > draft", "counts"] }));
    expect(rows.slice(9, 12)).toEqual(["┌──┐", "│ > draft", "counts"]);
    expect(rowOf(rows, "reply")).toBeLessThan(rowOf(rows, "streaming"));
    expect(rowOf(rows, "streaming")).toBeLessThan(9);
    expect(h.view.footerRows()).toBe(3);
  });

  test("a click on a fold's title asks to toggle it; an open fold shows its rows", async () => {
    const h = await harness(60, 12);
    const fold: screens.ScreenItem = { kind: "fold", key: "calls:3", gap: false, title: "2 tool calls", failed: " · 1 failed", open: false, rows: ["⏺ bash(a)", "  ⎿  ok"], opens: null };
    const closed = await frame(h, chat({ items: [fold] }));
    const at = rowOf(closed, "2 tool calls");
    expect(closed[at]).toContain("▸ 2 tool calls · 1 failed");
    expect(closed.join("\n")).not.toContain("bash(a)");
    await h.setup.mockMouse.click(3, at);
    await h.setup.renderOnce();
    expect(h.actions).toContainEqual({ kind: "toggle", key: "calls:3" });
    const open = await frame(h, chat({ items: [{ ...fold, open: true }] }));
    expect(open[rowOf(open, "tool calls")]).toContain("▾ 2 tool calls");
    expect(open[rowOf(open, "bash(a)")]).toMatch(/^ {2}⏺ bash\(a\)/);
  });

  test("a click on an open group's row asks to open that item on its tab", async () => {
    const h = await harness(60, 12);
    const rows = await frame(h, chat({ items: [{ kind: "fold", key: "questions:0", gap: false, title: "+ 2 questions", failed: "", open: true, rows: ["● Which?  open", "● Why?  open"], opens: "questions" }] }));
    await h.setup.mockMouse.click(4, rowOf(rows, "Why?"));
    await h.setup.renderOnce();
    expect(h.actions).toEqual([{ kind: "open", tab: "questions", index: 1 }]);
  });

  test("a click on a link asks to open it; a drag is no click", async () => {
    const h = await harness(60, 12);
    const rows = await frame(h, chat({ items: [{ kind: "rows", key: "0", gap: false, rows: ["see https://example.com/pr/1 now"] }] }));
    const at = rowOf(rows, "example.com");
    await h.setup.mockMouse.drag(6, at, 12, at);
    await h.setup.renderOnce();
    expect(h.actions.filter(action => action.kind === "link")).toEqual([]);
    await h.setup.mockMouse.click(10, at);
    await h.setup.renderOnce();
    expect(h.actions).toContainEqual({ kind: "link", url: "https://example.com/pr/1" });
  });
});

describe("display", () => {
  test("a page screen replaces the chat, and the chat comes back", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 });
    made.push(setup);
    const display = new Display(setup.renderer, () => undefined, () => undefined);
    const read = async (): Promise<string> => { await setup.renderOnce(); return setup.captureCharFrame(); };
    display.show(chat({ items: [{ kind: "rows", key: "0", gap: false, rows: ["conversation"] }], footer: ["composer"] }));
    expect(await read()).toContain("conversation");
    display.show({ kind: "page", rows: ["Agents  Tasks"], cursor: 0, col: 0 });
    const page = await read();
    expect(page).toContain("Agents  Tasks");
    expect(page).not.toContain("conversation");
    expect(page).not.toContain("composer");
    display.show(chat({ items: [{ kind: "rows", key: "0", gap: false, rows: ["conversation"] }], footer: ["composer"] }));
    const back = await read();
    expect(back).toContain("conversation");
    expect(back).not.toContain("Agents  Tasks");
  });
});

test("a user background SGR becomes the block's colour; none is no colour", () => {
  const shade = fillColour("\x1b[48;2;48;52;60m");
  expect(shade === null ? null : [shade.r, shade.g, shade.b].map(v => Math.round(v * 255))).toEqual([48, 52, 60]);
  expect(fillColour(null)).toBeNull();
  expect(fillColour("not an escape")).toBeNull();
});
