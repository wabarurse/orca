import { appFixture } from "../test/app-fixture";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/config";
import { App, type Clock, type Line } from "./app";
import { createOrchestrator } from "../core/agent-loop/orc/orchestrator";
import { put } from "../core/data/inbox/inbox";
import type { Message } from "../protocol/inbox";
import { all as allQuestions, answer as answerQuestion, ask as askQuestions } from "../core/data/inbox/questions";
import { MAX_RESTORED_ROWS, userLines } from "./conversation/restore";
import { historyRows, lineRows } from "./conversation/lines";
import { fakeProvider, text as said, toolUse } from "../test/fake-provider";
import { message } from "../core/tools/message";
import { open as openTranscript } from "../core/data/transcripts/transcript";
import { ESC_DELAY_MS, parseKeys } from "./components/keys";
import { realTerminal } from "./components/term";
import { FakeScreen } from "./components/testing";
import { live as renderLive } from "./footer/render";
import { Calls } from "./conversation/tools";

const { home, screenErrors, USER_BG, strip, raw, fakeTerm, bodyStart, bodyRows, clickRow, fakeOrchestrators, settle, NO_REPLY_WINDOW, until } = appFixture();

test("saved history beyond the preview budget remains reachable before exit, including before compaction", async () => {
  const project = "full-scroll", t = openTranscript(paths.transcript(project, "orchestrator"));
  await t.append({ type: "meta", role: "orchestrator", model: "m" });
  await t.append({ type: "message", message: { role: "user", content: "ORIGINAL-BEFORE-COMPACTION" } });
  for (let i = 0; i < 140; i++) await t.append({ type: "message", message: { role: "assistant", content: `saved record ${i}: ` + "wrapping words ".repeat(6) } });
  await t.append({ type: "summary", text: "MODEL-ONLY-SUMMARY", retained: [], boundary: t.head() });
  await t.append({ type: "message", message: { role: "assistant", content: "AFTER-COMPACTION" } });
  const term = fakeTerm(100, 24), orchs = fakeOrchestrators();
  for (let i = 0; i < 40; i++) term.write(`PRELAUNCH-SHELL-${i}\r\n`);
  const app = new App({ term, pollMs: 100_000, watchdog: async () => {}, merges: async () => {},
    openOrchestrator: async (p, url, write, inbox) => ({ ...await orchs.openOrchestrator(p, url, write, inbox), entries: () => p === project ? t.history!() : [] }),
  });
  const running = app.run(project);
  try {
    await until(() => term.screen().includes("AFTER-COMPACTION"));
    const rows = historyRows(app.page!.lines, term.cols).length;
    expect(rows).toBeGreaterThan(MAX_RESTORED_ROWS * 2);
    expect(app.page!.lines.map(raw).join("\n")).not.toMatch(/MODEL-ONLY-SUMMARY|earlier messages/);
    term.type("\x1b[200~draft 界é👩‍💻\nsecond line\x1b[201~");
    await until(() => term.screen().includes("second line"));
    const draft = { ...app.input }, top = bodyStart(term);
    const header = term.display.screen().slice(0, top), footer = term.display.screen().slice(-5);
    // Injected reports exercise the application path, NOT physical Apple Terminal gestures.
    const scrollToStart = async () => {
      term.type("\x1b[<64;10;8M".repeat(Math.ceil(rows / 3) + 10));
      await until(() => term.screen().includes("ORIGINAL-BEFORE-COMPACTION"));
    };
    await scrollToStart();
    expect(term.display.screen()[top]).toBe("> ORIGINAL-BEFORE-COMPACTION");
    const body = term.display.screen().slice(top, -5);
    term.type("\x1b[<64;10;8M".repeat(20)); // clamp at the original first message
    app.say("LIVE-WHILE-READING");
    await Bun.sleep(40);
    expect(term.display.screen().slice(top, -5)).toEqual(body);
    expect(term.display.screen().slice(0, top)).toEqual(header);
    expect(term.display.screen().slice(-5)).toEqual(footer);
    expect(term.screen()).not.toContain("PRELAUNCH-SHELL");
    expect(term.display.modes.get(1049)).toBe(true);
    for (const cols of [23, 100]) {
      term.resize(cols, 24);
      await Bun.sleep(170);
      expect(bodyRows(term)[0]).toStartWith("> ORIGINAL-BEFORE");
      expect(app.input).toEqual(draft);
    }
    // Tail-following resumes at the bottom; switching projects never drops the original history.
    term.type("\x1b[<65;10;8M".repeat(rows));
    await until(() => term.screen().includes("LIVE-WHILE-READING"));
    await app.openPage("other-scroll");
    term.type("\x1a");
    await until(() => term.screen().includes("LIVE-WHILE-READING"));
    await scrollToStart();
    expect(app.input).toEqual(draft);
    expect(term.raw()).not.toContain("\x1b[?1049l");
    expect(term.raw()).not.toContain("\x1b[3J");
  } finally { app.quit(); await running; }
  const exit = term.screen();
  expect(exit).toContain("PRELAUNCH-SHELL-0");
  for (const text of ["ORIGINAL-BEFORE-COMPACTION", "AFTER-COMPACTION", "LIVE-WHILE-READING"]) expect(exit.split(text).length - 1).toBe(1);
  expect(exit.indexOf("ORIGINAL-BEFORE-COMPACTION")).toBeLessThan(exit.indexOf("saved record 0:"));
  expect(exit.indexOf("saved record 139:")).toBeLessThan(exit.indexOf("AFTER-COMPACTION"));
  expect(exit).not.toContain("MODEL-ONLY-SUMMARY");
  expect(term.display.modes.get(1049)).toBe(false);
});

test("header caches model and filters subagent counts; unchanged background frames write no bytes", async () => {
  const term = fakeTerm(80, 24);
  const ticks: { fn: () => void; ms: number }[] = [];
  let now = 0;
  const clock: Clock = { now: () => now, every: (fn, ms) => { const tick = { fn, ms }; ticks.push(tick); return () => { ticks.splice(ticks.indexOf(tick), 1); }; } };
  let model = "model-a", reads = 0;
  const app = new App({ term, clock, pollMs: 100_000, projectModel: async () => { reads++; return model; }, agents: async () => [{ name: "orchestrator", live: true }, { name: "worker-a", live: true }, { name: "reviewer-a", live: true }, { name: "worker-old", live: false }], openOrchestrator: fakeOrchestrators().openOrchestrator });
  const running = app.run("header-test");
  await until(() => term.screen().includes("model-a") && term.screen().includes("2 agents running"));
  const readOnce = reads;
  app.frame(); app.frame();
  expect(reads).toBe(readOnce);
  model = "model-b";
  await app.refreshHeader();
  await until(() => term.screen().includes("model-b"));
  const background = app.page!;
  await app.openPage("foreground-test");
  background.busy = true;
  app.draw();
  await settle();
  expect(ticks.map((t) => t.ms)).toEqual([100]);
  const before = term.writes.length;
  const frame = app.frame();
  const shown = renderLive(frame).shown;
  const lastBytes = Buffer.byteLength(`\x1b[?2026h${renderLive(frame, shown).text}\x1b[?2026l`);
  for (let i = 0; i < 10; i++) { now += 100; ticks[0]!.fn(); await Bun.sleep(20); }
  const bytes = term.writes.slice(before).reduce((n, s) => n + Buffer.byteLength(s), 0);
  expect(bytes).toBe(0);
  await Bun.write("/tmp/tui-background-bandwidth.json", JSON.stringify({ cols: 80, rows: 24, oldBytesPerSecond: lastBytes * (1000 / 33), newBytesPerSecond: bytes }));
  app.page!.busy = true;
  app.draw();
  expect(ticks.map((t) => t.ms)).toEqual([33]);
  app.quit();
  await running;
});

test("external question closure preserves both original chat and orphan answer, expanded or collapsed", async () => {
  for (const collapsed of [false, true]) {
    const project = `orphan-drafts-${collapsed}`;
    const term = fakeTerm(100, 18);
    const app = new App({ term, openOrchestrator: fakeOrchestrators().openOrchestrator, questionDelayMs: 0, pollMs: 10, watchdog: async () => {}, merges: async () => {} });
    const running = app.run(project);
    await until(() => !!app.page);
    term.type("original chat draft");
    const [first, next] = await askQuestions(project, [{ text: "First?" }, { text: "Next?" }]);
    await app.questions.command(app.page);
    term.type("orphan answer");
    expect(app.input.text).toBe("orphan answer");
    if (collapsed) term.press({ name: "q", ctrl: true });
    await answerQuestion(project, first!.id, "someone else's answer");
    await until(() => app.page!.questions.open[0]?.id === next!.id);
    expect(app.input.text).toBe("original chat draft");
    expect(app.page!.lines.map(raw).join(" ")).toContain("unsent answer: orphan answer");
    expect(app.questions.view()).toBeNull();
    await app.questions.command(app.page);
    expect(app.input.text).toBe(""); // orphan never becomes the next question's answer
    term.press({ name: "escape" });
    expect(app.input.text).toBe("original chat draft");
    app.quit(); await running;
  }
});

