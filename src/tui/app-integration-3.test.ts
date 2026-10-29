import { appFixture } from "../test/app-fixture";
import { png } from "../test/image-fixture";
import { pendingImageInputs } from "../core/data/images/images";
import type { ImageRef } from "../protocol/images";
import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/config";
import { AGENTS_TICK_MS, App, type Clock } from "./app";
import type { Message } from "../protocol/inbox";
import { all as allQuestions, ask as askQuestions } from "../core/data/inbox/questions";
import { text as said } from "../test/fake-provider";
import { registerTask } from "../core/data/tasks/tasks";
import { type Key } from "./components/keys";
import { Calls } from "./conversation/tools";

const { home, screenErrors, USER_BG, strip, raw, fakeTerm, bodyStart, bodyRows, clickRow, fakeOrchestrators, settle, NO_REPLY_WINDOW, until } = appFixture();

test("ctrl+g enters /keys without replacing chat, answer, or no-page drafts and input history", async () => {
  const term = fakeTerm(100, 24), orchs = fakeOrchestrators();
  const app = new App({ term, pollMs: 100_000, questionDelayMs: 0, openOrchestrator: orchs.openOrchestrator });
  const running = app.run("keys-drafts");
  const check = async () => {
    const draft = { ...app.input }, history = [...(app.page?.inputHistory ?? [])];
    term.type("\x07");
    expect(app.keyEcho).toBe(true);
    term.type("\x1b[<64;1;1M\x1b[<65;1;1M\x1b[200~ignored\x1b[201~\r");
    term.press({ name: "escape" });
    expect(app.keyEcho).toBe(false);
    expect(app.input).toEqual(draft);
    expect(app.page?.inputHistory ?? []).toEqual(history);
  };
  try {
    await until(() => !!app.page);
    app.input = { text: "chat\n界 draft", cursor: 6 };
    await check();
    await askQuestions("keys-drafts", [{ text: "Answer?" }]);
    await app.questions.command(app.page);
    app.input = { text: "answer 👩‍💻", cursor: 4 };
    await check();
    expect(app.questions.answering()).toBe(true);
    await app.onKey({ name: "q", ctrl: true });
    expect(app.input).toEqual({ text: "chat\n界 draft", cursor: 6 });
    expect(orchs.said["keys-drafts"]).toEqual([]);
    await app.closePage();
    app.input = { text: "no-page draft", cursor: 2 };
    await check();
  } finally { app.quit(); await running; }
});

