import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, parseCommand, type AppDeps } from "./app";
import { taskInboxLines, inboxText } from "./task-inbox";
import { taskInboxPanel, statusRows, visibleLength, type Frame } from "./render";
import { chapterRows, headerHeight } from "./chrome";
import { stickyRows, stickyUpdate } from "./sticky";
import { FakeScreen } from "./testing";
import { Calls } from "./tools";
import type { Terminal } from "./term";
import type { Orchestrator } from "../orchestrator";
import { drain, pendingInput, type Message } from "../inbox";
import { fileStore, type QuestionStore } from "./questions";
import { paths, saveConfig } from "../config";
import { ask, all as allQuestions, type Question } from "../questions";
import { archiveMergedTasks, getTask, listTasks, observeTaskPR, prepareTaskRun, registerTask, startTaskRun, stopTaskRun, taskStatuses, type TaskPR, type TaskRow } from "../tasks";

const pr: TaskPR = { repository: "owner/repo", number: 62, url: "https://github.com/owner/repo/pull/62", head: "a".repeat(40) };
const row = (name = "Task one", status: TaskRow["status"] = "queued"): TaskRow => ({ id: name, name, summary: "A brief structured summary", branch: "feat/one", status, pr, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
const plain = (lines: string[]) => lines.map(line => Bun.stripANSI(line).trimEnd()).join("\n");
const frame = (cols = 100, rows = 24, tasks = [row()]): Frame => ({ cols, rows, menu: null,
  input: { prompt: "> ", text: "draft 界\nsecond line", cursor: 4 }, status: "0 agents running │ 1 message queued │ inbox 1",
  queued: { project: "isolated", texts: ["pending input"] },
  inbox: { ...taskInboxLines({ rows: tasks, loading: false }, cols), top: 0, state: "ready" } });
const chrome = (f: Frame) => chapterRows({ tabs: [{ name: "isolated" }], active: 0, model: "fake-model", directory: "/isolated/repo", remote: "owner/repo" }, f.cols, headerHeight(f.rows));
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const previous = process.env.PARALLELS_HOME;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); process.env.PARALLELS_HOME = previous; });
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}
async function setup(extra: Partial<AppDeps> = {}) {
  const home = mkdtempSync(join(tmpdir(), "task-inbox-ui-"));
  process.env.PARALLELS_HOME = home;
  await saveConfig({ model: "fake-model" });
  const screen = new FakeScreen(100, 28);
  let resize = () => {}, turns = 0, cancelled = 0, closed = false, exit = "";
  const sent: { project: string; text: string; inputId?: string }[] = [];
  const receive = new Map<string, (msgs: Message[]) => void>();
  const term: Terminal = { cols: 100, rows: 28, open() {}, close() { closed = true; }, eraseOnExit() {}, onKey() {}, onResize(cb) { resize = cb; }, write(s) { screen.write(s); if (closed) exit += s; } };
  const app = new App({ term, pollMs: 100_000, projectModel: async () => "fake-model", agents: async () => [], watchdog: async () => {}, merges: async () => {}, questionDelayMs: 0,
    projects: { live: async () => [], kill: async () => {} },
    openOrchestrator: async (project, _url, _write, inbox) => {
      mkdirSync(paths.repo(project), { recursive: true });
      if (inbox) receive.set(project, inbox);
      return { entries: () => [], pending: async () => false, turn: async () => { turns++; return []; }, say: async (text: string, _submission?: string, inputId?: string) => { sent.push({ project, text, inputId }); }, cancel: () => { cancelled++; } } as unknown as Orchestrator;
    }, ...extra });
  const running = app.run("a");
  await until(() => !!app.page);
  cleanups.push(async () => { app.quit(); await running; for (const p of app.pages) await p.savingHistory; rmSync(home, { recursive: true, force: true }); });
  return { app, screen, term, receive, sent, running, calls: () => ({ turns, cancelled }), exit: () => exit,
    command: () => app.commands.get("/inbox")!.run("", app.page),
    // Drive the existing poll's watchers deterministically, without another timer.
    poll: () => (app as unknown as { watchPages(): void }).watchPages(),
    resize(cols: number, rows: number) { term.cols = cols; term.rows = rows; screen.resize(cols, rows); resize(); } };
}
const text = (app: App) => plain(app.frame().inbox?.lines ?? []);

test("normal-width table has four columns and exact stage labels; all attention kinds stay visible", () => {
  const rows = taskStatuses.map((status, i) => row(`Stage ${i}`, status));
  for (const kind of ["waiting", "blocked", "cancelled", "closed", "unknown"] as const) rows.push({ ...row(kind, "working"), attention: { kind, reason: `Needs ${kind} handling` } });
  const rendered = taskInboxLines({ rows, loading: false }, 120);
  expect(plain([rendered.heading!])).toMatch(/name +\| summary +\| status +\| pr link/);
  const contents = plain(rendered.lines);
  for (const label of ["queued", "working", "reviewing", "ready to merge"]) expect(contents).toContain(label);
  expect(contents).not.toContain("ready_to_merge");
  for (const kind of ["waiting", "blocked", "cancelled", "closed", "unknown"]) expect(contents).toContain(kind);
  expect(contents).not.toContain("!"); expect(contents).not.toContain("Needs");
  expect(rendered.lines.join("\n")).toContain(`\x1b]8;;${pr.url}\x1b\\`);
});

test("long summaries cannot hide attention beside the status at normal widths", () => {
  const task = { ...row("Long task", "working"), summary: "summary ".repeat(60), attention: { kind: "cancelled" as const, reason: "Stopped; not ready" } };
  const rendered = taskInboxLines({ rows: [task], loading: false }, 80);
  expect(plain(rendered.lines.slice(0, 2))).toContain("cancelled");
});

test("exactly one status keyword at wide/narrow/tiny widths, with attention precedence and no mutation", () => {
  for (const width of [120, 80, 72, 71, 40, 12, 3, 1]) {
    for (const status of taskStatuses) {
      for (const kind of [undefined, "waiting", "blocked", "cancelled", "closed", "unknown"] as const) {
        const task = { ...row("Full name", status), summary: "Full summary", ...(kind ? { attention: { kind, reason: "SECRET REASON" } } : {}) };
        const before = structuredClone(task);
        const rendered = taskInboxLines({ rows: [task], loading: false }, width);
        const label = kind ?? (status === "ready_to_merge" ? "ready to merge" : status);
        if (width >= 72) {
          const statuses = rendered.lines.map(line => Bun.stripANSI(line).split(" | ")[2]!.trim()).filter(Boolean);
          expect(statuses).toEqual([label]);
        } else {
          expect(plain(rendered.lines).replace(/\s/g, "")).toBe(`name:Fullnamesummary:Fullsummarystatus:${label.replaceAll(" ", "")}prlink:${pr.url}`);
        }
        expect(plain(rendered.lines)).not.toContain("!");
        expect(plain(rendered.lines)).not.toContain("SECRET");
        expect(task).toEqual(before);
      }
    }
  }
});