test("header refresh generations reject reverse completion and closed/reopened pages", async () => {
  const reads: ((model: string) => void)[] = [];
  let defer = false;
  const term = fakeTerm(80, 12);
  const app = new App({ term, pollMs: 100_000, projectModel: async () => defer ? new Promise<string>((r) => reads.push(r)) : "initial", openOrchestrator: fakeOrchestrators().openOrchestrator });
  const running = app.run("refresh-a");
  await until(() => !!app.page);
  const a = app.page!;
  defer = true;
  const first = app.refreshHeader(a), second = app.refreshHeader(a);
  reads[1]!("newest"); await second;
  reads[0]!("old"); await first;
  expect(a.model).toBe("newest");
  const offscreen = app.refreshHeader(a);
  defer = false;
  await app.openPage("refresh-b");
  reads[2]!("offscreen-a"); await offscreen;
  expect(app.page!.model).toBe("initial");
  expect(a.model).toBe("offscreen-a");
  defer = true;
  const stale = app.refreshHeader(a);
  app.closePage(app.pages.indexOf(a));
  defer = false;
  const reopened = await app.openPage("refresh-a");
  reads[3]!("stale-closed"); await stale;
  expect(reopened).not.toBe(a);
  expect(reopened.model).toBe("initial");
  expect(a.model).toBe("offscreen-a");
  app.quit(); await running;
});

test("sign-in queue attempts every owned message after failures across pages without duplicating consumed successes", async () => {
  for (const failed of ["one", "two"]) {
    const attempted: string[] = [];
    let finish!: () => void;
    const term = fakeTerm(100, 18);
    const app = new App({ term, pollMs: 100_000, login: async () => { await new Promise<void>((r) => { finish = r; }); return "signed in"; }, openOrchestrator: async (_p, _u, _w, inbox) => ({
      async say(text, _submission, inputId) { attempted.push(text); if (text === failed) throw new Error("send failed"); inbox?.([{ from: "user", text, inputId, ts: "" }]); },
      async pending() { return false; }, async turn() { return []; },
    }) });
    const running = app.run(`login-drain-${failed}`);
    await until(() => !!app.page);
    const firstPage = app.page!;
    term.type("/login claude\r");
    await until(() => !!finish);
    term.type("one\rtwo\r");
    await until(() => app.status(firstPage).includes("2 messages queued"));
    expect(app.frame().queued?.texts).toEqual(["one", "two"]);
    await app.openPage(`login-other-${failed}`);
    const secondPage = app.page!;
    term.type("three\r");
    await until(() => app.status(secondPage).includes("1 message queued"));
    expect(app.frame().queued?.texts).toEqual(["three"]);
    finish();
    await until(() => attempted.length === 3 && app.status(secondPage).includes("0 messages queued"));
    expect(attempted).toEqual(["one", "two", "three"]);
    const displayed = [...firstPage.lines, ...secondPage.lines].map(raw).map(strip);
    for (const text of ["one", "two", "three"]) expect(displayed.filter((l) => l === `> ${text}`).length).toBe(text === failed ? 0 : 1);
    expect(displayed).toContain(`not sent: ${failed}`);
    expect(firstPage.sent).toEqual([]);
    expect(secondPage.sent).toEqual([]);
    expect(app.frame().queued?.texts).toEqual([]);
    app.switchPage(-1);
    expect(app.frame().queued?.texts).toEqual([]);
    app.quit(); await running;
  }
});

describe("ctrl+c cancellation", () => {
  test("first cancels only selected page, preserves draft, expires after 2s; second exits", async () => {
    const term = fakeTerm(100, 20);
    const cancelled: string[] = [];
    const fakes = fakeOrchestrators();
    let now = 100;
    const app = new App({ term, pollMs: 100_000, clock: { now: () => now, every: () => () => {} },
      async openOrchestrator(...args) { return { ...await fakes.openOrchestrator(args[0], args[1], args[2], args[3]), cancel: () => { cancelled.push(args[0]); } }; },
    });
    const running = app.run("cancel-a");
    await until(() => !!app.page);
    term.type("/new cancel-b\r");
    await until(() => app.page?.project === "cancel-b");
    app.input = { text: "unsent draft", cursor: 12 };
    app.keyEcho = true; // diagnostic/menu layers must not swallow the interrupt
    await app.onKey({ name: "c", ctrl: true });
    expect(cancelled).toEqual(["cancel-b"]);
    expect(app.input.text).toBe("unsent draft");
    expect(term.closed).toBe(false);
    await until(() => term.screen().includes("within 2 seconds to exit"));
    now += 2001;
    await app.onKey({ name: "c", ctrl: true });
    expect(cancelled).toEqual(["cancel-b", "cancel-b"]);
    expect(term.closed).toBe(false);
    now += 1999;
    await app.onKey({ name: "c", ctrl: true });
    await running;
    expect(term.closed).toBe(true);
  });

  test("agent view cancels only selected session, leaving orchestrator and other roles alone", async () => {
    const term = fakeTerm(100, 20);
    const cancelled: string[] = [];
    const fakes = fakeOrchestrators();
    const app = new App({ term, pollMs: 100_000,
      async openOrchestrator(...args) { return { ...await fakes.openOrchestrator(args[0], args[1], args[2], args[3]), cancel: () => { cancelled.push("orchestrator"); } }; },
      async cancelAgent(project, id) { cancelled.push(`${project}/${id}`); },
    });
    const running = app.run("selected-agent");
    await until(() => !!app.page);
    app.page!.view = { name: "reviewer-x", lines: [], live: true, calls: new Calls(), leave() {} };
    await app.onKey({ name: "c", ctrl: true });
    expect(cancelled).toEqual(["selected-agent/reviewer-x"]);
    expect(app.page!.view!.name).toBe("reviewer-x");
    expect(term.closed).toBe(false);
    await until(() => term.screen().includes("stopping selected agent"));
    app.quit();
    await running;
  });
});

test("real App login-held pre-cancel input stays paused, retains FIFO, and does not block other pages", async () => {
  const term = fakeTerm(90, 20);
  const providers = new Map<string, ReturnType<typeof fakeProvider>>();
  let finish!: () => void;
  const app = new App({ term, pollMs: 100_000,
    login: async () => { await new Promise<void>(resolve => { finish = resolve; }); return "signed in"; },
    openOrchestrator: async (project, _url, write, onInbox, events) => {
      const provider = fakeProvider([[said("received")]]);
      providers.set(project, provider);
      return createOrchestrator({ project, provider, tools: {}, write, onInbox, ...events });
    },
  });
  const running = app.run("login-cancel-real");
  try {
    await until(() => !!app.page);
    const cancelled = app.page!;
    term.type("/login claude\r");
    await until(() => app.loggingIn);
    term.type("held one\rheld two\r");
    await until(() => cancelled.lines.filter(l => raw(l).includes("queued; runs after sign-in")).length === 2);
    term.type("\x03");
    await until(() => strip(app.frame().inputArea!.lines[0]!).startsWith("turn cancelled.") && !cancelled.lines.some(l => raw(l).includes("turn cancelled"))); // a note, not a line
    await app.openPage("login-cancel-other");
    term.type("unrelated input\r");
    await until(() => app.page!.lines.some(l => raw(l).includes("queued; runs after sign-in")));
    finish();
    await until(() => providers.get("login-cancel-other")!.calls.length === 1);
    expect(providers.get("login-cancel-real")!.calls).toHaveLength(0);
    expect(await cancelled.orch.pending()).toBe(false);
    term.type("\x1a"); // selected cancelled page
    expect(app.page).toBe(cancelled);
    term.type("continue now\r");
    await until(() => providers.get("login-cancel-real")!.calls.length === 1);
    const messages = providers.get("login-cancel-real")!.calls[0]!.messages;
    expect(messages.at(-1)?.content).toBe("[user] held one\n\n[user] held two\n\n[user] continue now");
  } finally { app.quit(); await running; }
});