describe("clipboard image drafts and immutable queue ownership (isolated fixtures only)", () => {
  async function fixture(clipboardImage: () => Promise<{ bytes: Uint8Array; mime: string }> = async () => ({ bytes: png(), mime: "image/png" }), extra: Partial<ConstructorParameters<typeof App>[0]> = {}) {
    const project = `images-${crypto.randomUUID()}`;
    mkdirSync(paths.project(project), { recursive: true });
    const term = fakeTerm(100, 28);
    const sent: { text: string; inputId?: string; attachments?: ImageRef[] }[] = [];
    const receipts = new Set<string>();
    let inbox!: (msgs: Message[]) => void;
    const app = new App({ term, pollMs: 100_000, clipboardImage, watchdog: async () => {}, merges: async () => {}, agents: async () => [],
      openOrchestrator: async (_p, _url, _write, onInbox) => {
        inbox = onInbox!;
        return { say: async (text, _submission, inputId, attachments) => { sent.push({ text, inputId, attachments }); },
          pending: async () => false, turn: async () => [], consumed: () => receipts };
      }, ...extra });
    const running = app.run(project);
    await until(() => !!app.page && !term.screen().includes("opening…"));
    return { app, term, project, sent, receipts, inbox: (msgs: Message[]) => inbox(msgs), stop: async () => { app.quit(); await running; } };
  }
  const v: Key = { name: "v", ctrl: true }, y: Key = { name: "y", ctrl: true };
  test("no startup/paste polling; removable visible images, ordinary text paste, image-only sends and exact receipts", async () => {
    let reads = 0;
    const f = await fixture(async () => { reads++; return { bytes: png(), mime: "image/png" }; });
    try {
      expect(reads).toBe(0);
      await f.app.onKey({ name: "paste", text: "ordinary\ntext" });
      expect(reads).toBe(0); expect(f.app.input.text).toBe("ordinary\ntext");
      await f.app.onKey(v); await f.app.onKey(v);
      expect(f.app.frame().inputArea!.lines.join("\n")).toContain("[image 1] [image 2]");
      await f.app.onKey(y); expect(f.app.frame().inputArea!.lines.join("\n")).not.toContain("[image 2]");
      await f.app.onKey({ name: "enter" });
      expect(f.sent[0]!.text).toBe("ordinary\ntext"); expect(f.sent[0]!.attachments).toHaveLength(1);
      expect(f.app.page!.sent).toHaveLength(1);
      expect(f.app.frame().queued!.texts[0]).toContain("[image 1]");
      await f.app.onKey(v); await f.app.onKey({ name: "enter" });
      expect(f.sent[1]!.text).toBe(""); expect(f.sent[1]!.attachments).toHaveLength(1);
      expect(f.sent[1]!.inputId).not.toBe(f.sent[0]!.inputId);
      expect(await pendingImageInputs(f.project)).toHaveLength(2);
      f.inbox([{ from: "user", text: f.sent[0]!.text, ts: "", inputId: "not-the-same" }]);
      expect(f.app.page!.sent).toHaveLength(2);
      f.receipts.add(f.sent[0]!.inputId!);
      f.inbox([{ from: "user", ...f.sent[0]!, ts: "" }]);
      expect(f.app.page!.sent).toHaveLength(1);
      expect(f.term.raw()).not.toContain(png().toString("base64"));
    } finally { await f.stop(); }
  });
  test("slash commands preserve images and draft; esc clears; projects have separate removable attachments", async () => {
    const f = await fixture();
    try {
      await f.app.onKey(v);
      await f.app.onKey({ name: "char", text: "/clear" }); await f.app.onKey({ name: "enter" });
      expect(f.app.input.text).toBe("/clear"); expect(f.sent).toHaveLength(0);
      expect(f.app.frame().inputArea!.lines.join("\n")).toContain("image 1");
      const first = f.app.page!;
      const second = `images-${crypto.randomUUID()}`; mkdirSync(paths.project(second), { recursive: true });
      await f.app.openPage(second);
      expect(f.app.frame().inputArea!.lines.join("\n")).not.toContain("image 1");
      f.app.switchPage(-1); expect(f.app.page).toBe(first);
      expect(f.app.frame().inputArea!.lines.join("\n")).toContain("image 1");
      await f.app.onKey({ name: "escape" });
      expect(f.app.frame().inputArea!.lines.join("\n")).not.toContain("image 1");
      expect(f.app.input.text).toBe("");
    } finally { await f.stop(); }
  });
  test.each(["send", "escape", "refresh", "project", "menu", "question", "delete", "close", "cancel", "history"])("late clipboard completion cannot attach to newer draft/page/modal after %s", async action => {
    let finish!: (image: { bytes: Uint8Array; mime: string }) => void, reads = 0;
    const f = await fixture(async () => { reads++; return new Promise(r => { finish = r; }); });
    try {
      const reading = f.app.onKey(v);
      await f.app.onKey(v); expect(reads).toBe(1);
      if (action === "send") { await f.app.onKey({ name: "char", text: "old prompt" }); await f.app.onKey({ name: "enter" }); }
      if (action === "escape") await f.app.onKey({ name: "escape" });
      if (action === "refresh") await f.app.refreshSessions();
      if (action === "project") { const p = `images-${crypto.randomUUID()}`; mkdirSync(paths.project(p), { recursive: true }); await f.app.openPage(p); f.app.switchPage(-1); }
      if (action === "menu") { f.app.openMenu("fixture", [{ value: "x", label: "x" }], () => {}); await f.app.onKey({ name: "escape" }); }
      if (action === "question") { await f.app.onKey({ name: "q", ctrl: true }); await f.app.onKey({ name: "escape" }); }
      if (action === "delete") f.app.page!.deleting = true;
      if (action === "close") { f.app.closePage(); await f.app.openPage(f.project); }
      if (action === "cancel") await f.app.onKey({ name: "c", ctrl: true });
      if (action === "history") await f.app.onKey({ name: "up" });
      await f.app.onKey({ name: "char", text: "new draft" });
      finish({ bytes: png(), mime: "image/png" }); await reading;
      expect(f.app.frame().inputArea!.lines.join("\n")).not.toContain("image 1");
      expect(f.app.input.text).toContain("new draft");
      expect(f.sent.every(m => !m.attachments?.length)).toBe(true);
    } finally { finish?.({ bytes: png(), mime: "image/png" }); await f.stop(); }
  });
  test("clipboard errors and size/count limits retain text/images; modal ctrl+v never reads clipboard", async () => {
    let fail = false, reads = 0;
    const f = await fixture(async () => { reads++; if (fail) throw new Error("fixture clipboard unavailable"); return { bytes: png(), mime: "image/png" }; });
    try {
      await f.app.onKey({ name: "char", text: "retained" }); await f.app.onKey(v);
      fail = true; await f.app.onKey(v);
      expect(f.app.input.text).toBe("retained"); expect(f.app.frame().inputArea!.lines.join("\n")).toContain("image 1");
      expect(f.app.frame().inputArea!.lines.join("\n")).toContain("fixture clipboard unavailable");
      fail = false; for (let n = 0; n < 4; n++) await f.app.onKey(v);
      expect(reads).toBe(5); expect(f.app.frame().inputArea!.lines.join("\n")).toContain("image 4");
      f.app.openMenu("fixture", [{ value: "x", label: "x" }], () => {});
      await f.app.onKey(v); expect(reads).toBe(5);
    } finally { await f.stop(); }
  });
  test("failed image writes preserve original IDs/bytes, /refresh and explicit retry never infer missing-inbox consumption", async () => {
    let fails = true; const attempts: string[] = [];
    const f = await fixture(undefined, { openOrchestrator: async () => ({
      say: async (_text, _epoch, id) => { attempts.push(id!); if (fails) throw new Error("fixture write error"); },
      pending: async () => false, turn: async () => [], consumed: () => new Set(),
    }) });
    try {
      await f.app.onKey(v);
      await expect(f.app.onKey({ name: "enter" })).rejects.toThrow("write error");
      const inputId = f.app.page!.sent[0]!.inputId;
      expect(f.app.page!.sent[0]!.retry).toBe(true);
      await f.app.refreshSessions(); expect(f.app.page!.sent[0]!.inputId).toBe(inputId);
      f.app.closePage(); await f.app.openPage(f.project);
      expect(f.app.page!.sent[0]!.inputId).toBe(inputId);
      expect(attempts).toHaveLength(1); // reopen NEVER auto-resends
      fails = false;
      await f.app.onKey({ name: "char", text: "/retry-images" }); await f.app.onKey({ name: "enter" });
      expect(attempts).toEqual([inputId, inputId]); expect(f.app.page!.sent).toHaveLength(1);
    } finally { await f.stop(); }
  });
  test("login failure journals image prompts, reopen restores them without sending, explicit retry retains exact IDs", async () => {
    let reject!: (error: Error) => void;
    const f = await fixture(undefined, { login: async () => new Promise((_resolve, r) => { reject = r; }) });
    try {
      await f.app.onKey({ name: "char", text: "/login claude" });
      const signing = f.app.onKey({ name: "enter" });
      await until(() => f.app.loggingIn);
      await f.app.onKey(v); await f.app.onKey({ name: "enter" });
      const [saved] = await pendingImageInputs(f.project);
      expect(saved!.text).toBe(""); expect(f.sent).toHaveLength(0);
      reject(new Error("fixture login failure")); await signing;
      expect(f.app.page!.sent[0]!.inputId).toBe(saved!.inputId);
      f.app.closePage(); await f.app.openPage(f.project);
      expect(f.sent).toHaveLength(0);
      expect(f.app.page!.sent[0]!.inputId).toBe(saved!.inputId);
      expect(f.app.frame().queued!.texts[0]).toContain("/retry-images");
      await f.app.onKey({ name: "char", text: "/retry-images" }); await f.app.onKey({ name: "enter" });
      expect(f.sent).toHaveLength(1); expect(f.sent[0]!.inputId).toBe(saved!.inputId);
      expect(f.sent[0]!.attachments).toEqual(saved!.attachments);
    } finally { await f.stop(); }
  });

});