test("loading, empty, query failure and stale snapshot are distinct; no historical completion claim", () => {
  expect(plain(taskInboxLines({ loading: true }, 80).lines)).toContain("loading task inbox");
  const empty = plain(taskInboxLines({ loading: false, rows: [] }, 80).lines);
  expect(empty).toContain("no active registered tasks");
  expect(empty.replace(/\s+/g, " ")).toContain("not a completion claim");
  const failed = plain(taskInboxLines({ loading: false, error: "corrupt registry" }, 80).lines);
  expect(failed).toContain("query failed: corrupt registry");
  expect(failed).not.toContain("No active registered tasks");
  const stale = plain(taskInboxLines({ loading: false, rows: [row()], error: "permission denied" }, 100).lines);
  expect(stale).toContain("may be stale"); expect(stale).toContain("Task one");
});

test("unsafe fields, attention, errors and forged links cannot style, move or inject terminal controls", () => {
  const unsafe = "safe\x1b[2J\x1b[31mRED\x1b[0m\x1b]8;;https://evil.test\x07label\x1b]8;;\x07\x1b]52;c;bad\x07\x1bPpayload\x1b\\\r\n\t\b\x9b\u202e\u2066end";
  const bad = { ...row(unsafe), summary: unsafe, attention: { kind: "blocked" as const, reason: unsafe }, pr: { ...pr, url: pr.url + "\x1b]52;c;bad\x07" } };
  const rendered = taskInboxLines({ rows: [bad], loading: false, error: unsafe }, 100);
  const contents = rendered.lines.join("\n");
  expect(contents).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
  expect(contents).not.toContain("evil.test"); expect(contents).not.toContain("payload");
  expect(contents).toContain("invalid pr link");
  expect(inboxText(unsafe)).toContain("safeREDlabel");
  for (const url of ["javascript:alert(1)", "https://evil.test/owner/repo/pull/62", "https://github.com/owner/repo/pull/63"]) {
    expect(plain(taskInboxLines({ rows: [{ ...row(), pr: { ...pr, url } }], loading: false }, 100).lines)).toContain("invalid pr link");
  }
  const noPR = { ...row(), summary: pr.url, pr: undefined };
  expect(plain(taskInboxLines({ rows: [noPR], loading: false }, 40).lines)).toContain("pr link: —");
});

for (const cols of [100, 80, 40]) test(`${cols}x24 task inbox footer appearance`, () => {
  const f = frame(cols), rendered = stickyRows(f, Array.from({ length: 30 }, (_, i) => `conversation ${i}`), chrome(f));
  expect(plain(rendered.rows)).toMatchSnapshot();
  const content = rendered.rows.map(Bun.stripANSI);
  expect(content.findIndex(s => s.includes("inbox ·"))).toBeGreaterThan(content.findIndex(s => s.includes("inbox 1")));
  const footerAt = content.findIndex(s => s.startsWith("queued"));
  expect(content.slice(footerAt - 2, footerAt)).toEqual(["conversation 29", ""]);
  expect(rendered.bodyHeight).toBe(footerAt - chrome(f).length - 1);
  expect(rendered.bodyHeight).toBeGreaterThanOrEqual(2);
  expect(content[rendered.cursor]).toContain("draft");
});

test("large long records and CJK/emoji wrap fully; narrow/tiny screens stay bounded through repeated resizes", () => {
  const tasks = Array.from({ length: 150 }, (_, i) => ({ ...row(`Task ${i} 界👩‍💻`), summary: "longword".repeat(50) + " SUMMARY-END", attention: { kind: "unknown" as const, reason: "reason ".repeat(60) + "REASON-END" } }));
  const screen = new FakeScreen(80, 24);
  for (const [cols, rows] of [[120, 40], [80, 24], [40, 24], [12, 10], [3, 5], [1, 1], [100, 30]]) {
    const f = frame(cols!, rows!, tasks);
    expect(f.inbox!.lines.every(line => Bun.stringWidth(line) <= cols!)).toBe(true);
    expect(plain(f.inbox!.lines).replace(/\s/g, "")).toContain("SUMMARY-END");
    expect(plain(f.inbox!.lines).replace(/\s/g, "")).not.toContain("REASON-END");
    f.inbox!.top = Number.MAX_SAFE_INTEGER;
    const panel = taskInboxPanel(f);
    expect(panel.top).toBe(panel.maxTop);
    const next = stickyRows(f, ["conversation"], chrome(f));
    expect(next.rows).toHaveLength(rows!);
    expect(next.rows.every(line => Bun.stringWidth(line) <= cols!)).toBe(true);
    screen.resize(cols!, rows!); const before = screen.buf.length;
    screen.write(stickyUpdate(next));
    expect(screen.buf.length).toBe(before);
    expect([screen.row, screen.col]).toEqual([next.cursor, next.col]);
  }
});

test("/inbox is a bare grouped command, never opens a project with none, and keyboard enter is read-only", async () => {
  let reads = 0;
  const ui = await setup({ tasks: async () => { reads++; return [row()]; } }), { app } = ui;
  expect(app.commands.get("/inbox")!.help.group).toBe("conversation");
  expect(parseCommand("/inbox extra", app.commands)?.command).toBeUndefined();
  app.input = { text: "/inbox", cursor: 6 }; await app.onKey({ name: "enter" });
  await until(() => text(app).includes("Task one"));
  expect(reads).toBe(1); expect(ui.calls().turns).toBe(0); expect(ui.sent).toEqual([]);
  expect(app.page!.inputHistory).toEqual(["/inbox"]);
  expect(app.page!.lines).toEqual([]);
  await app.onKey({ name: "escape" });
  app.closePage(); await ui.command();
  expect(app.pages).toEqual([]); expect(reads).toBe(1);
});

