import { expect, test } from "bun:test";
import { appFixture } from "../test/app-fixture";
import { App, type AppDeps } from "./app";
import { all, answer, ask } from "../core/data/inbox/questions";
import { abandonTask, allTasks, getTask, registerTask, removeTask, restoreTask, setTaskDependencies, prepareTaskRun, startTaskRun, stopTaskRun } from "../core/data/tasks/tasks";
import { workArchive } from "../core/data/projects";
import { archiveAgents, restoreAgents } from "../core/tmux/liveness";
import { paths, readProjectState } from "../config";
import { open } from "../core/data/transcripts";
import { imageFile, saveImage } from "../core/data/images";
import { png } from "../test/image-fixture";
import type { AgentInfo } from "../protocol";

const { fakeTerm, fakeOrchestrators, until } = appFixture();
async function setup(project: string, extra: Partial<AppDeps> = {}) {
  const term = fakeTerm(120, 28), fake = fakeOrchestrators();
  const app = new App({ term, pollMs: 100_000, agents: async () => [], taskCount: async () => [], questionDelayMs: 0,
    openOrchestrator: fake.openOrchestrator, ...extra });
  const running = app.run(project); await until(() => app.page?.project === project);
  return { app, term, fake, stop: async () => { app.quit(); await running; } };
}

test("abandoned tasks archive, expand in place, jump and restore without changing dependencies or execution", async () => {
  const project = "archived-tasks", { app, term, stop } = await setup(project);
  try {
    const parent = await registerTask(project, { name: "Old parent", summary: "Preserved", branch: "feat/old", authorized: true });
    const child = await registerTask(project, { name: "Active child", summary: "Depends on parent", branch: "feat/new", authorized: true });
    await setTaskDependencies(project, child.id, [parent.id]);
    await abandonTask(project, parent.id, parent.revision);
    term.type("/vim\r"); await until(() => term.screen().includes("NORMAL"));
    await app.commands.get("/tasks")!.run("", app.page);
    await until(() => term.screen().includes("Old parent"));
    term.type("d"); await until(() => term.screen().includes("Archive 1 settled"));
    term.type("y"); await until(() => term.screen().includes("Archived (1)"));
    expect(term.screen()).toContain("Active child");
    expect(term.display.screen().map(line => line.split("│")[0]).join("\n")).not.toContain("#1 Old parent");
    term.type("a"); await until(() => term.screen().includes("▾ Archived (1)"));
    expect(term.screen()).toContain("#1 Old parent"); expect(term.screen()).toContain("Active child");
    term.type("h"); await until(() => term.screen().includes("▸ Archived (1)"));
    term.type("l"); await until(() => term.screen().includes("▾ Archived (1)"));
    term.type("h"); await until(() => term.screen().includes("▸ Archived (1)"));
    term.type("1\r"); await until(() => term.screen().includes("Task #1 · waiting"));
    term.type("u"); await until(() => term.screen().includes("Restored to list"));
    expect((await getTask(project, parent.id)).removedAt).toBeUndefined();
    expect((await getTask(project, parent.id)).attention?.kind).toBe("cancelled");
    expect((await getTask(project, child.id)).dependsOn).toEqual([parent.id]);
    expect((await allTasks(project)).every(t => t.runs.length === 0)).toBe(true);
  } finally { await stop(); }
});

test("task archival rechecks live runs and preserves the original record on refusal", async () => {
  const project = "archive-running", { stop } = await setup(project);
  try {
    const t = await registerTask(project, { name: "Running", summary: "Keep work", branch: "feat/run", authorized: true });
    await prepareTaskRun(project, t.id, t.branch, { id: "run", agent: "worker-run", role: "worker" });
    await startTaskRun(project, "run");
    const before = await getTask(project, t.id);
    await expect(removeTask(project, t.id, true)).rejects.toThrow("no active runs");
    expect(await getTask(project, t.id)).toEqual(before);
    await stopTaskRun(project, "run", "cancelled", "User stopped work");
    await removeTask(project, t.id, true); await restoreTask(project, t.id);
    expect((await getTask(project, t.id)).runs[0]!.state).toBe("stopped");
  } finally { await stop(); }
});