test('conversation drag highlights only history, auto-copies on release; ctrl+o re-copies and esc/resize/context clear', async () => {
  const term = fakeTerm(60, 24), orchs = fakeOrchestrators();
  const copied: string[] = [];
  const app = new App({ term, openOrchestrator: orchs.openOrchestrator, clipboardText: async text => { copied.push(text); }, pollMs: 100_000 });
  const running = app.run('selection-probe');
  try {
    await until(() => !!app.page);
    app.page!.lines.push('SELECT-ME 界é', ...Array.from({ length: 40 }, (_, i) => `row-${i}`));
    app.reprint();
    await until(() => term.display.screen().some(row => row.includes('row-39')));
    term.press({ name: 'pageup' }); term.press({ name: 'pageup' }); term.press({ name: 'pageup' });
    await until(() => term.display.screen().some(row => row.includes('SELECT-ME')));
    const y = term.display.screen().findIndex(row => row.includes('SELECT-ME')) + 1;
    expect(y).toBeGreaterThan(0);
    term.type(`\x1b[<0;1;${y}M\x1b[<32;9;${y}M\x1b[<0;9;${y}m`);
    await settle();
    expect(term.raw()).toContain('\x1b[7mSELECT-ME\x1b[0m');
    expect(copied).toEqual(['SELECT-ME']);
    term.press({ name: 'wheeldown' }); await settle();
    await app.onKey({ name: 'o', ctrl: true });
    expect(copied).toEqual(['SELECT-ME', 'SELECT-ME']);
    term.type('draft'); await app.onKey({ name: 'escape' });
    expect(app.input.text).toBe('draft');
    await app.onKey({ name: 'o', ctrl: true }); expect(copied).toHaveLength(2);
    // Header/footer cannot create a selection, and the removed command stays absent.
    term.type('\x1b[<0;1;1M\x1b[<32;9;1M\x1b[<0;9;1m');
    await app.onKey({ name: 'o', ctrl: true }); expect(copied).toHaveLength(2);
    expect(app.commands.has('/mouse')).toBe(false);
    term.press({ name: 'pageup' }); await settle();
    term.type(`\x1b[<0;1;${y}M\x1b[<32;9;${y}M\x1b[<0;9;${y}m`);
    term.resize(40, 20); await Bun.sleep(160);
    await app.onKey({ name: 'o', ctrl: true }); expect(copied).toHaveLength(3);
    for (let i = 0; i < 4; i++) { await app.onKey({ name: 'pageup' }); await Bun.sleep(25); }
    await until(() => term.display.screen().some(row => row.includes('SELECT-ME')));
    const currentY = term.display.screen().findIndex(row => row.includes('SELECT-ME')) + 1;
    expect(currentY).toBeGreaterThan(0);
    term.type(`\x1b[<0;1;${currentY}M\x1b[<32;9;${currentY}M\x1b[<0;9;${currentY}m`);
    await settle();
    await app.openPage('selection-other'); await settle();
    await app.onKey({ name: 'o', ctrl: true }); expect(copied).toHaveLength(4);

  } finally { app.quit(); await running; }
});

for (const scroll of ['wheeldown', 'pagedown', 'wheelup']) test(`drag ${scroll} motion/release in one input burst preserves queued scroll and painted coordinates`, async () => {
  const term = fakeTerm(60, 24), orchs = fakeOrchestrators(), copied: string[] = [];
  const app = new App({ term, openOrchestrator: orchs.openOrchestrator, clipboardText: async text => { copied.push(text); }, pollMs: 100_000 });
  const running = app.run(`selection-burst-${scroll}`);
  try {
    await until(() => !!app.page);
    const records = Array.from({ length: 60 }, (_, i) => `ROW-${String(i).padStart(2, '0')}`);
    app.page!.lines = records;
    app.reprint();
    await until(() => term.display.screen().includes('ROW-59'));
    if (scroll !== 'wheelup') {
      for (let i = 0; i < 10; i++) term.press({ name: 'pageup' });
      await until(() => term.display.screen().includes('ROW-00'));
    }
    const painted = term.display.screen();
    const y = painted.findIndex(row => row.startsWith('ROW-')) + 1;
    const first = Number(painted[y - 1]!.slice(4));
    const count = painted.filter(row => row.startsWith('ROW-')).length;
    const target = first + (scroll === 'wheelup' ? -3 : scroll === 'wheeldown' ? 3 : count - 1);
    // No yields/settles: events queue behind the same throttled frame. Motion
    // still refers to the old painted rows, not the requested scroll target.
    term.press({ name: 'mousedown', x: 1, y });
    term.press({ name: scroll });
    term.press({ name: 'mousemove', x: 6, y: y + 1 });
    term.press({ name: 'mouseup', x: 6, y: y + 1 });
    expect(copied).toEqual([`${records[first]}\n${records[first + 1]}`]);
    await app.onKey({ name: 'o', ctrl: true }); // flush pending frame + explicit copy
    expect(term.display.screen()[y - 1]).toBe(records[target]!);
    expect(copied).toEqual(Array(2).fill(`${records[first]}\n${records[first + 1]}`));
  } finally { app.quit(); await running; }
});