test("draft/cursor/input window, conversation scroll, pending preview and agent view survive all panel keys", async () => {
  const ui = await setup({ tasks: async () => Array.from({ length: 30 }, (_, i) => row(`Task ${i}`)) }), { app } = ui;
  const page = app.page!;
  page.lines.push(...Array.from({ length: 100 }, (_, i) => `History ${i}`)); app.reprint();
  await until(() => ui.screen.text().includes("History 99"));
  await app.onKey({ name: "pageup" }); await app.onKey({ name: "pageup" });
  await Bun.sleep(25);
  const anchor = ui.screen.screen()[headerHeight(ui.term.rows)];
  const draft = { text: Array.from({ length: 16 }, (_, i) => `draft ${i} 界`).join("\n"), cursor: 72 };
  app.input = { ...draft }; app.draw();
  const window = app.frame().inputArea!.top;
  page.sent.push({ inputId: "exact-identity", text: "pending prompt" });
  const history = [...page.inputHistory], lines = [...page.lines];
  await ui.command(); await until(() => app.frame().inbox?.state === "ready");
  for (const key of [{ name: "enter" }, { name: "enter", shift: true }, { name: "char", text: "1" }, { name: "paste", text: "/quit\ndraft" }, { name: "backspace" }]) await app.onKey(key);
  expect(app.input).toEqual(draft); expect(app.frame().inputArea!.top).toBe(window);
  expect(app.frame().queued!.texts).toEqual(["pending prompt"]);
  expect(page.lines).toEqual(lines); expect(page.inputHistory).toEqual(history);
  for (const key of ["down", "up", "pagedown", "pageup", "end", "home", "wheeldown"]) await app.onKey({ name: key });
  expect(app.frame().inbox!.top).toBe(3);
  await app.onKey({ name: "wheelup" }); expect(app.frame().inbox!.top).toBe(0);
  await app.onKey({ name: "escape" });
  await until(() => !ui.screen.text().includes("inbox · [tasks]"));
  expect(ui.screen.screen()[headerHeight(ui.term.rows)]).toBe(anchor);
  expect(app.input).toEqual(draft); expect(ui.sent).toEqual([]); expect(ui.calls().turns).toBe(0);
  let leaves = 0;
  page.view = { name: "worker-historical", lines: [], leave: () => { leaves++; }, live: false, calls: new Calls() };
  await ui.command(); await app.onKey({ name: "escape" }); expect(leaves).toBe(0);
  expect(page.view.lines).toEqual([]);
});

test("question arrivals remain opt-in; panel cannot consume answers or pending input, and ctrl+q explicitly replaces it", async () => {
  const ui = await setup({ tasks: async () => [] }), { app } = ui, page = app.page!;
  const chat = { text: "chat draft", cursor: 4 }; app.input = { ...chat };
  await ui.command();
  const [q] = await ask("a", [{ text: "Question?" }]);
  app.questions.poll([page]); await until(() => page.questions.open.length === 1);
  expect(app.frame().question).toBeNull(); expect(app.input).toEqual(chat);
  for (const key of [{ name: "enter" }, { name: "char", text: "1" }]) await app.onKey(key);
  expect((await allQuestions("a"))[0]!.status).toBe("open");
  await app.onKey({ name: "q", ctrl: true });
  expect(app.frame().inbox?.section).toBe("questions"); expect(app.questions.answering()).toBe(true);
  const answer = { text: "unsent answer", cursor: 3 }; app.input = { ...answer };
  await ui.command(); await app.onKey({ name: "enter" }); await app.onKey({ name: "escape" });
  expect(app.input).toEqual(chat);
  await app.onKey({ name: "q", ctrl: true }); expect(app.input).toEqual(answer);
  await app.onKey({ name: "q", ctrl: true }); expect(app.input).toEqual(chat);
  page.sent.push({ inputId: "a-exact", text: "identical" });
  await ui.command();
  ui.receive.get("a")!([{ from: "user", text: "identical", inputId: "other", ts: "now" } as Message]);
  expect(page.sent).toHaveLength(1);
  ui.receive.get("a")!([{ from: "user", text: "identical", inputId: "a-exact", ts: "now" } as Message]);
  expect(page.sent).toEqual([]); expect((await allQuestions("a"))[0]!.id).toBe(q!.id);
  expect((await allQuestions("a"))[0]!.status).toBe("open"); expect(ui.calls().turns).toBe(0);
});

test("project switching isolates drafts and ignores late reads from another project or an older opening", async () => {
  const requests: { project: string; read: ReturnType<typeof deferred<TaskRow[]>> }[] = [];
  const ui = await setup({ tasks: project => { const read = deferred<TaskRow[]>(); requests.push({ project, read }); return read.promise; } }), { app } = ui;
  const a = app.page!, draftA = { text: "A multiline\ndraft", cursor: 5 }, draftB = { text: "B draft", cursor: 2 };
  app.input = { ...draftA }; await ui.command(); await until(() => requests.length === 1);
  await app.openPage("b"); expect(app.frame().inbox).toBeNull(); expect(app.input.text).toBe("");
  app.input = { ...draftB }; await ui.command(); await until(() => requests.length === 2);
  requests[1]!.read.resolve([row("B task")]); await until(() => text(app).includes("B task"));
  requests[0]!.read.resolve([row("A stale task")]); await Bun.sleep(0);
  expect(text(app)).not.toContain("A stale"); expect(app.input).toEqual(draftB);
  await app.onKey({ name: "z", ctrl: true }); expect(app.page).toBe(a); expect(app.input).toEqual(draftA); expect(app.frame().inbox).toBeNull();
  await ui.command(); await until(() => requests.length === 3);
  await app.onKey({ name: "escape" }); await ui.command(); await until(() => requests.length === 4);
  requests[3]!.read.resolve([row("A current")]); await until(() => text(app).includes("A current"));
  requests[2]!.read.reject(new Error("old read failure")); await Bun.sleep(0);
  expect(text(app)).toContain("A current"); expect(text(app)).not.toContain("old read failure");
});

test("closed/deleted/reopened projects cannot receive old reads, even with the same project id", async () => {
  const old = deferred<TaskRow[]>(); let reads = 0;
  const ui = await setup({ tasks: async () => ++reads === 1 ? old.promise : [row("fresh incarnation")] }), { app } = ui;
  await ui.command(); await until(() => reads === 1);
  await app.onKey({ name: "b", ctrl: true });
  expect(app.frame().inbox).toBeNull();
  await app.onKey({ name: "char", text: "d" }); await app.onKey({ name: "char", text: "y" });
  expect(existsSync(paths.project("a"))).toBe(false); expect(app.pages).toHaveLength(0);
  await app.onKey({ name: "escape" }); await app.openPage("a"); await ui.command();
  await until(() => text(app).includes("fresh incarnation"));
  old.resolve([row("deleted stale")]); await Bun.sleep(0);
  expect(text(app)).not.toContain("deleted stale"); expect(app.input.text).toBe("");
  app.closePage(); expect(app.frame().inbox).toBeNull();
});