test("current-view resize anchoring ignores unrelated sessions, and tail activity never enters restored or exit history", async () => {
  const term = fakeTerm(80, 24);
  const orchs = fakeOrchestrators();
  const clock: Clock = { now: () => 5000, every: () => () => {} };
  const app = new App({ term, openOrchestrator: orchs.openOrchestrator, clock, pollMs: 100_000 });
  const running = app.run("anchored-e");
  try {
    await until(() => !!app.page);
    const page = app.page!;
    await app.openPage("unrelated-e");
    app.page!.busy = true;
    app.switchPage(-1);
    const records: Line[] = Array.from({ length: 50 }, (_, i) => {
      const text = `record ${i}: ` + "words ".repeat(25);
      return i % 2 ? userLines(text)[0]! : { md: text };
    });
    page.lines.push(...records);
    expect(historyRows(page.lines, 80).length).toBeGreaterThan(records.length);
    expect(historyRows(page.lines, 23).length).toBeGreaterThan(historyRows(page.lines, 80).length);
    app.reprint();
    term.type("reading draft");
    page.busy = true;
    page.busySince = 0;
    app.draw();
    await until(() => term.screen().includes("thinking… 5s"));
    for (let i = 0; i < 30; i++) term.press({ name: "pageup" });
    await until(() => bodyRows(term)[0]!.startsWith("record 0:"));
    const top = historyRows(records, 80).findIndex(row => Bun.stripANSI(row).startsWith("> record 21:"));
    expect(top % 3).toBe(0);
    for (let i = 0; i < top / 3; i++) term.press({ name: "wheeldown" });
    await until(() => bodyRows(term)[0]!.startsWith("> record 21:"));
    const reading = "> record 21:";
    const visible = bodyRows(term);
    orchs.writers[page.project]!("appended structured paragraph " + "new words ".repeat(30) + "\n");
    orchs.writers["unrelated-e"]!("background owner paragraph " + "elsewhere ".repeat(20) + "\n");
    await Bun.sleep(30);
    expect(bodyRows(term)).toEqual(visible);
    expect(app.input.text).toBe("reading draft");
    const durable = JSON.stringify(page.lines);
    for (const cols of [23, 80, 10, 53, 23, 80]) {
      term.resize(cols, 24);
      await Bun.sleep(170);
      expect(bodyRows(term)[0]).toBe(Bun.stripANSI(lineRows(records[21]!, cols)[0]!).trimEnd());
      expect(term.screen()).not.toContain("thinking…");
      expect(app.input.text).toBe("reading draft");
      expect(term.display.col).toBe(app.frame().inputArea!.col);
      expect(JSON.stringify(page.lines)).toBe(durable);
    }
    app.switchPage(1);
    await until(() => term.screen().includes("working…"));
    expect(term.screen()).not.toContain("record ");
    app.switchPage(-1);
    await until(() => term.screen().includes("working… 5s"));
    // A different conversation owns a different viewport: switching back follows its tail.
    expect(term.screen()).not.toContain(reading);
    page.busy = false;
    app.draw();
    await until(() => !term.screen().includes("working…"));
    expect(app.frame().activity).toBeUndefined(); // background session remains busy
    expect(JSON.stringify(page.lines)).toBe(durable);
  } finally { app.quit(); await running; }
  expect(term.screen()).not.toMatch(/thinking|working|opening|agents running|messages queued/);
});

test("boxed input and question vertical editing share rendered geometry across resize, retaining the chat draft", async () => {
  const { inputGeometry } = await import("./footer/render");
  const { vertical } = await import("./footer/editor");
  const term = fakeTerm(40, 24);
  const orchs = fakeOrchestrators();
  const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 20, questionDelayMs: 0, watchdog: async () => {}, merges: async () => {} });
  const running = app.run("boxed-question-e");
  const width = () => inputGeometry(app.frame().input.prompt, term.cols, Math.max(1, term.rows - bodyStart(term) - 1)).width;
  try {
    await until(() => term.screen().includes(">[boxed-question-e]"));
    term.type("界".repeat(40) + "é👩‍💻");
    const draft = app.input.text;
    const expected = vertical(app.input, width(), -1)!;
    term.press({ name: "up" });
    expect(app.input).toEqual(expected);
    await askQuestions("boxed-question-e", [{ text: "Destination?" }]);
    await until(() => app.page!.questions.open.length === 1);
    expect(app.input.text).toBe(draft);
    term.press({ name: "q", ctrl: true });
    await until(() => app.questions.answering());
    term.type("界".repeat(40) + " answer");
    const answer = app.input.text;
    const before = vertical(app.input, width(), -1)!;
    term.press({ name: "up" });
    expect(app.input).toEqual(before);
    term.resize(17, 18);
    await Bun.sleep(160);
    const after = vertical(app.input, width(), -1)!;
    term.press({ name: "up" });
    expect(app.input).toEqual(after);
    expect(term.display.col).toBeLessThan(term.cols);
    term.press({ name: "escape" });
    expect(app.input.text).toBe(draft);
    term.press({ name: "q", ctrl: true });
    await until(() => app.questions.answering());
    expect(app.input.text).toBe(answer);
    expect(app.page!.sent).toEqual([]);
  } finally { app.quit(); await running; }
});

test("App retains an interior source offset across widening/narrowing and resets it on new wheel intent", async () => {
  const term = fakeTerm(23, 24);
  const orchs = fakeOrchestrators();
  const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
  const running = app.run("source-anchor-e");
  try {
    await until(() => !!app.page);
    const code = "code-" + "0123456789".repeat(40);
    const lines: Line[] = [
      { md: ["long first line ".repeat(30), "short", "```ts", "tiny", code, "last", "```"].join("\n") },
      ...Array.from({ length: 30 }, (_, i) => ({ md: `later ${i} ` + "wrapped content ".repeat(20) })),
    ];
    const codeStart = () => historyRows(lines, 23).findIndex(row => Bun.stripANSI(row).startsWith("│ code-"));
    while ((codeStart() + 3) % 3) lines.unshift("fixed preface");
    const top = codeStart() + 3; // offset 63 within this source line
    const reading = "│ " + code.slice(63, 84);
    expect(Bun.stripANSI(historyRows(lines, 23)[top]!)).toBe(reading);
    app.page!.lines.push(...lines);
    app.reprint();
    await until(() => term.screen().includes("wrapped content"));
    for (let i = 0; i < 300; i++) term.press({ name: "pageup" });
    await until(() => bodyRows(term)[0] === Bun.stripANSI(historyRows(lines, 23)[0]!));
    for (let i = 0; i < top / 3; i++) term.press({ name: "wheeldown" });
    await until(() => bodyRows(term)[0] === reading);
    for (const cols of [80, 40, 23, 10, 80, 23]) {
      term.resize(cols, 24);
      await Bun.sleep(170);
      const offset = Math.floor(63 / (cols - 2)) * (cols - 2);
      expect(bodyRows(term)[0]).toBe("│ " + code.slice(offset, offset + cols - 2));
      const visible = bodyRows(term);
      orchs.writers[app.page!.project]!("new structured background output " + "words ".repeat(20) + "\n");
      await Bun.sleep(25);
      expect(bodyRows(term)).toEqual(visible);
    }
    term.press({ name: "wheeldown" }); // a new reading intent: offset 126, not 63
    await until(() => bodyRows(term)[0] === "│ " + code.slice(126, 147));
    for (const cols of [80, 23]) {
      term.resize(cols, 24);
      await Bun.sleep(170);
      const offset = Math.floor(126 / (cols - 2)) * (cols - 2);
      expect(bodyRows(term)[0]).toBe("│ " + code.slice(offset, offset + cols - 2));
    }
  } finally { app.quit(); await running; }
});