test('automatic copy errors stay visible, highlight supports explicit retry; motion and canceled release do not copy', async () => {
  const term = fakeTerm(60, 24), orchs = fakeOrchestrators(), copied: string[] = [];
  const app = new App({ term, openOrchestrator: orchs.openOrchestrator, clipboardText: async text => {
    copied.push(text); throw new Error('fixture desktop unavailable');
  }, pollMs: 100_000 });
  const running = app.run('selection-error');
  try {
    await until(() => !!app.page);
    app.page!.lines = ['COPY-ME']; app.reprint(); await settle();
    const y = term.display.screen().findIndex(row => row.includes('COPY-ME')) + 1;
    const down = () => app.onKey({ name: 'mousedown', x: 1, y });
    const up = () => app.onKey({ name: 'mouseup', x: 7, y });
    await down(); await app.onKey({ name: 'mousemove', x: 7, y });
    expect(copied).toEqual([]);
    await app.onKey({ name: 'escape' }); await up();
    expect(copied).toEqual([]);
    await down(); await up(); await up();
    expect(copied).toEqual(['COPY-ME']);
    expect(app.frame().inputArea!.lines.join('\n')).toContain('copy failed: fixture desktop unavailable');
    await app.onKey({ name: 'o', ctrl: true });
    expect(copied).toEqual(['COPY-ME', 'COPY-ME']);
  } finally { app.quit(); await running; }
});

test("unchanged telemetry polls avoid redraw; task progress is independent of the saved limit and agent switches render honestly", async () => {
  const term = fakeTerm(80, 24);
  const tasks = [{ id: "one", branch: "feat/one", review: { rounds: 1, unknown: false, ci: false } }] as import("../protocol/task/tasks").TaskRow[];
  const fake = fakeOrchestrators();
  let limit = 7;
  const app = new App({ term, pollMs: 100_000, projectModel: async () => "gpt-5.5", tasks: async () => tasks, flowSettings: async () => ({ maxReviewRounds: limit, dynamicDispatch: false }),
    agents: async () => [], openOrchestrator: async (...args) => ({ ...await fake.openOrchestrator(args[0], args[1], args[2], args[3]), contextUsage: () => 12500 }) });
  const running = app.run("header-poll-telemetry");
  try {
    await until(() => !!app.page);
    await app.refreshHeader();
    await until(() => term.screen().includes("ctx ~12.5k/272k") && term.screen().includes("review rounds: 7"));
    await settle();
    const draws = spyOn(app, "draw"), bytesBefore = term.writes.length;
    for (let i = 0; i < 20; i++) await app.refreshHeader();
    expect(draws).not.toHaveBeenCalled();
    expect(term.writes.length).toBe(bytesBefore);
    limit = 0;
    await app.refreshSessions();
    await app.refreshHeader();
    expect(draws).toHaveBeenCalled();
    await until(() => term.screen().includes("review rounds: 0"));
    draws.mockRestore();
    // These views have no usage accessor of their own: never borrow the main
    // session's estimate or current project model limit for another agent.
    app.page!.view = { name: "reviewer-feat-two", lines: [], leave() {}, live: false, calls: new Calls() };
    app.draw();
    await until(() => term.screen().includes("review rounds: 0") && term.screen().includes("view reviewer-feat-two"));
    expect(term.screen()).toContain("ctx ?/?");
    app.page!.view = { ...app.page!.view!, name: "worker-feat-one" };
    app.draw();
    await until(() => term.screen().includes("view worker-feat-one") && term.screen().includes("review rounds: 0"));
    app.page!.view = null; app.draw();
    await until(() => term.screen().includes("ctx ~12.5k/272k") && term.screen().includes("review rounds: 0"));
  } finally { app.quit(); await running; }
});

test("header denominator: verified claude window, unlisted model shows the session's compaction estimate", async () => {
  const term = fakeTerm(80, 24);
  const fake = fakeOrchestrators();
  let model = "claude-opus-5-5";
  const app = new App({ term, pollMs: 100_000, projectModel: async () => model, tasks: async () => [], flowSettings: async () => ({ maxReviewRounds: 7, dynamicDispatch: false }), agents: async () => [],
    openOrchestrator: async (...args) => ({ ...await fake.openOrchestrator(args[0], args[1], args[2], args[3]), contextUsage: () => 45000,
      contextWindow: (m: string) => (m === "claude-opus-5-5" ? { limit: 1000000, estimated: false } : { limit: 64000, estimated: true }) }) });
  const running = app.run("header-denominator");
  try {
    await until(() => !!app.page);
    await app.refreshHeader();
    await until(() => term.screen().includes("ctx ~45k/1M"));
    model = "unlisted-model";
    await app.refreshHeader();
    await until(() => term.screen().includes("ctx ~45k/64k?"));
    app.page!.view = { name: "reviewer-feat-two", lines: [], leave() {}, live: false, calls: new Calls() };
    app.draw();
    await until(() => term.screen().includes("view reviewer-feat-two"));
    expect(term.screen()).toContain("ctx ?/?");
  } finally { app.quit(); await running; }
});