test("late refresh success/failure after closing or switching cannot repopulate a newer panel", async () => {
  const oldRefresh = deferred<TaskRow[]>(), switchedRefresh = deferred<TaskRow[]>();
  let aReads = 0;
  const ui = await setup({ tasks: async project => {
    if (project !== "a") return [row("B only")];
    aReads++;
    if (aReads === 2) return oldRefresh.promise;
    if (aReads === 4) return switchedRefresh.promise;
    return [row("A current")];
  } }), { app } = ui;
  await ui.command(); await until(() => text(app).includes("A current"));
  await app.onKey({ name: "char", text: "r" }); await until(() => aReads === 2);
  await app.onKey({ name: "escape" }); await ui.command();
  await until(() => aReads === 3 && app.frame().inbox?.state === "ready");
  oldRefresh.resolve([row("obsolete refresh")]); await Bun.sleep(0);
  expect(text(app)).toContain("A current"); expect(text(app)).not.toContain("obsolete");
  await app.onKey({ name: "char", text: "r" }); await until(() => aReads === 4);
  await app.openPage("b"); await ui.command(); await until(() => text(app).includes("B only"));
  switchedRefresh.reject(new Error("A refresh failed")); await Bun.sleep(0);
  expect(text(app)).toContain("B only"); expect(text(app)).not.toContain("A refresh failed");
  expect(app.frame().inbox?.state).toBe("ready");
});

test("query errors are visible even scrolled, refresh is single-flight, and retries recover without writes", async () => {
  const reads: ReturnType<typeof deferred<TaskRow[]>>[] = [];
  const ui = await setup({ tasks: () => { const read = deferred<TaskRow[]>(); reads.push(read); return read.promise; } }), { app } = ui;
  await ui.command(); await until(() => reads.length === 1);
  expect(text(app)).toContain("loading");
  ui.poll(); await app.onKey({ name: "char", text: "r" }); await Bun.sleep(0); expect(reads).toHaveLength(1);
  reads[0]!.reject(new Error("corrupt registry")); await until(() => text(app).includes("corrupt registry"));
  expect(text(app)).not.toContain("No active registered tasks");
  await app.onKey({ name: "char", text: "r" }); await until(() => reads.length === 2);
  reads[1]!.resolve(Array.from({ length: 30 }, (_, i) => row(`retained ${i}`)));
  await until(() => app.frame().inbox?.state === "ready");
  await app.onKey({ name: "end" });
  await app.onKey({ name: "char", text: "r" }); await until(() => reads.length === 3);
  reads[2]!.reject(new Error("permission denied")); await until(() => app.frame().inbox?.state === "error");
  expect(plain(taskInboxPanel(app.frame()).rows)).toContain("inbox · [tasks] / questions · error");
  expect(text(app)).toContain("may be stale"); expect(text(app)).toContain("retained 29");
  await app.onKey({ name: "char", text: "r" }); await until(() => reads.length === 4);
  reads[3]!.resolve([]); await until(() => app.frame().inbox?.state === "ready");
  expect(text(app)).toContain("no active registered tasks"); expect(text(app)).not.toContain("retained");
  expect(existsSync(join(paths.project("a"), "tasks.json"))).toBe(false);
});

test("existing watcher refresh removes only explicitly associated confirmed merges; archive/history intact, exit is not readiness", async () => {
  let merged = false, observations = 0;
  const ui = await setup({ merges: async project => { observations++; if (merged) await archiveMergedTasks(project, pr, "2026-01-02T00:00:00Z"); } }), { app } = ui;
  const task = await registerTask("a", { name: "Explicit PR task", summary: "Registered", branch: "feat/one", authorized: true });
  const other = await registerTask("a", { name: "Unassociated task", summary: "Same branch is not an association", branch: "feat/one", authorized: true });
  await prepareTaskRun("a", task.id, task.branch, { id: "run-one", agent: "worker-one", role: "worker" });
  await startTaskRun("a", "run-one"); await stopTaskRun("a", "run-one", "waiting", "Worker exited normally; needs review");
  await observeTaskPR("a", task.id, { pr, branch: task.branch, state: "OPEN", ready: false, checks: "unknown" });
  const before = await Bun.file(join(paths.project("a"), "tasks.json")).text();
  await ui.command(); await until(() => text(app).includes("Explicit PR"));
  expect(text(app)).not.toContain("working"); expect(text(app)).toContain("waiting"); expect(text(app)).not.toContain("ready to merge");
  await app.onKey({ name: "char", text: "r" }); await until(() => app.frame().inbox?.state === "ready");
  expect(await Bun.file(join(paths.project("a"), "tasks.json")).text()).toBe(before);
  merged = true; ui.poll();
  await until(() => observations > 0 && !text(app).includes("Explicit PR") && text(app).includes("Unassociated"));
  expect((await listTasks("a")).map(t => t.id)).toEqual([other.id]);
  const archived = await getTask("a", task.id);
  expect(archived.archive?.reason).toBe("merged"); expect(archived.runs).toHaveLength(1); expect(archived.history.at(-1)!.kind).toBe("merged");
  expect(ui.calls().turns).toBe(0);
});

test("menu/help replacement and tiny hidden inbox keep drafts; exit transcript never includes the task panel", async () => {
  const ui = await setup({ tasks: async () => [row("not conversation")] }), { app } = ui;
  const draft = { text: "keep me", cursor: 2 }; app.input = { ...draft }; app.say("conversation only");
  await ui.command(); await until(() => app.frame().inbox?.state === "ready");
  await app.commands.get("/help")!.run("", app.page); expect(app.frame().inbox).toBeNull();
  await app.onKey({ name: "escape" }); await ui.command();
  app.openMenu("menu", [{ value: 1, label: "one" }], () => {}); expect(app.frame().inbox).toBeNull();
  await app.onKey({ name: "escape" }); await ui.command();
  ui.resize(1, 1); await Bun.sleep(150);
  for (const key of [{ name: "enter" }, { name: "paste", text: "do not submit" }, { name: "down" }]) await app.onKey(key);
  expect(app.input).toEqual(draft); expect(ui.sent).toEqual([]);
  await app.onKey({ name: "escape" }); expect(app.frame().inbox).toBeNull(); expect(app.input).toEqual(draft);
  ui.resize(100, 28); await Bun.sleep(150); await ui.command(); await until(() => app.frame().inbox?.state === "ready");
  app.quit(); await ui.running;
  expect(ui.exit()).toContain("conversation only"); expect(ui.exit()).not.toContain("not conversation");
});