test("combined E viewport cancels actual tools, keeps full pre-checkpoint live/exit history and no revived activity", async () => {
  const project = "combined-cancel-e", path = paths.transcript(project, "orchestrator");
  mkdirSync(paths.repo(project), { recursive: true });
  const t = openTranscript(path);
  await t.append({ type: "meta", role: "orchestrator", model: "m" });
  await t.append({ type: "message", message: { role: "user", content: "FULL-HISTORY-SENTINEL" } });
  for (let i = 0; i < 105; i++) await t.append({ type: "message", message: { role: "assistant", content: `durable record ${i}: ` + "wrapping words ".repeat(5) } });
  await t.append({ type: "summary", text: "compressed model-only summary", retained: [], boundary: t.head() });
  const marker = join(home, "combined-bash-ready");
  const provider = fakeProvider([
    [toolUse("cancel-real", "bash", { command: `echo started > '${marker}'; sleep 60` }), toolUse("never", "bash", { command: "echo NEVER-EXECUTED" })],
    [said("authorized continuation")],
  ]);
  const { bash } = await import("../core/tools/bash/bash");
  const { paired } = await import("../core/data/transcripts/tool-pairs");
  const term = fakeTerm(100, 24);
  // The header's fin cruises on App's clock while the page is busy and parks (tick 0) once idle; the header rows compared
  // below span its body, so freeze the clock at 0 to put the cruising fin where the parked one sits. Timers stay real.
  const clock: Clock = { now: () => 0, every: (fn, ms) => { const t = setInterval(fn, ms); return () => clearInterval(t); } };
  const app = new App({ term, clock, pollMs: 100_000, watchdog: async () => {}, merges: async () => {},
    openOrchestrator: async (project, _url, write, onInbox, events) => createOrchestrator({ project, transcript: t, provider, tools: { bash }, write, onInbox, ...events }),
  });
  const running = app.run(project);
  try {
    await until(() => !!app.page);
    expect(app.page!.lines.map(raw).join("\n")).toContain("FULL-HISTORY-SENTINEL"); // live history is complete, not just exit output
    // Page data can precede the throttled first frame; never capture "opening…" as the header.
    await until(() => term.display.screen()[0]!.includes(">[combined-cancel-e]"));
    term.type("start cancellable tool\r");
    await until(() => existsSync(marker));
    expect(app.page!.calls.size).toBe(1);
    term.type("draft 界é👩‍💻");
    const draft = { ...app.input };
    const header = term.display.buf.slice(term.display.top, term.display.top + 4).map(row => row.join(""));
    term.press({ name: "pageup" });
    term.resize(23, 24);
    await Bun.sleep(160);
    term.resize(100, 24);
    await Bun.sleep(160);
    expect(app.input).toEqual(draft);
    term.type("\x03");
    await until(() => !app.page!.busy);
    expect(app.page!.calls.size).toBe(0);
    expect(app.frame().activity).toBeUndefined();
    expect(app.frame().running).toEqual([]);
    expect(app.input).toEqual(draft);
    expect(paired(await t.chain())).toBe(true);
    expect(provider.calls).toHaveLength(1);
    expect(await app.page!.orch.pending()).toBe(false);
    // Context/review telemetry can change during the cancelled turn; identity stays pinned.
    expect(term.display.buf.slice(term.display.top, term.display.top + 4).map(row => row.join("")).filter((_, i) => i !== 1)).toEqual(header.filter((_, i) => i !== 1));
    term.press({ name: "escape" }); // only intentional draft clearing for this continuation
    term.type("resume saved turn\r");
    await until(() => provider.calls.length === 2 && !app.page!.busy);
    expect(JSON.stringify(provider.calls[1]!.messages)).toContain("cancelled by user");
    expect(JSON.stringify(provider.calls[1]!.messages)).toContain("resume saved turn");
    expect(app.page!.calls.size).toBe(0);
  } finally { app.quit(); await running; }
  const exit = term.screen();
  expect(exit).toContain("FULL-HISTORY-SENTINEL");
  expect(exit).toContain("durable record 104");
  expect(exit).toContain("authorized continuation");
  expect(exit).not.toContain("compressed model-only summary");
  expect(exit).not.toMatch(/thinking…|working…|messages queued|agents running/);
  expect(term.display.modes.get(1049)).toBe(false);
});

test("ctrl+c through pinned question/modal layers preserves owners and drafts without resuming the cancelled request", async () => {
  const project = "cancel-question-e";
  let requested = false, aborted = false;
  const provider: import("../providers").Provider = { name: "anthropic", async models() { return []; }, async complete(req) {
    requested = true;
    return new Promise((_resolve, reject) => req.signal!.addEventListener("abort", () => { aborted = true; reject(req.signal!.reason); }, { once: true }));
  } };
  const term = fakeTerm(80, 24);
  const app = new App({ term, pollMs: 20, questionDelayMs: 0, watchdog: async () => {}, merges: async () => {},
    openOrchestrator: async (project, _url, write, onInbox, events) => createOrchestrator({ project, provider, tools: {}, write, onInbox, ...events }),
  });
  const running = app.run(project);
  try {
    await until(() => !!app.page);
    const owner = app.page!;
    term.type("start request\r");
    await until(() => requested);
    term.type("chat draft 界");
    const chat = { ...app.input };
    await askQuestions(project, [{ text: "Keep this question?" }]);
    await until(() => owner.questions.open.length === 1);
    term.press({ name: "q", ctrl: true });
    await until(() => app.questions.answering());
    term.type("answer draft 👩‍💻");
    const answer = { ...app.input };
    term.press({ name: "c", ctrl: true });
    await until(() => aborted && !owner.busy);
    expect(app.page).toBe(owner);
    expect(app.questions.answering()).toBe(true);
    expect(app.input).toEqual(answer);
    expect(owner.questions.open).toHaveLength(1);
    expect(await owner.orch.pending()).toBe(false);
    term.press({ name: "escape" });
    expect(app.input).toEqual(chat);
    term.press({ name: "q", ctrl: true });
    await until(() => app.questions.answering());
    expect(app.input).toEqual(answer);
    // A project modal hides, but must not steal, the question's answer buffer.
    term.press({ name: "b", ctrl: true });
    await until(() => !!app.projectList);
    expect(app.input).toEqual(answer);
    term.press({ name: "escape" });
    expect(app.input).toEqual(answer);
    expect(app.questions.answering()).toBe(true);
    expect(app.frame().activity).toBeUndefined();
  } finally { app.quit(); await running; }
});