describe("/agents clocks", () => {
  const T0 = Date.parse("2024-05-01T10:00:00.000Z");
  const iso = (ms: number) => new Date(T0 + ms).toISOString();
  const row = (term: ReturnType<typeof fakeTerm>, name: string) => term.screen().split("\n").find((l) => l.includes(name))?.trim();

  /** An app whose clock and timers the test drives; `agents` is what the list returns now. */
  async function setup(agents: () => Promise<{ name: string; live: boolean; startedAt?: string; endedAt?: string; approximateEnd?: boolean }[]>) {
    const term = fakeTerm(80, 24);
    const state = { now: T0 + 192_000 };
    const timers: { fn: () => void; ms: number }[] = [];
    const clock: Clock = { now: () => state.now, every: (fn, ms) => { const t = { fn, ms }; timers.push(t); return () => { timers.splice(timers.indexOf(t), 1); }; } };
    const menuTimers = () => timers.filter((t) => t.ms === AGENTS_TICK_MS);
    const app = new App({ term, clock, pollMs: 100_000, agents, watchdog: async () => {}, merges: async () => {}, openOrchestrator: fakeOrchestrators().openOrchestrator });
    const running = app.run("clocks");
    await until(() => !!app.page);
    return { term, state, timers, menuTimers, app, running, stop: async () => { app.quit(); await running; },
      tick: async (ms: number) => { state.now += ms; for (const t of menuTimers()) t.fn(); await Bun.sleep(30); } };
  }

  test("a live agent's clock ticks once a second from its start; a finished agent's time is final", async () => {
    const t = await setup(async () => [
      { name: "worker-foo", live: true, startedAt: iso(0) },
      { name: "worker-old", live: false, startedAt: iso(0), endedAt: iso(14 * 60_000 + 2000) },
      { name: "worker-kill", live: false, startedAt: iso(0), endedAt: iso(61_000), approximateEnd: true },
      { name: "worker-none", live: false },
    ]);
    try {
      expect(t.menuTimers().length).toBe(0);
      t.term.type("/agents\r");
      await until(() => !!t.app.menu);
      await until(() => row(t.term, "worker-foo") === "❯ worker-foo  live 3m 12s");
      expect(row(t.term, "worker-old")).toBe("worker-old  finished 14m 02s");
      expect(row(t.term, "worker-kill")).toBe("worker-kill  finished ~1m 01s");
      expect(row(t.term, "worker-none")).toBe("worker-none  finished");
      expect(t.menuTimers().map((x) => x.ms)).toEqual([1000]);
      await t.tick(1000);
      await until(() => row(t.term, "worker-foo") === "❯ worker-foo  live 3m 13s");
      await t.tick(5000);
      await until(() => row(t.term, "worker-foo") === "❯ worker-foo  live 3m 18s");
      expect(row(t.term, "worker-old")).toBe("worker-old  finished 14m 02s");
    } finally { await t.stop(); }
  });

  test("an agent that exits while the menu is open flips to finished and freezes at its end", async () => {
    let list = [{ name: "worker-foo", live: true, startedAt: iso(0) } as { name: string; live: boolean; startedAt?: string; endedAt?: string }];
    let reads = 0;
    const t = await setup(async () => { reads++; return list; });
    try {
      t.term.type("/agents\r");
      await until(() => row(t.term, "worker-foo") === "❯ worker-foo  live 3m 12s");
      const opened = reads;
      await t.tick(1000);
      expect(reads).toBe(opened); // not due yet: the list is read every other second
      list = [{ name: "worker-foo", live: false, startedAt: iso(0), endedAt: iso(193_000) }];
      await t.tick(1000); // now 3m 14s: the list is re-read and shows the end at 3m 13s
      await until(() => row(t.term, "worker-foo") === "❯ worker-foo  finished 3m 13s");
      expect(reads).toBe(opened + 1);
      await t.tick(60_000);
      await t.tick(60_000);
      expect(row(t.term, "worker-foo")).toBe("❯ worker-foo  finished 3m 13s");
    } finally { await t.stop(); }
  });

  test("list reads never overlap, and a failed read leaves the menu as it was", async () => {
    let reads = 0, release!: () => void, mode: "ok" | "hold" | "fail" = "ok";
    const t = await setup(async () => {
      reads++;
      if (mode === "hold") await new Promise<void>((r) => (release = r));
      if (mode === "fail") throw new Error("tmux gone");
      return [{ name: "worker-foo", live: true, startedAt: iso(0) }];
    });
    try {
      t.term.type("/agents\r");
      await until(() => !!t.app.menu);
      const opened = reads;
      mode = "hold";
      await t.tick(2000);
      await t.tick(1000);
      await t.tick(1000);
      expect(reads).toBe(opened + 1); // the first re-read is still pending
      release();
      mode = "fail";
      await Bun.sleep(30);
      await t.tick(2000);
      await until(() => reads === opened + 2);
      await Bun.sleep(30);
      expect(row(t.term, "worker-foo")).toContain("live 3m");
      mode = "ok";
      await t.tick(2000);
      await until(() => reads === opened + 3);
    } finally { await t.stop(); }
  });

  test("the selection follows its agent by name when the list reorders or grows, and Enter attaches that agent", async () => {
    const mk = (...names: string[]) => names.map((name) => ({ name, live: false }));
    let list = mk("worker-a", "worker-b", "worker-c");
    const t = await setup(async () => list);
    try {
      t.term.type("/agents\r");
      await until(() => !!t.app.menu);
      t.term.press({ name: "down" });
      await until(() => t.app.menu!.index === 1);
      list = mk("worker-c", "worker-x", "worker-b", "worker-a");
      await t.tick(2000);
      await until(() => t.app.menu!.index === 2);
      expect(row(t.term, "worker-b")).toBe("❯ worker-b  finished");
      list = mk("worker-c", "worker-a"); // the selected agent vanished: same position, in range
      await t.tick(2000);
      await until(() => t.app.menu!.index === 1);
      list = mk("worker-a", "worker-c", "worker-b");
      await t.tick(2000);
      await until(() => t.app.menu!.index === 0);
      t.term.press({ name: "enter" });
      await until(() => t.app.page!.view?.name === "worker-a");
      expect(t.menuTimers().length).toBe(0);
    } finally { await t.stop(); }
  });

  test("no menu timer runs before the menu opens, after esc, in another overlay, or after quitting", async () => {
    const t = await setup(async () => [{ name: "worker-foo", live: true, startedAt: iso(0) }]);
    try {
      expect(t.menuTimers().length).toBe(0);
      t.term.type("/agents\r");
      await until(() => t.menuTimers().length === 1);
      t.term.press({ name: "escape" });
      await until(() => !t.app.menu);
      expect(t.menuTimers().length).toBe(0);

      t.term.type("/agents\r");
      await until(() => t.menuTimers().length === 1);
      await t.app.openProjects(); // another overlay replaces the menu
      expect(t.menuTimers().length).toBe(0);
      await t.app.closeProjects();

      t.term.type("/agents\r");
      await until(() => t.menuTimers().length === 1);
      t.term.type("");
      t.app.quit();
      await t.running;
      expect(t.timers.length).toBe(0);
    } finally { await t.stop(); }
  });

  test("a tick after the menu closed starts no list read, and a read that finds the view moved on closes the menu", async () => {
    let reads = 0;
    const t = await setup(async () => { reads++; return [{ name: "worker-foo", live: true, startedAt: iso(0) }]; });
    try {
      t.term.type("/agents\r");
      await until(() => t.menuTimers().length === 1);
      const tick = t.menuTimers()[0]!.fn;
      const opened = reads;
      t.app.menu = null; // closed, but the draw that syncs the timer off has not run yet (Enter while attach runs)
      t.state.now += 5000;
      tick();
      await Bun.sleep(30);
      expect(reads).toBe(opened);
      expect(t.menuTimers().length).toBe(0);

      t.term.type("/agents\r");
      await until(() => t.menuTimers().length === 1);
      (t.app as unknown as { modelGeneration: number }).modelGeneration++; // another operation superseded the menu
      await t.tick(2000);
      await until(() => !t.app.menu && t.menuTimers().length === 0);
    } finally { await t.stop(); }
  });

  test("ticks only redraw through the frame throttle", async () => {
    const t = await setup(async () => [{ name: "worker-foo", live: true, startedAt: iso(0) }]);
    try {
      t.term.type("/agents\r");
      await until(() => row(t.term, "worker-foo") === "❯ worker-foo  live 3m 12s");
      await settle();
      const before = t.term.writes.length;
      t.state.now += 1000;
      for (let i = 0; i < 20; i++) t.menuTimers()[0]!.fn();
      await Bun.sleep(40);
      expect(t.term.writes.length - before).toBeLessThanOrEqual(2);
      expect(row(t.term, "worker-foo")).toBe("❯ worker-foo  live 3m 13s");
    } finally { await t.stop(); }
  });
});