const sectionKey = { name: "tab", shift: true };
const syntheticQuestion = (id = "q"): Question => ({ id, text: `Question ${id}?`, status: "open", ts: "2026-01-01T00:00:00Z" });
const fakeQuestions = (changes: Partial<QuestionStore> = {}): QuestionStore => ({
  stamp: async () => NaN, all: async () => [], list: async () => [],
  answer: async () => { throw new Error("unexpected answer"); }, skip: async () => { throw new Error("unexpected skip"); }, ...changes,
});

test("USER inbox badge counts only unanswered questions: unknown, zero, multiple, background and narrow widths", async () => {
  const gate = deferred<Question[]>();
  let known = false;
  const ui = await setup({ tasks: async () => Array.from({ length: 15 }, (_, i) => row(`task ${i}`)),
    questions: fakeQuestions({ list: async project => project === "b" ? [syntheticQuestion("b1"), syntheticQuestion("b2")] : known ? [] : gate.promise }),
  }), { app } = ui;
  const a = app.page!;
  a.agentCount = 9; a.sent.push({ inputId: "unconsumed", text: "queued" });
  expect(app.status(a)).toBe("9 agents running │ 1 message queued │ inbox ?");
  await ui.command(); await until(() => app.frame().inbox?.state === "ready");
  expect(app.status(a)).toEndWith("inbox ?");
  known = true; gate.resolve([]); await a.questions.polling;
  expect(app.status(a)).toEndWith("inbox 0");
  await app.openPage("b"); await app.page!.questions.polling;
  expect(app.status(app.page!)).toEndWith("inbox 2");
  app.switchPage(-1);
  expect(app.status(a)).toEndWith("inbox 0 (+2 elsewhere)");
  expect(plain(statusRows(app.status(a), 12, 24))).toContain("inbox 0 +2");
  for (const width of [1, 2, 5, 8, 12, 20, 40, 80]) {
    const rows = statusRows(app.status(a), width, 24);
    expect(rows.every(line => visibleLength(line) <= width)).toBe(true);
    expect(plain(rows)).not.toMatch(/\bquestions?\b/);
  }
  const b = app.pages[1]!; b.questions.error = "offline";
  expect(app.status(a)).toEndWith("inbox 0 (+? elsewhere)");
  await app.openPage("c"); await app.page!.questions.polling;
  const c = app.page!; c.questions.loaded = false; b.questions.error = undefined;
  await app.openPage("a");
  expect(app.status(a)).toEndWith("inbox 0 (+2+? elsewhere)");
  expect(plain(statusRows(app.status(a), 13, 24))).toContain("inbox 0 +2+?");
  expect(a.sent).toHaveLength(1); expect(ui.calls().turns).toBe(0);
});

test("shift+tab safely navigates Tasks / Questions; ctrl+q and /questions share the section and retain both cursors", async () => {
  const ui = await setup({ tasks: async () => [row()] }), { app } = ui, a = app.page!;
  const chat = { text: "chat line\nsecond 界", cursor: 7 }, answer = { text: "unfinished\nanswer 界", cursor: 3 };
  app.input = { ...chat }; app.draw();
  await ask("a", [{ text: "Decision?" }]); app.questions.poll([a]); await a.questions.polling;
  expect(app.frame().inbox).toBeNull();
  await ui.command(); expect(app.frame().inbox?.section).toBe("tasks");
  await app.onKey(sectionKey); expect(app.frame().inbox?.section).toBe("questions");
  app.input = { ...answer }; app.draw();
  await app.onKey(sectionKey); expect(app.input).toEqual(chat);
  expect(a.questions.answer).toEqual(answer);
  await app.onKey({ name: "q", ctrl: true }); expect(app.input).toEqual(answer);
  await app.onKey({ name: "escape" }); expect(app.input).toEqual(chat);
  await app.commands.get("/questions")!.run("", a); expect(app.input).toEqual(answer);
  await app.openPage("b");
  const bChat = { text: "independent B", cursor: 4 }; app.input = { ...bChat }; app.draw();
  app.switchPage(-1); expect(app.input).toEqual(chat); expect(app.frame().inbox).toBeNull();
  await app.commands.get("/questions")!.run("", a); expect(app.input).toEqual(answer);
  await app.onKey({ name: "tab" }); expect(app.input).toEqual(chat);
  app.switchPage(1); expect(app.input).toEqual(bChat);
  expect((await allQuestions("a"))[0]!.status).toBe("open");
  expect(ui.sent).toEqual([]); expect(ui.calls().turns).toBe(0);
});

test("opening/new-head guard survives section changes; explicit answers deliver but skips silently dismiss", async () => {
  let now = 0;
  const ui = await setup({ tasks: async () => [], questionDelayMs: 500, clock: { now: () => now, every: () => () => {} } }), { app } = ui;
  const qs = await ask("a", [{ text: "First?", options: ["yes", "no"] }, { text: "Next?", options: ["go"], default: "wait" }]);
  await ui.command(); await app.onKey(sectionKey);
  for (const key of [{ name: "enter" }, { name: "char", text: "1" }, { name: "paste", text: "oops" }]) await app.onKey(key);
  expect((await allQuestions("a")).map(q => q.status)).toEqual(["open", "open"]);
  now = 501; await app.onKey(sectionKey); await app.onKey(sectionKey);
  await app.onKey({ name: "enter" }); expect((await allQuestions("a"))[0]!.status).toBe("open");
  now = 1002; await app.onKey({ name: "char", text: "2" });
  expect((await allQuestions("a"))[0]!.answer).toBe("no");
  await app.onKey({ name: "up" }); // skip selected, but next head's guard still applies
  await app.onKey({ name: "enter" }); expect((await allQuestions("a"))[1]!.status).toBe("open");
  await app.onKey({ name: "escape" }); expect((await drain("a", "orchestrator")).map(m => m.text)).toEqual([`[${qs[0]!.id}] answer to "First?": no`]);
  await app.onKey({ name: "q", ctrl: true }); now = 1503;
  await app.onKey({ name: "enter" });
  expect((await allQuestions("a"))[1]!.status).toBe("skipped");
  expect(await drain("a", "orchestrator")).toEqual([]);
  expect(app.status(app.page!)).toEndWith("inbox 0"); expect(app.frame().inbox).toBeNull();
  expect(ui.sent).toEqual([]); expect(ui.calls().turns).toBe(0);
});