describe("explicit footer help", () => {
  test("modal keys preserve draft/cursor/history, navigation reaches diagnostics, and esc never leaves an agent view", async () => {
    const term = fakeTerm(80, 24);
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("help-draft");
    try {
      await until(() => !!app.page);
      const page = app.page!;
      const draft = { text: "kept\nchat 界 draft", cursor: 6 };
      app.input = { ...draft };
      const history = [...page.inputHistory];
      let left = 0;
      page.view = { name: "worker-help", lines: [], leave: () => { left++; }, live: true, calls: new Calls() };
      await app.commands.get("/help")!.run("", page);
      await until(() => term.screen().includes("help"));
      expect(app.frame().help!.lines.join("\n")).toContain("/back");
      for (const key of [{ name: "enter" }, { name: "char", text: "1" }, { name: "paste", text: "not inserted" }, { name: "backspace" }, { name: "tab" }]) await app.onKey(key);
      expect(app.input).toEqual(draft);
      expect(page.inputHistory).toEqual(history);
      expect(orchs.said[page.project]).toEqual([]);
      await app.onKey({ name: "pagedown" });
      expect(app.frame().help!.top).toBeGreaterThan(0);
      await app.onKey({ name: "end" });
      await until(() => term.screen().includes("/review-rounds"));
      await app.onKey({ name: "home" });
      expect(app.frame().help!.top).toBe(0);
      await app.onKey({ name: "wheeldown" });
      expect(app.frame().help!.top).toBe(3);
      await app.onKey({ name: "wheelup" });
      expect(app.frame().help!.top).toBe(0);
      await app.onKey({ name: "escape" });
      expect(app.frame().help).toBeNull();
      expect(left).toBe(0);
      expect(app.input).toEqual(draft);
      expect(page.view.lines).toEqual([]);
      await app.commands.get("/help")!.run("", page);
      await app.commands.get("/help")!.run("", page);
      expect(app.frame().help).toBeNull();
      expect(app.input).toEqual(draft);
      await app.onKey({ name: "escape" });
      expect(left).toBe(1);
    } finally { app.quit(); await running; }
  });

  test("/help submission, help scrolling and resize retain the conversation's interior source anchor amid live output", async () => {
    const term = fakeTerm(23, 24);
    const orchs = fakeOrchestrators();
    const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
    const running = app.run("help-anchor");
    try {
      await until(() => !!app.page);
      const code = "code-" + "0123456789".repeat(40);
      const lines: Line[] = [{ md: "```ts\n" + code + "\n```" }, ...Array.from({ length: 100 }, (_, i) => `later ${i}`)];
      const codeStart = () => historyRows(lines, 23).findIndex(row => Bun.stripANSI(row).startsWith("│ code-"));
      while ((codeStart() + 3) % 3) lines.unshift("preface");
      app.page!.lines.push(...lines);
      app.reprint();
      await until(() => term.screen().includes("later 99"));
      for (let i = 0; i < 100; i++) term.press({ name: "pageup" });
      for (let i = 0; i < (codeStart() + 3) / 3; i++) term.press({ name: "wheeldown" });
      const reading = "│ " + code.slice(63, 84);
      await until(() => bodyRows(term)[0] === reading);
      term.type("/help\r"); // Must not use Enter's normal jump-to-tail path.
      await until(() => term.screen().includes("help"));
      expect(bodyRows(term)[0]).toBe(reading);
      term.press({ name: "wheeldown" });
      term.press({ name: "pagedown" });
      for (const cols of [80, 40, 23, 10, 80, 23]) {
        term.resize(cols, 24);
        await Bun.sleep(170);
        const offset = Math.floor(63 / (cols - 2)) * (cols - 2);
        expect(bodyRows(term)[0]).toBe("│ " + code.slice(offset, offset + cols - 2));
        orchs.writers[app.page!.project]!("live output while reading help\n");
        await Bun.sleep(25);
        expect(bodyRows(term)[0]).toBe("│ " + code.slice(offset, offset + cols - 2));
        expect(app.frame().help).not.toBeNull();
      }
      term.press({ name: "escape" });
      await until(() => !app.frame().help);
      expect(bodyRows(term)[0]).toBe(reading);
      expect(app.page!.lines.map(raw).join("\n")).not.toContain("/help");
    } finally { app.quit(); await running; }
  });

  test("page/menu/project transitions close help, and a hidden tiny-terminal panel still owns keys", async () => {
    const term = fakeTerm(80, 24);
    const app = new App({ term, openOrchestrator: fakeOrchestrators().openOrchestrator, pollMs: 100_000 });
    const running = app.run("help-transition-a");
    const help = () => app.commands.get("/help")!.run("", app.page);
    try {
      await until(() => !!app.page);
      await app.openPage("help-transition-b");
      const draft = { text: "draft unchanged", cursor: 3 };
      app.input = { ...draft };
      await help();
      await app.onKey({ name: "z", ctrl: true });
      expect(app.frame().help).toBeNull();
      expect(app.input).toEqual({ text: "", cursor: 0 }); // the other project's own draft
      await app.onKey({ name: "x", ctrl: true });
      expect(app.input).toEqual(draft);
      await help();
      app.openMenu("example menu", [{ value: "one", label: "one" }], () => {});
      expect(app.frame().help).toBeNull();
      await app.onKey({ name: "escape" });
      await help();
      await app.onKey({ name: "b", ctrl: true });
      expect(app.projectList).not.toBeNull();
      expect(app.frame().help).toBeNull();
      await app.onKey({ name: "escape" });
      await help();
      term.resize(1, 1);
      await Bun.sleep(170);
      expect(app.frame().help).not.toBeNull();
      await app.onKey({ name: "enter" });
      await app.onKey({ name: "char", text: "x" });
      await app.onKey({ name: "pagedown" });
      expect(app.input).toEqual(draft);
      await app.onKey({ name: "escape" });
      expect(app.frame().help).toBeNull();
      expect(app.input).toEqual(draft);
      term.resize(80, 24);
      await Bun.sleep(170);
      expect(app.frame().help).toBeNull();
      await help();
      app.closePage();
      expect(app.frame().help).toBeNull();
    } finally { app.quit(); await running; }
  });

  test("question arrivals stay opt-in; help never answers/skips and preserves original chat and answer through external close", async () => {
    const project = "help-questions";
    const term = fakeTerm(80, 24);
    let cancelled = 0;
    const orchs = fakeOrchestrators();
    const app = new App({ term, pollMs: 20, watchdog: async () => {}, merges: async () => {}, questionDelayMs: 0,
      openOrchestrator: async (p, url, write, inbox) => ({ ...await orchs.openOrchestrator(p, url, write, inbox), cancel: () => { cancelled++; } }),
    });
    const running = app.run(project);
    const help = () => app.commands.get("/help")!.run("", app.page);
    try {
      await until(() => !!app.page);
      const chat = { text: "original chat", cursor: 4 };
      app.input = { ...chat };
      await help();
      const [q] = await askQuestions(project, [{ text: "Question one?" }]);
      await until(() => app.page!.questions.open.length === 1);
      expect(app.frame().question).toBeNull();
      expect(app.input).toEqual(chat);
      expect(app.frame().help).not.toBeNull();
      await app.onKey({ name: "enter" });
      await app.onKey({ name: "escape" });
      expect(app.frame().question).toBeNull();
      expect(app.input).toEqual(chat);
      await help();
      await app.onKey({ name: "q", ctrl: true }); // Explicit opening replaces help.
      expect(app.frame().help).toBeNull();
      expect(app.questions.answering()).toBe(true);
      const answer = { text: "answer draft", cursor: 5 };
      app.input = { ...answer };
      await help();
      await app.onKey({ name: "enter" });
      await app.onKey({ name: "char", text: "1" });
      await app.onKey({ name: "c", ctrl: true }); // Cancellation still goes to the owner, not help.
      expect(cancelled).toBe(1);
      expect(app.frame().help).not.toBeNull();
      expect(app.input).toEqual(answer);
      expect((await allQuestions(project))[0]!.status).toBe("open");
      await app.onKey({ name: "escape" }); // Only help closes; answer is untouched.
      expect(app.questions.answering()).toBe(true);
      expect(app.input).toEqual(answer);
      await help();
      await askQuestions(project, [{ text: "Question two?" }]);
      await answerQuestion(project, q!.id, "answered elsewhere");
      await until(() => app.page!.questions.open.length === 1 && app.page!.questions.open[0]!.text === "Question two?");
      expect(app.input).toEqual(chat);
      expect(app.frame().help).not.toBeNull();
      expect(app.frame().question).toBeNull();
      expect(app.page!.lines.map(raw).join("\n")).toContain("answer draft");
      await app.onKey({ name: "escape" });
      await app.onKey({ name: "q", ctrl: true });
      expect(app.input.text).toBe(""); // Orphan answer never attaches to the next question.
      await app.onKey({ name: "escape" });
      expect(app.input).toEqual(chat);
    } finally { app.quit(); await running; }
  });

  test("help works before a page exists, never enters durable/exit history, and does not reopen after restart", async () => {
    const project = "help-durable";
    const path = paths.transcript(project, "orchestrator");
    mkdirSync(paths.repo(project), { recursive: true });
    const transcript = openTranscript(path);
    await transcript.append({ type: "meta", role: "orchestrator", model: "m" });
    await transcript.append({ type: "message", message: { role: "user", content: "DURABLE-HELP-SENTINEL" } });
    for (let i = 0; i < 80; i++) await transcript.append({ type: "message", message: { role: "assistant", content: `record ${i} ` + "old history ".repeat(10) } });
    await transcript.append({ type: "summary", text: "model-only summary", retained: [], boundary: transcript.head() });
    const saved = await Bun.file(path).text();
    let ready!: () => void;
    const waiting = new Promise<void>(resolve => { ready = resolve; });
    const orchs = fakeOrchestrators();
    const open: ConstructorParameters<typeof App>[0]["openOrchestrator"] = async (p, url, write, inbox) => { await waiting; return { ...await orchs.openOrchestrator(p, url, write, inbox), entries: () => transcript.history!() }; };
    const term = fakeTerm(80, 24);
    const app = new App({ term, openOrchestrator: open, pollMs: 100_000 });
    const running = app.run(project);
    try {
      term.type("/help\r");
      await until(() => term.screen().includes("help"));
      expect(app.pages).toHaveLength(0);
      expect(app.frame().help).not.toBeNull();
      term.press({ name: "escape" });
      ready();
      await until(() => !!app.page);
      expect(app.frame().help).toBeNull();
      const before = [...app.page!.lines];
      term.type("/help\r");
      await until(() => term.screen().includes("help"));
      expect(app.page!.lines).toEqual(before);
      expect(app.page!.inputHistory).toEqual(["/help"]);
      await app.page!.savingHistory;
    } finally { ready(); app.quit(); await running; }
    expect(term.screen()).toContain("DURABLE-HELP-SENTINEL");
    expect(term.screen()).not.toContain("advanced & diagnostics");
    // A visible repository path may contain /help-durable; the command itself
    // must never be printed as a conversation entry.
    expect(term.screen()).not.toMatch(/^\s*>?\s*\/help\s*$/m);
    expect(await Bun.file(path).text()).toBe(saved);
    const again = new App({ term: fakeTerm(80, 24), openOrchestrator: open, pollMs: 100_000 });
    const restarted = again.run(project);
    try {
      await until(() => !!again.page);
      expect(again.frame().help).toBeNull();
      expect(again.page!.lines.map(raw).join("\n")).not.toContain("/help");
      await again.onKey({ name: "up" });
      expect(again.input.text).toBe("/help");
    } finally { again.quit(); await restarted; }
  });
});