test("task tree activation routes terminal keys, preserves drafts, selects renderer hits and refreshes durable UUIDs", async () => {
  const term = fakeTerm(120, 28), fake = fakeOrchestrators();
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  let tasks: import("../protocol/task/tasks").Task[] = Array.from({ length: 12 }, (_, i) => ({
    id: id(i + 1), name: `Node ${i + 1}`, summary: `Summary ${i + 1}`, branch: "feat/tree",
    status: "queued", createdAt: "2026-01-01", updatedAt: "2026-01-02", revision: 1,
    dependsOn: i ? [id(i)] : [], runs: [], history: [],
  }));
  tasks[0]!.summary = "Long metadata ".repeat(120);
  tasks[0]!.archive = { reason: "merged", mergedAt: "today", archivedAt: "today",
    pr: { repository: "test/repo", number: 1, url: "https://github.com/test/repo/pull/1", head: "a".repeat(40) } };
  let fail = false;
  const app = new App({ term, pollMs: 100_000, agents: async () => [],
    clipboardImage: async () => ({ bytes: png(), mime: "image/png" }),
    openOrchestrator: fake.openOrchestrator, treeTasks: async () => {
      if (fail) throw new Error("registry offline");
      return tasks;
    } });
  mkdirSync(paths.project("tree-navigation"), { recursive: true });
  await askQuestions("tree-navigation", [{ text: "Keep this pending?" }]);
  const running = app.run("tree-navigation");
  const screen = () => term.display.screen().join("\n");
  try {
    await until(() => !!app.page);
    term.type("draft survives"); term.press({ name: "left" });
    await app.onKey({ name: "v", ctrl: true });
    expect(app.frame().inputArea!.lines.join("\n")).toContain("[image 1]");
    const draft = { ...app.input };
    const questions = app.page!.questions;
    // Bytes from the terminal's registered callback, not an isolated navigation helper.
    term.type("\x14");
    await until(() => screen().includes("Task #1 ·"));
    expect(screen()).toContain("Long metadata");
    expect(screen()).toContain("↑↓ select");
    term.type("\x1b[Z");
    await until(() => screen().includes("Task #2 ·"));
    expect(screen()).toContain("Overview: Summary 2");
    const row = term.display.screen().findIndex(line => line.includes("● #1 Node 1"));
    const col = term.display.screen()[row]!.indexOf("#1");
    term.press({ name: "mousedown", x: col + 1, y: row + 1 });
    term.press({ name: "mouseup", x: col + 1, y: row + 1 });
    await until(() => screen().includes("Task #1 ·"));
    term.press({ name: "left" });
    await until(() => !screen().includes("● #2 Node 2"));
    term.press({ name: "right" });
    await until(() => screen().includes("● #2 Node 2"));
    term.press({ name: "down" });
    await until(() => screen().includes("Task #2 ·"));
    term.press({ name: "left" }); term.press({ name: "left" });
    await until(() => screen().includes("Task #1 ·"));
    term.press({ name: "right" });
    term.press({ name: "down" });
    await until(() => !screen().includes("details=0/"));
    term.press({ name: "up" });
    await until(() => screen().includes("details=0/"));
    term.press({ name: "left" });
    tasks = [...tasks].reverse().map(t => t.id === id(1) ? { ...t, summary: "Updated durable metadata" } : t);
    await app.refreshSessions();
    await until(() => screen().includes("Updated durable metadata"));
    expect(screen()).toContain("Task #1 · merged");
    term.resize(52, 18);
    await until(() => screen().includes("TASKS"));
    term.type("\x14");
    await until(() => !screen().includes("TASKS"));
    expect(app.input.text).toBe(draft.text); expect(app.input.cursor).toBe(draft.cursor);
    expect(app.page!.questions).toBe(questions);
    expect((await allQuestions("tree-navigation"))[0]!.status).toBe("open");
    expect(app.frame().inputArea!.lines.join("\n")).toContain("[image 1]");
    term.resize(120, 28); term.type("\x14");
    await until(() => screen().includes("Task #1 ·"));
    tasks = tasks.filter(t => t.id !== id(1)).map(t => ({ ...t, dependsOn: [] }));
    await app.refreshSessions();
    await until(() => screen().includes("Task #1 · queued: Node 2"));
    fail = true; await app.refreshSessions();
    await until(() => screen().includes("Tasks unavailable: registry offline"));
    fail = false; tasks = []; term.type("r");
    await until(() => screen().includes("No tasks"));
    term.press({ name: "escape" });
    await until(() => !screen().includes("TASKS"));
    expect(app.input.text).toBe(draft.text); expect(app.input.cursor).toBe(draft.cursor);
  } finally { app.quit(); await running; }
});