test("question load/error states never fabricate zero; retry and external closure preserve chat and report the orphan answer safely", async () => {
  let fail = true, open = [syntheticQuestion()];
  const malicious = "bad\x1b]0;owned\x07\x1b[31mred\x1b[0m\u202e";
  const ui = await setup({ questions: fakeQuestions({ list: async () => { if (fail) throw new Error(malicious); return open; } }) }), { app } = ui;
  const chat = { text: "keep chat", cursor: 2 }; app.input = { ...chat }; app.draw();
  await app.commands.get("/questions")!.run("", app.page);
  expect(app.status(app.page!)).toEndWith("inbox ?");
  const panel = plain(taskInboxPanel(app.frame()).rows);
  expect(panel).toContain("questions unavailable"); expect(panel).not.toContain("No open questions");
  expect(taskInboxPanel(app.frame()).rows.join("")).not.toMatch(/\x1b\]|\x1b\[31m|\u202e/);
  await app.onKey({ name: "enter" }); expect(app.input).toEqual(chat);
  fail = false; await app.commands.get("/questions")!.run("", app.page);
  expect(app.status(app.page!)).toEndWith("inbox 1");
  app.input = { text: "orphan\x1b]0;owned\x07\u202e", cursor: 4 }; app.draw();
  fail = true; app.questions.poll(app.pages); await app.page!.questions.polling;
  expect(app.status(app.page!)).toEndWith("inbox ?");
  expect(plain(taskInboxPanel(app.frame()).rows)).toContain("snapshot may be stale");
  fail = false; open = []; app.questions.poll(app.pages); await app.page!.questions.polling;
  expect(app.input).toEqual(chat); expect(app.frame().inbox).toBeNull();
  expect(JSON.stringify(app.page!.lines)).toContain("unsent answer: orphan");
  expect(JSON.stringify(app.page!.lines)).not.toContain("owned");
  expect(app.status(app.page!)).toEndWith("inbox 0");
});

test("in-flight answer stays single-flight across polls/sections; errors retain the answer and never consume queued prompts", async () => {
  const gate = deferred<void>(); let attempts = 0;
  const ui = await setup({ tasks: async () => [], questions: { ...fileStore, answer: async () => { attempts++; await gate.promise; } } }), { app } = ui;
  await ask("a", [{ text: "Pending?" }]);
  const chat = { text: "chat", cursor: 1 }, answer = { text: "typed answer", cursor: 6 };
  app.input = { ...chat }; await app.commands.get("/questions")!.run("", app.page);
  app.input = { ...answer }; app.draw(); app.page!.sent.push({ inputId: "exact", text: "pending prompt" });
  const closing = app.onKey({ name: "enter" });
  expect(plain(taskInboxPanel(app.frame()).rows)).toContain("sending answer");
  await app.onKey({ name: "enter" }); await app.onKey({ name: "char", text: "not inserted" });
  expect(attempts).toBe(1); expect(app.input).toEqual(answer);
  await app.onKey(sectionKey); expect(app.input).toEqual(chat);
  app.questions.poll(app.pages); await app.page!.questions.polling;
  gate.reject(new Error("write failed\x1b[2J\u202e")); await closing;
  expect(app.frame().inbox?.section).toBe("tasks"); expect(app.input).toEqual(chat);
  await app.onKey(sectionKey); expect(app.input).toEqual(answer);
  expect(app.page!.sent).toHaveLength(1); expect(app.page!.questions.closing).toBe(false);
  expect(JSON.stringify(app.page!.lines)).toContain("could not answer: write failed");
  expect((await allQuestions("a"))[0]!.status).toBe("open");
});

for (const transition of ["close", "section", "project", "recreate"] as const) {
  test(`late question command loads cannot reopen or steal input after ${transition}`, async () => {
    const gate = deferred<Question[]>(); let delayed = true;
    const ui = await setup({ tasks: async () => [], questions: fakeQuestions({ list: async () => delayed ? gate.promise : [] }) }), { app } = ui;
    const a = app.page!, chat = { text: "saved A", cursor: 3 }; app.input = { ...chat }; app.draw();
    const opening = app.commands.get("/questions")!.run("", a);
    expect(app.frame().inbox?.section).toBe("questions");
    if (transition === "close") await app.onKey({ name: "escape" });
    if (transition === "section") await app.onKey(sectionKey);
    if (transition === "project") await app.openPage("b");
    if (transition === "recreate") { app.closePage(); delayed = false; rmSync(paths.project("a"), { recursive: true }); await app.openPage("a"); }
    const current = app.page!, draft = { ...app.input };
    delayed = false; gate.resolve([syntheticQuestion("old")]); await opening; await current.questions.polling;
    expect(app.page).toBe(current); expect(app.input).toEqual(draft);
    expect(app.frame().inbox?.section ?? null).toBe(transition === "section" ? "tasks" : null);
    if (transition === "recreate") expect(current.questions.seen.has("old")).toBe(false);
    expect(ui.sent).toEqual([]); expect(ui.calls().turns).toBe(0);
  });
}

for (const transition of ["project", "recreate"] as const) {
  test(`a late question answer remains owned by its captured page after ${transition}`, async () => {
    const gate = deferred<void>(); let open = [syntheticQuestion()];
    const ui = await setup({ questions: fakeQuestions({ list: async () => open, answer: async () => { await gate.promise; } }) }), { app } = ui;
    const a = app.page!; await app.commands.get("/questions")!.run("", a);
    app.input = { text: "answer A", cursor: 2 }; app.draw();
    const answering = app.onKey({ name: "enter" }); open = [];
    if (transition === "project") await app.openPage("b");
    else { app.closePage(); rmSync(paths.project("a"), { recursive: true }); await app.openPage("a"); }
    const next = app.page!, draft = { text: "new page draft", cursor: 5 }; app.input = { ...draft }; app.draw();
    gate.resolve(); await answering;
    expect(app.input).toEqual(draft); expect(next.lines).toEqual([]); expect(app.frame().inbox).toBeNull();
    expect(a.questions.mine.has("q")).toBe(transition === "project");
    expect(a.lines.length > 0).toBe(transition === "project");
  });
}