describe("queued input footer", () => {
  test("several submissions stay above input until each consumption, never inserting drafts or double-echoing identical prompts", async () => {
    const term = fakeTerm(100, 24);
    let inbox!: (msgs: Message[]) => void, finish!: () => void;
    const app = new App({ term, pollMs: 100_000, openOrchestrator: async (_p, _u, _w, read) => {
      inbox = read!;
      return { async say() {}, async pending() { return false; }, turn: () => new Promise(resolve => { finish = () => resolve([]); }) };
    } });
    const running = app.run("queued-order");
    try {
      await until(() => !!app.page);
      term.type("first\r");
      await until(() => !!finish);
      term.type("\x1b[200~second\nline 界é👩‍💻\x1b[201~\rfirst\r");
      const texts = ["first", "second\nline 界é👩‍💻", "first"];
      await until(() => app.frame().queued?.texts.length === 3);
      term.type("\x1b[200~unsent\ndraft\x1b[201~");
      term.press({ name: "left" });
      const draft = { ...app.input };
      await until(() => term.screen().includes("queued 3/3"));
      const rows = term.display.screen();
      const heading = rows.findIndex(row => row.startsWith("queued"));
      expect(rows[heading - 1]).toBe("");
      expect(term.display.backgrounds()[heading - 1]!.some(Boolean)).toBe(false);
      expect(rows.slice(heading, heading + 5)).toEqual([
        "queued 3/3 · orchestrator · queued-order", "  1. first", "  2. second ↵ line 界é👩‍💻", "  3. first", "┌" + "─".repeat(98) + "┐",
      ]);
      expect(app.page!.lines).toEqual([]);
      expect(app.frame().queued?.texts).toEqual(texts);
      for (let i = 0; i < texts.length; i++) {
        inbox([{ from: "user", ...app.page!.sent[0]!, ts: "synthetic" }]);
        expect(app.page!.busy).toBe(true); // not turn completion, a real consumption boundary
        expect(app.frame().queued?.texts).toEqual(texts.slice(i + 1));
        expect(app.page!.lines).toEqual(texts.slice(0, i + 1).flatMap(userLines));
        expect(app.input).toEqual(draft);
      }
      inbox([{ from: "user", text: "external user", ts: "synthetic" }]);
      expect(app.page!.lines).toEqual([...texts, "external user"].flatMap(userLines));
      finish();
      await until(() => !/queued \d+\/\d+/.test(term.screen()));
      expect(app.input).toEqual(draft);
    } finally { finish?.(); app.quit(); await running; }
    expect(term.screen()).not.toMatch(/queued \d+\/\d+/); // no footer previews in exit transcript
    expect(term.screen().split("> first")).toHaveLength(3);
  });

  test("project, answer and agent-view drafts stay independent from pending orchestrator previews through switches and resizes", async () => {
    const term = fakeTerm(90, 24), reads = new Map<string, (msgs: Message[]) => void>();
    const app = new App({ term, pollMs: 100_000, questionDelayMs: 0, openOrchestrator: async (project, _u, _w, inbox) => {
      reads.set(project, inbox!);
      return { async say() {}, async pending() { return false; }, async turn() { return []; } };
    } });
    const running = app.run("queued-project-a");
    try {
      await until(() => !!app.page);
      term.type("pending A\r");
      await until(() => app.frame().queued?.texts.length === 1);
      const a = app.page!, chat = { text: "chat A\n界 draft", cursor: 8 };
      app.input = { ...chat }; app.draw();
      await askQuestions(a.project, [{ text: "Synthetic question?" }]);
      await app.onKey({ name: "q", ctrl: true });
      app.input = { text: "answer draft 👩‍💻", cursor: 7 }; app.draw();
      const answer = { ...app.input };
      expect(app.questions.answering()).toBe(true);
      expect(app.frame().queued?.texts).toEqual(["pending A"]);
      await app.onKey({ name: "b", ctrl: true });
      expect(app.projectList).not.toBeNull();
      await app.onKey({ name: "escape" });
      expect(app.input).toEqual(answer);
      await app.openPage("queued-project-b");
      term.type("pending B\r");
      await until(() => app.frame().queued?.texts.length === 1);
      const b = app.page!, chatB = { text: "draft B", cursor: 3 };
      app.input = { ...chatB }; app.draw();
      expect(app.frame().queued?.texts).toEqual(["pending B"]);
      app.switchPage(-1);
      expect(app.page).toBe(a);
      expect(app.input).toEqual(chat); // project switches close Inbox, not its drafts
      await app.onKey({ name: "q", ctrl: true });
      expect(app.input).toEqual(answer);
      for (const [cols, rows] of [[12, 8], [23, 16], [90, 24]]) {
        term.resize(cols!, rows!);
        await Bun.sleep(160);
        expect(app.input).toEqual(answer);
        expect(app.frame().queued?.texts).toEqual(["pending A"]);
      }
      await app.onKey({ name: "q", ctrl: true });
      expect(app.input).toEqual(chat);
      a.view = { name: "worker-synthetic", lines: [], live: true, calls: new Calls(), leave() {} };
      a.name = "Renamed display"; // identity remains the original project id
      app.draw();
      await until(() => term.screen().includes("queued 1/1 · orchestrator · Renamed display"));
      expect(app.frame().queued?.texts).toEqual(["pending A"]);
      reads.get(a.project)!([{ from: "user", ...a.sent[0]!, ts: "synthetic" }]);
      expect(a.view.lines).toEqual([]);
      expect(a.lines).toEqual(userLines("pending A"));
      expect(app.input).toEqual(chat);
      expect(a.project).toBe("queued-project-a");
      app.switchPage(1);
      expect(app.page).toBe(b);
      expect(app.input).toEqual(chatB);
      expect(app.frame().queued?.texts).toEqual(["pending B"]);
    } finally { app.quit(); await running; }
  });

  test("real inbox consumption during a tool turn removes only consumed previews and inserts each user exactly once", async () => {
    const term = fakeTerm(90, 24), project = "queued-real-turn";
    let release!: () => void, started = false, response!: () => void;
    let afterExternal: readonly string[] | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const responseGate = new Promise<void>(resolve => { response = resolve; });
    const scripted = fakeProvider([[toolUse("wait-1", "wait", {})], [said("finished")]]);
    let requests = 0;
    const provider = { ...scripted, async complete(req: Parameters<typeof scripted.complete>[0]) {
      if (++requests === 2) await responseGate;
      return scripted.complete(req);
    } };
    const app = new App({ term, pollMs: 100_000, openOrchestrator: async (project, _url, write, onInbox, events) => createOrchestrator({ project, provider, write, ...events,
      onInbox: messages => {
        for (const msg of messages) {
          onInbox?.([msg]);
          if (msg.text === "next one" && !msg.inputId) afterExternal = app.frame().queued?.texts;
        }
      },
      tools: { wait: { spec: { name: "wait", description: "Synthetic gate", input_schema: { type: "object" } }, async run() { started = true; await gate; return "ok"; } } },
    }) });
    const running = app.run(project);
    try {
      await until(() => !!app.page);
      term.type("start\r");
      await until(() => started);
      await put(project, "orchestrator", { from: "user", text: "next one" }); // external, identical to a local prompt
      // Preview visibility means submitted, not persisted. Await both sends before
      // releasing the tool so this boundary is guaranteed to consume both inputs.
      for (const key of parseKeys("next one\rnext two\r")) await app.onKey(key);
      await until(() => app.frame().queued?.texts.length === 2);
      await until(() => term.screen().includes("  2. next two"));
      expect(app.page!.lines.filter((line): boolean => typeof line === "object" && "user" in line)).toEqual(userLines("start"));
      release();
      await until(() => requests === 2);
      expect(app.page!.busy).toBe(true);
      expect(app.frame().queued?.texts).toEqual([]);
      expect(afterExternal).toEqual(["next one", "next two"]); // external consumption must not acknowledge identical local text
      expect(app.page!.lines.filter((line): boolean => typeof line === "object" && "user" in line)).toEqual(["start", "next one", "next one", "next two"].flatMap(userLines));
      response();
      await until(() => !app.page!.busy);
      const transcript = await openTranscript(paths.transcript(project, "orchestrator")).chain();
      for (const text of ["start", "next one", "next two"]) expect(JSON.stringify(transcript).split(`[user] ${text}`)).toHaveLength(text === "next one" ? 3 : 2);
    } finally { release(); response(); app.quit(); await running; }
  });

  test("login transfer retains previews and FIFO even for submissions made during a delayed send", async () => {
    const term = fakeTerm(100, 24), attempted: string[] = [];
    let signedIn!: () => void, persisted!: () => void, read!: (msgs: Message[]) => void;
    const loginGate = new Promise<void>(resolve => { signedIn = resolve; });
    const writeGate = new Promise<void>(resolve => { persisted = resolve; });
    const app = new App({ term, pollMs: 100_000, login: async () => { await loginGate; return "signed in"; }, openOrchestrator: async (_p, _u, _w, inbox) => {
      read = inbox!;
      return { async say(text) { attempted.push(text); if (text === "one") await writeGate; }, async pending() { return false; }, async turn() { return []; } };
    } });
    const running = app.run("queued-login-transfer");
    try {
      await until(() => !!app.page);
      term.type("/login claude\r");
      await until(() => app.loggingIn);
      term.type("one\rtwo\r");
      await until(() => app.frame().queued?.texts.length === 2);
      expect(app.frame().queued?.texts).toEqual(["one", "two"]);
      signedIn();
      await until(() => attempted.length === 1);
      expect(app.loggingIn).toBe(false);
      expect(app.frame().queued?.texts).toEqual(["one", "two"]);
      term.type("three\r");
      await until(() => app.frame().queued?.texts.length === 3);
      expect(attempted).toEqual(["one"]);
      expect(app.frame().queued?.texts).toEqual(["one", "two", "three"]);
      persisted();
      await until(() => attempted.length === 3);
      expect(attempted).toEqual(["one", "two", "three"]);
      expect(app.frame().queued?.texts).toEqual(attempted); // successful persistence alone is not consumption
      read(app.page!.sent.map(item => ({ from: "user", ...item, ts: "synthetic" })));
      expect(app.frame().queued?.texts).toEqual([]);
      expect(app.page!.lines.filter((line): boolean => typeof line === "object" && "user" in line)).toEqual(attempted.flatMap(userLines));
    } finally { signedIn(); persisted(); app.quit(); await running; }
  });
});