test("closed questions expand alongside open questions; restoring only changes list membership", async () => {
  const project = "archived-questions", { app, term, fake, stop } = await setup(project);
  try {
    const [closed, pending] = await ask(project, [{ text: "Saved question" }, { text: "Still open" }]);
    await answer(project, closed!.id, "Saved answer");
    await app.commands.get("/questions")!.run("", app.page);
    await until(() => term.screen().includes("Still open") && term.screen().includes("Archived (1)"));
    expect(term.screen()).not.toContain("Saved question");
    term.type("a"); await until(() => term.screen().includes("Saved question"));
    term.press({ name: "down" }); await until(() => term.screen().includes("Answer: Saved answer"));
    term.type("u"); await until(() => term.screen().includes("Restored to list"));
    term.press({ name: "enter" }); await until(() => term.screen().includes("Closed question"));
    expect((await all(project)).find(q => q.id === closed!.id)?.status).toBe("answered");
    expect(app.page!.questions.open.map(q => q.id)).toEqual([pending!.id]);
    term.type("D"); await until(() => term.screen().includes("dismissed without an answer"));
    term.type("y"); await until(() => term.screen().includes("Archived (2)"));
    expect((await all(project)).find(q => q.id === pending!.id)?.status).toBe("skipped");
    expect(fake.said[project]).toEqual([]);
    expect(workArchive(project, "questions")[closed!.id]).toBe(true);
  } finally { await stop(); }
});

test("image archive survives reopening, preserves bytes and can be viewed and restored with Vim", async () => {
  const project = "archived-images", { app, term, stop } = await setup(project);
  term.inlineImages = true;
  try {
    const ref = await saveImage(project, png());
    const record = open(paths.transcript(project, "orchestrator"));
    await record.append({ type: "replies", messages: [{ from: "worker", text: "Old screenshot", attachments: [ref] }] });
    const path = await imageFile(project, ref), before = await Bun.file(path).bytes();
    term.type("/vim\r"); await until(() => term.screen().includes("NORMAL"));
    term.type(" p"); await until(() => term.screen().includes("Old screenshot"));
    term.type("dy"); await until(() => term.screen().includes("Archived (1)"));
    expect(app.status(app.page!)).toEndWith("0 images");
    term.press({ name: "escape" }); term.type(" p");
    await until(() => term.screen().includes("▸ Archived (1)"));
    expect(term.screen()).not.toContain("Old screenshot");
    term.type("lj"); await until(() => term.screen().includes("Old screenshot"));
    await until(() => term.raw().includes("1337;File="));
    term.type("u"); await until(() => app.status(app.page!).endsWith("1 images"));
    expect(await Bun.file(path).bytes()).toEqual(before);
    expect(workArchive("another-conversation", "images")[ref.id]).toBeUndefined();
  } finally { await stop(); }
});

test("old agents expand without hiding live agents; restore only changes the persisted view marker", async () => {
  const project = "archived-agents";
  const rows: AgentInfo[] = [{ name: "worker-live", status: "running", live: true, queuedMessages: 0 },
    { name: "worker-old", status: "exited", live: false, queuedMessages: 0, lastActiveAt: "2000-01-01" }];
  const { app, term, stop } = await setup(project, { agents: async () => rows,
    restoreAgents: (p, names) => { restoreAgents(p, names); rows[1]!.retained = true; },
  });
  try {
    await archiveAgents(project, ["worker-old", "worker-live"], async () => ["worker-live"]);
    await app.commands.get("/agents")!.run("", app.page);
    await until(() => term.screen().includes("Archived (1)"));
    term.type("a"); await until(() => term.screen().includes("worker-old"));
    expect(term.screen()).toContain("worker-live");
    term.press({ name: "down" }); term.type("u");
    await until(() => term.screen().includes("Restored to list"));
    expect(readProjectState<Record<string, unknown>>(project, "archived-agents")).toEqual({ "worker-old": null });
    expect(term.screen()).toContain("worker-old"); expect(term.screen()).not.toContain("Archived (1)");
  } finally { await stop(); }
});