test("Questions panel sanitizes fields and stays bounded at narrow/tiny sizes; Escape always recovers drafts", async () => {
  const evil = "\x1b]8;;https://evil.invalid\x1b\\LINK\x1b]8;;\x1b\\\x1b[2J\x1b[31mRED\x1b[0m\u202e\x07";
  const ui = await setup({ questions: fakeQuestions({ list: async () => [{ ...syntheticQuestion(), text: evil.repeat(20), options: [evil], default: evil }] }) }), { app } = ui;
  const chat = { text: "draft 界", cursor: 3 }; app.input = { ...chat }; app.draw();
  for (const [cols, rows] of [[100, 28], [40, 24], [20, 12], [12, 8], [4, 4], [1, 1]]) {
    ui.term.cols = cols!; ui.term.rows = rows!;
    await app.commands.get("/questions")!.run("", app.page);
    const f = app.frame(), screen = stickyRows(f, [], chrome(f));
    expect(screen.rows).toHaveLength(rows!);
    expect(screen.rows.every(line => visibleLength(line) <= cols!)).toBe(true);
    expect(screen.rows.join("")).not.toMatch(/\x1b\]|\x1b\[2J|\x1b\[31m|\u202e|\x07/);
    await app.onKey({ name: "escape" }); expect(app.input).toEqual(chat); expect(app.frame().inbox).toBeNull();
  }
  expect(ui.sent).toEqual([]);
});

test("inbox Questions coexists with help, projects, model menus and cancel-default /clear without losing either draft", async () => {
  const ui = await setup({ tasks: async () => [] }), { app } = ui;
  const page = app.page!, chat = { text: "chat draft", cursor: 2 }, answer = { text: "answer draft", cursor: 4 };
  let clears = 0; page.orch.checkClear = async () => {}; page.orch.clear = async () => { clears++; };
  app.input = { ...chat }; await ask("a", [{ text: "Keep?" }]); await app.commands.get("/questions")!.run("", page);
  app.input = { ...answer }; app.draw();
  await app.commands.get("/help")!.run("", page);
  await app.onKey({ name: "enter" }); expect((await allQuestions("a"))[0]!.status).toBe("open");
  await app.onKey({ name: "q", ctrl: true }); // help -> Questions, not closed
  expect(app.frame().help).toBeNull(); expect(app.input).toEqual(answer);
  await app.onKey({ name: "b", ctrl: true }); await app.onKey({ name: "q", ctrl: true });
  expect(app.projectList).not.toBeNull(); await app.onKey({ name: "escape" }); expect(app.input).toEqual(answer);
  app.openMenu("models", [{ value: "fake", label: "fake" }], () => {});
  await app.onKey({ name: "q", ctrl: true }); expect(app.menu).not.toBeNull();
  await app.onKey({ name: "escape" }); expect(app.input).toEqual(answer);
  await app.commands.get("/clear")!.run("", page); expect(app.menu?.index).toBe(0);
  await app.onKey({ name: "enter" }); expect(clears).toBe(0); expect(app.input).toEqual(answer);
  await app.onKey(sectionKey); expect(app.input).toEqual(chat);
  await app.onKey({ name: "tab" }); expect(app.frame().inbox).toBeNull();
  expect(ui.sent).toEqual([]); expect((await allQuestions("a"))[0]!.status).toBe("open");
});

test("/agents stays a separate menu; stale agent-list loads cannot attach a different or recreated page", async () => {
  let pending = false;
  const gate = deferred<{ name: string; live: boolean }[]>();
  const ui = await setup({ agents: async () => pending ? gate.promise : [{ name: "worker-a", live: false }], tasks: async () => [] }), { app } = ui;
  await app.commands.get("/agents")!.run("", app.page);
  expect(app.menu?.title).toContain("attach to an agent"); expect(app.frame().inbox).toBeNull();
  await app.onKey({ name: "escape" });
  await ui.command(); expect(plain(taskInboxPanel(app.frame()).rows)).not.toContain("worker-a");
  await app.onKey({ name: "escape" }); pending = true;
  const listing = app.commands.get("/agents")!.run("", app.page);
  app.closePage(); await app.openPage("a");
  gate.resolve([{ name: "worker-old", live: false }]); await listing;
  expect(app.menu).toBeNull(); expect(app.page!.view).toBeNull(); expect(app.frame().inbox).toBeNull();
});

for (const outcome of ["answer", "error", "external"] as const) {
  test(`late question ${outcome} stays in its project history, never the selected agent transcript`, async () => {
    const gate = deferred<void>(); let open = [syntheticQuestion()];
    const ui = await setup({ questions: fakeQuestions({ list: async () => open, answer: async () => { await gate.promise; } }) }), { app } = ui;
    const page = app.page!, chat = { text: "project draft", cursor: 4 }, answer = { text: "answer draft", cursor: 3 };
    app.input = { ...chat }; app.draw();
    await app.commands.get("/questions")!.run("", page); app.input = { ...answer }; app.draw();
    const closing = outcome === "external" ? undefined : app.onKey({ name: "enter" });
    // Attaching to a transcript is independent of an outstanding question write/read.
    page.view = { name: "worker-a", lines: [], leave() {}, live: false, calls: new Calls() }; app.draw();
    expect(app.input).toEqual(chat); expect(app.questions.view()).toBeNull();
    if (outcome === "external") {
      open = []; app.questions.poll([page]); await page.questions.polling;
    } else {
      if (outcome === "error") gate.reject(new Error("answer write failed"));
      else gate.resolve();
      await closing;
    }
    expect(page.view.lines).toEqual([]); expect(app.input).toEqual(chat);
    expect(JSON.stringify(page.lines)).toContain(outcome === "answer" ? "answer draft" : outcome === "error" ? "answer write failed" : "unsent answer: answer draft");
    expect(ui.sent).toEqual([]); expect(ui.calls().turns).toBe(0);
  });
}

test("even an empty or control-only question read error remains unknown, not inbox 0", async () => {
  let fail = false;
  const { app } = await setup({ questions: fakeQuestions({ list: async () => { if (fail) throw new Error("\x1b[2J"); return []; } }) });
  await app.commands.get("/questions")!.run("", app.page);
  expect(app.status(app.page!)).toEndWith("inbox 0");
  fail = true; app.questions.poll(app.pages); await app.page!.questions.polling;
  expect(app.status(app.page!)).toEndWith("inbox ?");
  expect(plain(taskInboxPanel(app.frame()).rows)).toContain("could not read questions");
});

test("compact Tasks hints retain refresh/navigation and short Questions panels expose read errors", () => {
  for (const cols of [40, 64, 70, 80, 100]) {
    const panel = plain(taskInboxPanel(frame(cols)).rows);
    expect(panel).toContain("shift+tab"); expect(panel).toContain("r refresh"); expect(panel).toContain("esc");
  }
  const f = frame(40); f.rows = 12; f.queued = undefined; f.input.text = "";
  f.inbox = { section: "questions", state: "error", top: 0, lines: [], notice: "Last snapshot may be stale.",
    question: { text: "Q?", options: ["yes"], index: 0, count: 1, mode: "pick" } };
  expect(plain(taskInboxPanel(f).rows)).toContain("questions · error");
});


test("silent skip failure/retry is single-flight, keeps drafts/counts, and rejects stale resurrection", async () => {
  const gate = deferred<void>(); let attempts = 0, stale: Question[] | undefined;
  const ui = await setup({ tasks: async () => [], questions: { ...fileStore,
    list: async project => stale ?? fileStore.list(project),
    skip: async (project, id) => { attempts++; if (attempts === 1) await gate.promise; return fileStore.skip(project, id); },
  } }), { app } = ui;
  const qs = await ask("a", [{ text: "Remove?", default: "dangerous suggestion" }, { text: "Remaining?" }, { text: "Last?" }]);
  const chat = { text: "original chat", cursor: 3 }, answer = { text: "unsent custom", cursor: 5 };
  app.input = { ...chat }; await app.commands.get("/questions")!.run("", app.page);
  app.input = { ...answer }; app.draw(); await app.onKey({ name: "down" });
  app.page!.sent.push({ inputId: "untouched", text: "queued before skip" });
  const closing = app.onKey({ name: "enter" });
  expect(plain(taskInboxPanel(app.frame()).rows)).toContain("removing from inbox");
  expect(plain(taskInboxPanel(app.frame()).rows)).not.toContain("Sending");
  await app.onKey({ name: "enter" }); await app.onKey({ name: "char", text: "1" });
  expect(attempts).toBe(1);
  // A read during persistence must not treat our close as external or lose its draft.
  stale = qs.slice(1); app.questions.poll(app.pages); await app.page!.questions.polling;
  expect(app.page!.questions.open.map(q => q.id)).toEqual(qs.map(q => q.id));
  await app.onKey(sectionKey); expect(app.input).toEqual(chat);
  gate.reject(new Error("persistence failed")); await closing;
  expect(app.frame().inbox?.section).toBe("tasks");
  expect(app.page!.questions.answer).toEqual(answer);
  expect(app.status(app.page!)).toEndWith("inbox 3");
  expect(JSON.stringify(app.page!.lines)).toContain("could not skip: persistence failed");
  expect(await allQuestions("a")).toEqual(qs);
  stale = undefined;
  await app.onKey(sectionKey); await app.onKey({ name: "enter" });
  expect(attempts).toBe(2);
  expect(app.page!.questions.open.map(q => q.id)).toEqual(qs.slice(1).map(q => q.id));
  expect(app.page!.questions.answer.text).toBe(""); // never reassigned to next head
  expect(app.input.text).toBe("");
  expect(app.status(app.page!)).toEndWith("inbox 2");
  expect(await pendingInput("a", "orchestrator")).toBe(false);
  expect(await drain("a", "orchestrator")).toEqual([]);
  expect(app.page!.sent).toEqual([{ inputId: "untouched", text: "queued before skip" }]);
  expect(JSON.stringify(app.page!.lines)).not.toContain("dangerous suggestion");
  await app.onKey({ name: "escape" }); expect(app.input).toEqual(chat);
  stale = qs; app.questions.poll(app.pages); await app.page!.questions.polling;
  expect(app.frame().inbox).toBeNull(); expect(app.input).toEqual(chat);
  await app.commands.get("/questions")!.run("", app.page);
  expect(app.page!.questions.open.map(q => q.id)).toEqual(qs.slice(1).map(q => q.id));
  expect(app.input.text).toBe("");
  expect(ui.calls().turns).toBe(0); expect(ui.sent).toEqual([]);
});

for (const transition of ["close", "section", "project", "recreate"] as const) {
  test(`late silent skip completion cannot reopen/change input after ${transition}`, async () => {
    const gate = deferred<void>();
    const ui = await setup({ tasks: async () => [], questions: { ...fileStore, skip: async (project, id) => { await gate.promise; return fileStore.skip(project, id); } } }), { app } = ui;
    const qs = await ask("a", [{ text: "Dismiss?", default: "yes" }, { text: "Next?" }]);
    const page = app.page!, chat = { text: "saved chat", cursor: 4 };
    app.input = { ...chat }; await app.commands.get("/questions")!.run("", page);
    app.input = { text: "old answer", cursor: 3 }; app.draw(); await app.onKey({ name: "down" });
    const closing = app.onKey({ name: "enter" });
    if (transition === "close") await app.onKey({ name: "escape" });
    if (transition === "section") await app.onKey(sectionKey);
    if (transition === "project") { await app.openPage("b"); app.input = { text: "B", cursor: 1 }; }
    if (transition === "recreate") { app.closePage(); await app.openPage("a"); app.input = { text: "new A", cursor: 2 }; }
    const input = { ...app.input }, section = app.frame().inbox?.section;
    gate.resolve(); await closing;
    expect(app.input).toEqual(input); expect(app.frame().inbox?.section).toBe(section);
    expect((await allQuestions("a")).map(q => q.status)).toEqual(["skipped", "open"]);
    expect(await pendingInput("a", "orchestrator")).toBe(false);
    expect(ui.sent).toEqual([]); expect(ui.calls().turns).toBe(0);
    if (transition === "close" || transition === "section") {
      expect(page.questions.open.map(q => q.id)).toEqual([qs[1]!.id]);
      expect(page.questions.answer.text).toBe("");
    }
  });
}

test("external silent skip reports an orphan draft as closed, restores chat and never reassigns the answer", async () => {
  const ui = await setup(), { app } = ui;
  const qs = await ask("a", [{ text: "Closed elsewhere?", default: "yes" }, { text: "Next?" }]);
  const chat = { text: "keep chat", cursor: 3 };
  app.input = { ...chat }; await app.commands.get("/questions")!.run("", app.page);
  app.input = { text: "orphan answer", cursor: 4 }; app.draw();
  await fileStore.skip("a", qs[0]!.id);
  app.questions.poll(app.pages); await app.page!.questions.polling;
  expect(app.input).toEqual(chat); expect(app.frame().inbox).toBeNull();
  expect(JSON.stringify(app.page!.lines)).toContain("was closed elsewhere");
  expect(JSON.stringify(app.page!.lines)).toContain("unsent answer: orphan answer");
  expect(JSON.stringify(app.page!.lines)).not.toContain("default");
  expect(app.page!.questions.answer.text).toBe("");
  expect(app.status(app.page!)).toEndWith("inbox 1");
  await app.commands.get("/questions")!.run("", app.page);
  expect(app.input.text).toBe(""); expect(app.questions.view()?.text).toBe("Next?");
  expect(await drain("a", "orchestrator")).toEqual([]);
  expect(ui.calls().turns).toBe(0); expect(ui.sent).toEqual([]);
});