for (const boundary of ["cancel", "error"] as const) test(`queued footer survives a real ${boundary} boundary without acknowledging pending input`, async () => {
  const term = fakeTerm(100, 24), project = `queued-boundary-${boundary}`;
  let reject!: (error: Error) => void, calls = 0;
  const scripted = fakeProvider([[said("resumed")]]);
  const provider = { ...scripted, async complete(req: Parameters<typeof scripted.complete>[0]) {
    if (++calls !== 1) return scripted.complete(req);
    return new Promise<Awaited<ReturnType<typeof scripted.complete>>>((_resolve, fail) => {
      reject = fail;
      req.signal!.addEventListener("abort", () => fail(req.signal!.reason), { once: true });
    });
  } };
  const app = new App({ term, pollMs: 100_000, openOrchestrator: async (project, _u, write, onInbox) => createOrchestrator({ project, provider, tools: {}, write, onInbox }) });
  const running = app.run(project);
  try {
    await until(() => !!app.page);
    term.type("consumed before boundary\r");
    await until(() => !!reject);
    term.type("still pending");
    await app.onKey({ name: "enter" }); // wait for persistence before failing the active request
    await until(() => app.frame().queued?.texts.length === 1);
    term.type("draft stays");
    const draft = { ...app.input };
    if (boundary === "cancel") await app.onKey({ name: "c", ctrl: true });
    else reject(new Error("synthetic request failure"));
    await until(() => !app.page!.busy && term.screen().includes("  1. still pending"));
    expect(calls).toBe(1);
    expect(app.frame().queued?.texts).toEqual(["still pending"]);
    expect(app.input).toEqual(draft);
    expect(app.page!.lines.filter((line): boolean => typeof line === "object" && "user" in line)).toEqual(userLines("consumed before boundary"));
    await app.onKey({ name: "escape" }); // explicit clearing of this fixture's draft only
    term.type("resume now\r");
    await until(() => calls === 2 && !app.page!.busy);
    expect(app.frame().queued?.texts).toEqual([]);
    expect(app.page!.lines.filter((line): boolean => typeof line === "object" && "user" in line)).toEqual(["consumed before boundary", "still pending", "resume now"].flatMap(userLines));
    const transcript = JSON.stringify(await openTranscript(paths.transcript(project, "orchestrator")).chain());
    for (const text of ["consumed before boundary", "still pending", "resume now"]) expect(transcript.split(`[user] ${text}`)).toHaveLength(2);
  } finally { reject?.(new Error("test cleanup")); app.quit(); await running; }
});