for (const state of ["ready", "loading", "error"] as const) {
  test(`task tree Ctrl+C cancels a running turn and repeats to exit while ${state}`, async () => {
    const term = fakeTerm(120, 28), fake = fakeOrchestrators();
    let cancelled = 0, finish!: () => void;
    const turn = new Promise<void>(resolve => { finish = resolve; });
    const app = new App({ term, pollMs: 100_000, agents: async () => [],
      clock: { now: () => 10000, every: () => () => {} },
      treeTasks: async () => {
        if (state === "loading") return new Promise(() => {});
        if (state === "error") throw new Error("offline");
        return [];
      },
      openOrchestrator: async (...args) => ({ ...await fake.openOrchestrator(args[0], args[1], args[2], args[3]),
        turn: async () => { await turn; return []; },
        cancel: () => { cancelled++; finish(); },
      }),
    });
    const running = app.run(`tree-interrupt-${state}`);
    try {
      await until(() => !!app.page);
      term.type("run a turn\r");
      await until(() => app.page!.busy);
      term.type("\x14");
      const label = { ready: "No tasks", loading: "Loading tasks", error: "Tasks unavailable: offline" }[state];
      await until(() => term.screen().includes(label));
      term.type("\x03");
      await until(() => cancelled === 1 && !app.page!.busy);
      expect(term.closed).toBe(false);
      expect(term.screen()).toContain(label);
      term.type("\x03");
      await until(() => term.closed);
      await running;
      expect(cancelled).toBe(1);
    } finally { finish(); app.quit(); await running; }
  });
}

test("task tree deferred reads coalesce a trailing pass and ignore a replaced overlay", async () => {
  const term = fakeTerm(120, 28), fake = fakeOrchestrators();
  const reads: { resolve: (tasks: import("../protocol/task/tasks").Task[]) => void; reject: (error: Error) => void }[] = [];
  const app = new App({ term, pollMs: 100_000, agents: async () => [],
    openOrchestrator: fake.openOrchestrator,
    treeTasks: () => new Promise((resolve, reject) => { reads.push({ resolve, reject }); }),
  });
  const running = app.run("tree-deferred");
  try {
    await until(() => !!app.page);
    term.type("\x14");
    await until(() => reads.length === 1);
    for (let i = 0; i < 3; i++) term.type("r");
    expect(reads.length).toBe(1);
    reads[0]!.resolve([]);
    await until(() => reads.length === 2);
    term.type("\x14\x14");
    await until(() => reads.length === 3);
    reads[2]!.resolve([]);
    await until(() => term.screen().includes("No tasks"));
    reads[1]!.reject(new Error("obsolete failure"));
    await settle();
    expect(term.screen()).not.toContain("obsolete failure");
    expect(reads.length).toBe(3);
    term.type("r");
    await until(() => reads.length === 4);
    reads[3]!.reject(new Error("current failure"));
    await until(() => term.screen().includes("current failure"));
  } finally { app.quit(); await running; }
});