test("queued footer removal preserves a scrolled source anchor and enter still follows the tail, without changing terminal input modes", async () => {
  const term = fakeTerm(100, 24);
  let read!: (msgs: Message[]) => void;
  const app = new App({ term, pollMs: 100_000, openOrchestrator: async (_p, _u, _w, inbox) => {
    read = inbox!;
    return { async say() {}, async pending() { return false; }, async turn() { return []; } };
  } });
  const running = app.run("queued-scroll");
  const conversation = () => {
    const rows = term.display.screen();
    const at = rows.findIndex(row => row.startsWith("queued") || row.startsWith("┌"));
    expect(at).toBeGreaterThan(bodyStart(term));
    expect(rows[at - 1]).toBe("");
    expect(term.display.backgrounds()[term.display.top + at - 1]!.some(Boolean)).toBe(false);
    return rows.slice(bodyStart(term), at - 1);
  };
  try {
    await until(() => !!app.page);
    for (let i = 0; i < 80; i++) app.say(`history ${i}`);
    await until(() => term.screen().includes("history 79"));
    const bodyHeight = conversation().length;
    const saved = historyRows(app.page!.lines, term.cols).map(row => Bun.stripANSI(row).trimEnd());
    expect(conversation()).toEqual(saved.slice(-bodyHeight));
    term.press({ name: "pageup" });
    await until(() => !term.screen().includes("history 79"));
    // Page Up overlaps exactly one CONTENT row; the fixed gap is not scrollable.
    const start = saved.length - bodyHeight - (bodyHeight - 1);
    expect(conversation()).toEqual(saved.slice(start, start + bodyHeight));
    const top = bodyStart(term), before = term.writes.length;
    term.type("queue one\rqueue two\r");
    await until(() => term.screen().includes("queued 2/2"));
    expect(conversation().at(-1)).toBe("history 79"); // existing Enter contract: follow the tail
    term.press({ name: "pageup" });
    await until(() => !term.screen().includes("history 79"));
    const anchor = term.display.screen()[top];
    term.type("kept draft");
    const draft = { ...app.input };
    read([{ from: "user", ...app.page!.sent[0]!, ts: "synthetic" }]);
    await until(() => term.screen().includes("queued 1/1"));
    expect(term.display.screen()[top]).toBe(anchor);
    conversation(); // Shrinking the queue keeps the gap above the entire footer.
    term.type("\x1b[<65;10;8M".repeat(100)); // injected SGR, not a physical gesture
    await until(() => term.screen().includes("> queue one"));
    read([{ from: "user", ...app.page!.sent[0]!, ts: "synthetic" }]);
    await until(() => term.screen().includes("> queue two") && !/queued \d+\/\d+/.test(term.screen()));
    expect(conversation().at(-1)).toBe("> queue two");
    expect(app.input).toEqual(draft);
    expect(term.display.top).toBe(0);
    expect(term.writes.slice(before).join("")).not.toMatch(/\x1b\[\?(1049|1000|1006|2004)[hl]/);
  } finally { app.quit(); await running; }
});

test("a failed write removes that submission, not a later identical pending prompt", async () => {
  const term = fakeTerm(100, 24);
  let fail!: (error: Error) => void, attempts = 0;
  const app = new App({ term, pollMs: 100_000, openOrchestrator: async () => ({
    async say() { if (++attempts === 1) await new Promise<void>((_resolve, reject) => { fail = reject; }); },
    async pending() { return false; }, async turn() { return []; },
  }) });
  const running = app.run("queued-identical-failure");
  try {
    await until(() => !!app.page);
    term.type("same\rmiddle\rsame\r");
    await until(() => attempts === 3);
    const original = [...app.page!.sent];
    expect(new Set(original.map(item => item.inputId)).size).toBe(3);
    fail(new Error("synthetic write failure"));
    await until(() => app.page!.sent.length === 2);
    expect(app.page!.sent).toEqual(original.slice(1));
    expect(app.frame().queued?.texts).toEqual(["middle", "same"]);
    expect(app.page!.lines.map(raw).map(strip)).toContain("not sent: same");
    expect(app.page!.lines.some(line => typeof line === "object" && "user" in line)).toBe(false);
  } finally { fail?.(new Error("cleanup")); app.quit(); await running; }
});

test("raw SGR/X10 input through realTerminal only scrolls the body: draft, queue and pinned bars survive", async () => {
  const display = new FakeScreen(80, 24), writes: string[] = [];
  let input: ((chunk: Uint8Array) => void) | undefined;
  const stdin = { isTTY: true, setRawMode() {}, on(_e: string, fn: typeof input) { input = fn; }, off() { input = undefined; }, resume() {}, pause() {} };
  const stdout = { isTTY: true, columns: 80, rows: 24, on() {}, write(s: string) { writes.push(s); display.write(s); return true; } };
  const proc = { on() {}, off() {}, exit() {}, stderr: { write() {} } };
  const term = realTerminal(stdin as never, stdout as never, proc, NO_REPLY_WINDOW);
  const app = new App({ term, pollMs: 100_000, watchdog: async () => {}, merges: async () => {}, projectModel: async () => "synthetic",
    openOrchestrator: async () => ({ async say() { throw new Error("input must not submit"); }, async pending() { return false; }, async turn() { return []; } }),
  });
  const running = app.run("raw-wheel");
  try {
    await until(() => !!app.page);
    const page = app.page!;
    page.lines.push(...Array.from({ length: 100 }, (_, i) => `RAW-RECORD-${i}`));
    page.sent.push({ inputId: "synthetic-1", text: "queued first" }, { inputId: "synthetic-2", text: "queued second\nline" });
    app.reprint();
    const text = Buffer.from("\x1b[200~draft 界é👩‍💻\nsecond line\x1b[201~\x1b[D");
    for (const byte of text) input!(Uint8Array.of(byte));
    const draft = { ...app.input }, queue = JSON.stringify(page.sent);
    expect(draft.text).toBe("draft 界é👩‍💻\nsecond line");
    await until(() => display.text().includes("queued 2/2"));
    const initial = display.screen(), start = initial.findIndex(row => /^─+$/.test(row)) + 1;
    const footerAt = initial.findIndex(row => row.startsWith("queued"));
    const pinned = () => {
      expect(display.screen().slice(0, start)).toEqual(initial.slice(0, start));
      expect(display.screen().slice(footerAt)).toEqual(initial.slice(footerAt));
      expect(app.input).toEqual(draft);
      expect(JSON.stringify(page.sent)).toBe(queue);
    };
    const up = Buffer.from("\x1b[<64;10;10M"), down = Buffer.from([27, 91, 77, 97, 194, 160]);
    // Every split traverses realTerminal -> keyReader -> App, not just parseKeys.
    for (const packet of [up, down]) for (let cut = 1; cut < packet.length; cut++) {
      input!(packet.subarray(0, cut)); input!(packet.subarray(cut));
      expect(app.input).toEqual(draft);
    }
    input!(Buffer.from("\x1b[<64;10;10M".repeat(100)));
    await until(() => display.screen()[start] === "RAW-RECORD-0");
    pinned();
    input!(Buffer.from("\x1b[<64;10;10M".repeat(20)));
    await Bun.sleep(25);
    expect(display.screen()[start]).toBe("RAW-RECORD-0"); pinned();
    const top = display.screen();
    input!(Buffer.from("\x1b[<66;10;10M\x1b[<67;10;10M\x1b[<65;10;10m\x1b[<65M\x1b[M !!"));
    await Bun.sleep(25);
    expect(display.screen()).toEqual(top); pinned();
    input!(Buffer.concat(Array.from({ length: 100 }, () => down)));
    await until(() => display.screen().includes("RAW-RECORD-99")); pinned();
    const bottom = display.screen();
    input!(down); await Bun.sleep(25);
    expect(display.screen()).toEqual(bottom); pinned();
    expect(app.frame().queued?.texts).toEqual(["queued first", "queued second\nline"]);
    const output = writes.join("");
    for (const mode of [1000, 1002, 1006]) {
      expect(output).toContain(`\x1b[?${mode}h`);
      expect(output).not.toContain(`\x1b[?${mode}l`);
    }
    for (const mode of [1049, 2004]) {
      expect(output.split(`\x1b[?${mode}h`)).toHaveLength(2);
      expect(output).not.toContain(`\x1b[?${mode}l`);
    }
    expect(output).not.toContain("\x1b[3J");
    // Draft-safe /keys entry uses a real control byte, not a direct command call.
    input!(Buffer.from("\x07"));
    expect(app.keyEcho).toBe(true);
    input!(up); input!(down);
    expect(page.lines.map(raw).join("\n")).toContain('{"name":"wheelup"}');
    expect(page.lines.map(raw).join("\n")).toContain('{"name":"wheeldown"}');
    input!(Buffer.from("\x1b"));
    await until(() => !app.keyEcho);
    expect(app.input).toEqual(draft);
    expect(JSON.stringify(page.sent)).toBe(queue);
  } finally { app.quit(); await running; }
});

test("Option+Backspace and a drag arriving as separate writes through realTerminal: the word goes, the drag auto-copies, even when the Esc timer fires first", async () => {
  const display = new FakeScreen(60, 24), copied: string[] = [];
  let input: ((chunk: Uint8Array) => void) | undefined;
  const stdin = { isTTY: true, setRawMode() {}, on(_e: string, fn: typeof input) { input = fn; }, off() { input = undefined; }, resume() {}, pause() {} };
  const stdout = { isTTY: true, columns: 60, rows: 24, on() {}, write(s: string) { display.write(s); return true; } };
  const proc = { on() {}, off() {}, exit() {}, stderr: { write() {} } };
  const term = realTerminal(stdin as never, stdout as never, proc, NO_REPLY_WINDOW);
  const app = new App({ term, pollMs: 100_000, watchdog: async () => {}, merges: async () => {}, projectModel: async () => "synthetic", clipboardText: async text => { copied.push(text); },
    openOrchestrator: async () => ({ async say() { throw new Error("input must not submit"); }, async pending() { return false; }, async turn() { return []; } }),
  });
  const running = app.run("split-writes");
  // The terminal's writes reach stdin as real reads: a child process writes `prefix`, then `rest`
  // 5ms later on its own clock (as Terminal.app writes the Option prefix and the key, and each
  // mouse report, separately). With `stall`, the read that delivered the prefix keeps the loop
  // busy past the Esc window while the rest lands in the pipe, so the expired Esc timer runs
  // before the read that is already waiting, as under a slow frame.
  const write = async (prefix: string, rest = "", stall = 0) => {
    const source = Bun.spawn(["/bin/sh", "-c", 'printf "%s" "$1"; if [ -n "$2" ]; then sleep 0.005; printf "%s" "$2"; fi', "writes", prefix, rest], { stdin: "ignore", stdout: "pipe" });
    const chunks: string[] = [];
    for await (const chunk of source.stdout) {
      chunks.push(Buffer.from(chunk).toString("latin1"));
      input!(chunk);
      if (chunks.length === 1 && stall) { const end = performance.now() + stall; while (performance.now() < end) { /* busy */ } }
    }
    await source.exited;
    expect(chunks.join("")).toBe(prefix + rest);
    if (rest) expect(chunks[0]).toBe(prefix); // the race did happen: the prefix was read on its own
  };
  const split = (prefix: string, rest: string) => write(prefix, rest, ESC_DELAY_MS + 10);
  try {
    await until(() => !!app.page);
    app.page!.lines.push("SELECT-ME please", ...Array.from({ length: 30 }, (_, i) => `row-${i}`));
    app.reprint();
    await until(() => display.screen().some(row => row.includes("row-29")));
    await write("hello big wide world");
    await write("\x1b", "\x7f"); // Terminal.app: ESC, then DEL, two writes
    expect(app.input).toEqual({ text: "hello big wide ", cursor: 15 });
    await split("\x1b", "\x7f"); // the Esc timer ran before the DEL read: still one chord, never Escape (which clears the draft)
    expect(app.input).toEqual({ text: "hello big ", cursor: 10 });
    await split("\x1b", "\b");
    expect(app.input).toEqual({ text: "hello ", cursor: 6 });
    await split("\x1b", "d"); // any Alt chord
    expect(app.input).toEqual({ text: "hello ", cursor: 6 });
    await write("\x1b"); await Bun.sleep(ESC_DELAY_MS * 3); // a real lone Escape still clears, after the bounded wait
    expect(app.input.text).toBe("");
    for (let i = 0; i < 3; i++) { await write("\x1b[5~"); await Bun.sleep(25); }
    await until(() => display.screen().some(row => row.includes("SELECT-ME")));
    const y = display.screen().findIndex(row => row.includes("SELECT-ME")) + 1;
    // Every report its own write; the ESC of each read before its rest with the timer racing it; the release last.
    for (const report of [`\x1b[<0;1;${y}M`, `\x1b[<32;5;${y}M`, `\x1b[<32;9;${y}M`, `\x1b[<0;9;${y}m`]) await split(report.slice(0, 1), report.slice(1));
    await until(() => copied.length === 1);
    expect(copied).toEqual(["SELECT-ME"]);
    expect(app.input.text).toBe(""); // no report text typed into the draft
  } finally { app.quit(); await running; }
});

test("extended Kitty Option Delete edits Unicode at the cursor through realTerminal, not on release", async () => {
  let input: ((chunk: Uint8Array) => void) | undefined;
  const stdin = { isTTY: true, setRawMode() {}, on(_e: string, fn: typeof input) { input = fn; }, off() {}, resume() {}, pause() {} };
  const stdout = { isTTY: true, columns: 60, rows: 24, on() {}, write() { return true; } };
  const proc = { on() {}, off() {}, exit() {}, stderr: { write() {} } };
  const term = realTerminal(stdin as never, stdout as never, proc, NO_REPLY_WINDOW);
  const orchs = fakeOrchestrators();
  const app = new App({ term, openOrchestrator: orchs.openOrchestrator, pollMs: 100_000 });
  const running = app.run("kitty-option-delete");
  try {
    await until(() => !!app.page);
    app.input = { text: "keep café 世界 tail", cursor: "keep café 世界".length };
    // Documented protocol bytes, not a capture from the user's terminal.
    // Split inside the modifier/event field, the part previously coerced to NaN.
    input!(Buffer.from("\x1b[127;3:"));
    input!(Buffer.from("1u"));
    expect(app.input).toEqual({ text: "keep café  tail", cursor: "keep café ".length });
    input!(Buffer.from("\x1b[127;3:2u"));
    expect(app.input).toEqual({ text: "keep  tail", cursor: 5 });
    input!(Buffer.from("\x1b[127;3:3u"));
    expect(app.input).toEqual({ text: "keep  tail", cursor: 5 });
    expect(orchs.said["kitty-option-delete"]).toEqual([]);
  } finally { app.quit(); await running; }
});