test("task tree cycling reveals long independent registries without changing chat input", async () => {
  const term = fakeTerm(80, 24), fake = fakeOrchestrators();
  const tasks: import("../protocol/task/tasks").Task[] = Array.from({ length: 24 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    name: `Independent task ${i + 1}`, summary: "Saved task with a long readable overview. ".repeat(90), branch: "feat/example",
    status: "queued", createdAt: "2026-01-01", updatedAt: "2026-01-02", revision: 1,
    dependsOn: [], runs: [], history: [],
  }));
  const app = new App({ term, pollMs: 100_000, agents: async () => [],
    openOrchestrator: fake.openOrchestrator, treeTasks: async () => tasks });
  const running = app.run("tree-independent");
  const screen = () => term.display.screen().join("\n");
  try {
    await until(() => !!app.page);
    term.type("keep draft"); term.type("\x14");
    await until(() => screen().includes("● #1 Independent task 1"));
    for (let i = 0; i < 23; i++) term.type("\x1b[Z");
    await until(() => screen().includes("● #24 Independent task 24"));
    expect(screen()).toContain("Outline y=");
    term.type("\x1b[Z");
    await until(() => screen().includes("● #1 Independent task 1"));
    expect(screen()).toContain("Outline y=0/");
    term.press({ name: "right" });
    await until(() => screen().includes("Details: ↑↓ scroll"));
    term.press({ name: "down" });
    await until(() => !screen().includes("details=0/"));
    term.press({ name: "up" });
    term.press({ name: "mousedown", x: 5, y: 18 });
    term.press({ name: "left" });
    await until(() => screen().includes("↑↓ select"));
    term.press({ name: "escape" });
    await until(() => !screen().includes("TASKS"));
    expect(app.input.text).toBe("keep draft");
  } finally { app.quit(); await running; }
});

test("task tree r re-reads the real ledger and says when it refreshed; dots follow the new status", async () => {
  const { registerTask, setTaskAttention } = await import("../core/data/tasks/tasks");
  const project = "tree-r-refresh";
  mkdirSync(paths.project(project), { recursive: true });
  const first = await registerTask(project, { name: "First", summary: "s", branch: "feat/a", authorized: true });
  const term = fakeTerm(100, 30), fake = fakeOrchestrators();
  const app = new App({ term, pollMs: 100_000, agents: async () => [], openOrchestrator: fake.openOrchestrator });
  const running = app.run(project), screen = () => term.display.screen().join("\n");
  try {
    await until(() => !!app.page); term.type("\x14");
    await until(() => screen().includes("● #1 First"));
    expect(term.raw()).toContain("\x1b[90m●");
    await registerTask(project, { name: "Second", summary: "s", branch: "feat/b", authorized: true });
    await setTaskAttention(project, first.id, { kind: "blocked", reason: "stopped" }, first.revision);
    term.type("r"); // no poll, no refreshSessions: only the key
    await until(() => screen().includes("● #2 Second"));
    await until(() => /Refreshed \d\d:\d\d:\d\d/.test(screen()));
    expect(term.raw()).toContain("\x1b[31m●");
  } finally { app.quit(); await running; }
});

for (const width of [80, 120]) test(`persistent task tree real App ${width}: confirmed merged d retains SQL and numbering`, async () => {
  const { registerTask, observeTaskPR, getTask, listTasks, setTaskDependencies } = await import("../core/data/tasks/tasks");
  const { searchLedger } = await import("../core/data/tasks/ledger-store");
  const project = `persistent-tree-${width}`;
  mkdirSync(paths.project(project), { recursive: true });
  const a = await registerTask(project, { name: "Merged parent", summary: "retained memory", branch: "feat/a", authorized: true });
  const b = await registerTask(project, { name: "Queued child", summary: "dependent", branch: "feat/b", authorized: true });
  await setTaskDependencies(project, b.id, [a.id]);
  await observeTaskPR(project, a.id, { pr: { repository: "o/r", number: 1, url: "https://github.com/o/r/pull/1", head: "a".repeat(40) }, branch: a.branch, state: "MERGED", mergedAt: "2026-01-01T00:00:00Z", ready: false, checks: "unknown" });
  const term = fakeTerm(width, 34), fake = fakeOrchestrators();
  const app = new App({ term, pollMs: 100_000, agents: async () => [], openOrchestrator: fake.openOrchestrator });
  const running = app.run(project), screen = () => term.display.screen().join("\n");
  try {
    await until(() => !!app.page); term.type("draft"); term.type("\x14");
    await until(() => screen().includes("Task #1 · merged"));
    expect(term.raw()).toContain("https://github.com/o/r/pull/1"); // OSC8 + visible fallback; not a physical Cmd gesture claim
    term.press({ name: "down" }); await until(() => screen().includes("Task #2 · queued"));
    term.type("d"); await until(() => screen().includes("Only verified merged"));
    term.press({ name: "up" }); await until(() => screen().includes("Task #1 · merged"));
    term.type("d"); await until(() => screen().includes("y confirm / n cancel"));
    term.type("n"); expect(await listTasks(project)).toHaveLength(2);
    term.type("d"); term.type("y");
    await until(() => screen().includes("Task #2 · queued") && !screen().includes("● #1 Merged"));
    expect((await listTasks(project)).map(t => t.number)).toEqual([2]);
    expect((await getTask(project, b.id)).dependsOn).toEqual([a.id]);
    expect((searchLedger({ project, taskId: a.id })[0] as { removedAt: string }).removedAt).toBeTruthy();
    expect(screen()).toContain("retained");
    term.type("r"); await app.refreshSessions(); expect(screen()).toContain("Task #2 · queued");
    term.type("\x14"); expect(app.input.text).toBe("draft"); term.type("\x14");
    await until(() => screen().includes("Task #2 · queued"));
    expect(screen()).not.toContain("● #1 Merged");
  } finally { app.quit(); await running; }
});
